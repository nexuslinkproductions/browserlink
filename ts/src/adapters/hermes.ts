/** Deliver annotations to a Hermes session when configured. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { logError } from "../schema.ts";

export type JsonObject = Record<string, unknown>;

// Annotation ids already delivered in this process. Prevents a duplicate
// POST (or a retry that actually succeeded server-side) from double-sending.
const deliveredIds = new Set<string>();

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function dataDir(): string {
  const configured = process.env.BROWSERLINK_DATA_DIR;
  if (configured) return expandUser(configured);
  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) return join(expandUser(hermesHome), "annotations");
  return join(homedir(), ".browserlink", "annotations");
}

function readTargetSessionId(): string | null {
  const path = join(dataDir(), "target.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const sessionId = (value as JsonObject).sessionId;
    if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve delivery session id.
 * Priority: annotation.sessionId > target.json > HERMES_SESSION_ID env > null.
 * Exported for unit tests.
 */
export function resolveSessionId(annotation?: JsonObject | null): string | null {
  if (annotation && typeof annotation === "object" && !Array.isArray(annotation)) {
    const annSid = annotation.sessionId;
    if (typeof annSid === "string") {
      const trimmed = annSid.trim();
      if (trimmed && trimmed.length <= 200) return trimmed;
    }
  }
  const targetSid = readTargetSessionId();
  if (targetSid) return targetSid;
  const envSid = process.env.HERMES_SESSION_ID;
  if (typeof envSid === "string" && envSid.trim()) return envSid.trim();
  return null;
}

/**
 * Read the session's own model_config from the Hermes state DB (read-only).
 *
 * Delivery must follow whatever provider/model the session actually runs on
 * (any provider, any model) instead of a hardcoded pin. The session row
 * stores its runtime as JSON in `model_config`; the API server's session-chat
 * endpoint honors explicit provider/model in the request body, so we resolve
 * them here. Falls back to `{}` on any error (older Node without node:sqlite,
 * missing DB, unreadable row) — the caller then sends no pins and the API
 * server uses its own defaults.
 */
async function sessionModelConfig(sessionId: string): Promise<JsonObject> {
  const hermesHome = process.env.HERMES_HOME;
  const dbPath = hermesHome
    ? join(expandUser(hermesHome), "state.db")
    : join(homedir(), ".hermes", "state.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT model_config FROM sessions WHERE id = ?")
        .get(sessionId) as { model_config: string | null } | undefined;
      if (!row || !row.model_config) return {};
      const value = JSON.parse(row.model_config) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonObject)
        : {};
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

function elementTagName(element: JsonObject): string {
  const tag = String(element.tag ?? "");
  const elementId = element.id;
  const className = element.className ?? element.class ?? "";
  let name = tag;
  if (elementId) name = `${name}#${String(elementId)}`;
  if (className) {
    for (const cls of String(className).split(/\s+/)) {
      if (cls) name = `${name}.${cls}`;
    }
  }
  return name;
}

function formatEdits(edits: unknown): string {
  if (!edits || typeof edits !== "object" || Array.isArray(edits)) return "";
  const bits: string[] = [];
  for (const [key, value] of Object.entries(edits as JsonObject)) {
    bits.push(`${key}=${value}`);
  }
  return bits.join(" ");
}

/** Build the Hermes chat message (exported for tests). */
export function formatMessage(
  annotation: JsonObject,
  annotationPath?: string | null,
  includeImageRef = true,
): string {
  const lines: string[] = [];

  // Schema v1.4: @image first when the sibling PNG exists on disk. Skipped
  // when the caller sends the screenshot as a real image_url part (the text
  // ref would duplicate the image).
  if (includeImageRef) {
    const screenshotFile = annotation.screenshotFile;
    if (typeof screenshotFile === "string" && screenshotFile) {
      const pngPath = annotationPath
        ? join(dirname(resolve(annotationPath)), screenshotFile)
        : join(dataDir(), "annotations", screenshotFile);
      try {
        readFileSync(pngPath);
        lines.push(`@image:${resolve(pngPath)}`);
      } catch {
        // omit when missing
      }
    }
  }

  lines.push("📎 browserlink annotation");
  lines.push(`URL: ${String(annotation.url ?? "")}`);
  lines.push(`Title: ${String(annotation.title ?? "")}`);
  lines.push(`Label: ${String(annotation.label ?? "")}`);

  const elements = annotation.elements;
  if (Array.isArray(elements)) {
    let number = 0;
    for (const element of elements) {
      if (!element || typeof element !== "object" || Array.isArray(element)) continue;
      number += 1;
      const el = element as JsonObject;
      const tagName = elementTagName(el);
      const text = String(el.text ?? "");
      let part = `E${number}: ${tagName} '${text}'`;
      if (el.instruction) part += ` - instruction: ${String(el.instruction)}`;
      const editsStr = formatEdits(el.edits);
      if (editsStr) part += ` - edits: ${editsStr}`;
      lines.push(part);
    }
  }

  const strokes = annotation.strokes;
  const strokeCount = Array.isArray(strokes) ? strokes.length : 0;
  lines.push(`${strokeCount} stroke(s)`);

  // Queued annotation notes (the extension sends both a legacy `note` and a
  // `notes` array; surface whichever is present so the note is never dropped).
  const notes = annotation.notes;
  if (Array.isArray(notes) && notes.length) {
    const list = notes
      .map((n) => String(n ?? ""))
      .filter((n) => n.trim())
      .map((n) => `- ${n.trim()}`)
      .join("\n");
    if (list) lines.push(`Notes:\n${list}`);
  } else {
    const note = String(annotation.note ?? "");
    if (note.trim()) lines.push(`Note: ${note.trim()}`);
  }

  // Always append @file last when the annotation JSON exists.
  if (annotationPath) {
    try {
      readFileSync(annotationPath);
      lines.push(`@file:${resolve(annotationPath)}`);
    } catch {
      // omit when missing
    }
  }

  return lines.join("\n");
}

// Base64 inflates 4/3; the API server caps request bodies at 10 MB. Keep a
// margin so the image part never trips the cap.
const MAX_IMAGE_PART_BYTES = 7_000_000;

function screenshotPngPath(
  annotation: JsonObject,
  annotationPath?: string | null,
): string | null {
  const screenshotFile = annotation.screenshotFile;
  if (typeof screenshotFile !== "string" || !screenshotFile) return null;
  const pngPath = annotationPath
    ? join(dirname(resolve(annotationPath)), screenshotFile)
    : join(dataDir(), "annotations", screenshotFile);
  try {
    if (readFileSync(pngPath).length > MAX_IMAGE_PART_BYTES) return null;
    return resolve(pngPath);
  } catch {
    return null;
  }
}

function imageDataUrl(pngPath: string): string | null {
  try {
    const encoded = readFileSync(pngPath).toString("base64");
    return `data:image/png;base64,${encoded}`;
  } catch {
    return null;
  }
}

export async function register(
  annotation: JsonObject,
  annotationPath?: string | null,
): Promise<void> {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!(apiUrl && apiKey)) return;

  const sessionId = resolveSessionId(annotation);
  if (!sessionId) {
    console.info(
      "Hermes adapter: no sessionId in annotation, target.json, or HERMES_SESSION_ID; skipping delivery",
    );
    return;
  }

  const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/sessions/${sessionId}/chat`;

  // Route the turn to the backend the session actually runs on. The API
  // server's session-chat route resolution only consults model_routes
  // (usually empty) before falling to the global default provider, which
  // may reject the session's model. Resolve the session's own runtime from
  // its model_config (any provider/model), with explicit env overrides
  // taking precedence for special cases.
  let provider = process.env.HERMES_PROVIDER;
  let model = process.env.HERMES_MODEL;
  if (!(provider && model)) {
    const sessionCfg = await sessionModelConfig(sessionId);
    if (!provider && typeof sessionCfg.provider === "string") {
      provider = sessionCfg.provider;
    }
    if (!model && typeof sessionCfg.model === "string") {
      model = sessionCfg.model;
    }
  }

  const bodyDict: JsonObject = { message: formatMessage(annotation, annotationPath) };
  if (provider) bodyDict.provider = provider;
  if (model) bodyDict.model = model;

  // Land the screenshot as a REAL image attachment: the API server's
  // session-chat endpoint accepts OpenAI-style content parts, and the desktop
  // renders image_url parts inline. A bare "@image:" text ref would be stored
  // as literal text (the desktop's @image rendering only applies to its own
  // input path). The JSON file cannot be an attachment on this endpoint
  // (file parts are rejected), so it stays as an @file: text ref.
  const pngPath = screenshotPngPath(annotation, annotationPath);
  const dataUrl = pngPath ? imageDataUrl(pngPath) : null;
  if (dataUrl) {
    // Send BOTH the image part and the @image: ref: the part feeds the
    // agent's vision, the ref is what the desktop lifts into a rendered
    // attachment thumbnail (it drops the [screenshot] placeholder when a
    // ref is present). Without the ref the desktop shows literal text.
    bodyDict.message = [
      { type: "image_url", image_url: { url: dataUrl } },
      { type: "text", text: formatMessage(annotation, annotationPath) },
    ];
  }

  const body = JSON.stringify(bodyDict);

  // Retry only on network/timeout failures (never on HTTP 4xx: those are
  // deterministic and retrying them would just repeat the rejection). Two
  // retries with 1s / 4s backoff. The annotation id dedupes deliveries so a
  // duplicate POST cannot double-send the same annotation.
  const annotationId =
    typeof annotation.id === "string" && annotation.id ? annotation.id : null;
  if (annotationId && deliveredIds.has(annotationId)) {
    console.info(`Hermes adapter: annotation ${annotationId} already delivered; skipping`);
    return;
  }
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300_000);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        if (annotationId) deliveredIds.add(annotationId);
        console.info(
          `Hermes adapter: delivered annotation${annotationId ? ` ${annotationId}` : ""} to session ${sessionId} (${response.status})`,
        );
        return;
      }

      // HTTP error: log it. 4xx is a hard failure (no retry); 5xx may be
      // transient so retry those with backoff.
      const detail = await response.text().catch(() => "");
      logError({
        adapter: "hermes",
        annotationId,
        sessionId,
        error: `HTTP ${response.status} from ${endpoint}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      });
      if (response.status < 500) {
        console.warn(
          `Hermes adapter: HTTP ${response.status} not retried for session ${sessionId}`,
        );
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        console.warn(
          `Hermes adapter: attempt ${attempt} failed (${message}); retrying in ${attempt}s`,
        );
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, attempt * 1000),
        );
        continue;
      }
      logError({
        adapter: "hermes",
        annotationId,
        sessionId,
        error: `network failure after ${maxAttempts} attempts: ${message}`,
      });
    }
  }
}
