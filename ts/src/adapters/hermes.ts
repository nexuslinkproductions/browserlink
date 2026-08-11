/** Deliver annotations to a Hermes session when configured. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { logError, logSuccess, MAX_MESSAGE_TEXT_LENGTH } from "../schema.ts";

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
 * missing DB, unreadable row). The caller then sends no pins and the API
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
  // Content lines first; the @image:/@file: directive lines are appended
  // AFTER the MAX_MESSAGE_TEXT_LENGTH cap below, so a cap can never cut a
  // directive path line.
  const contentLines: string[] = [];

  contentLines.push("📎 browserlink annotation");
  contentLines.push(`URL: ${String(annotation.url ?? "")}`);
  contentLines.push(`Title: ${String(annotation.title ?? "")}`);
  contentLines.push(`Label: ${String(annotation.label ?? "")}`);

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
      contentLines.push(part);
    }
  }

  const strokes = annotation.strokes;
  const strokeCount = Array.isArray(strokes) ? strokes.length : 0;
  contentLines.push(`${strokeCount} stroke(s)`);

  // Queued annotation notes (the extension sends both a legacy `note` and a
  // `notes` array; surface whichever is present so the note is never dropped).
  const notes = annotation.notes;
  if (Array.isArray(notes) && notes.length) {
    const list = notes
      .map((n) => String(n ?? ""))
      .filter((n) => n.trim())
      .map((n) => `- ${n.trim()}`)
      .join("\n");
    if (list) contentLines.push(`Notes:\n${list}`);
  } else {
    const note = String(annotation.note ?? "");
    if (note.trim()) contentLines.push(`Note: ${note.trim()}`);
  }

  // Cap the body text so a single annotation can never blow the request
  // body; the directive lines are appended after this cap.
  let content = contentLines.join("\n");
  if (content.length > MAX_MESSAGE_TEXT_LENGTH) {
    content = content.slice(0, MAX_MESSAGE_TEXT_LENGTH);
    // Never leave a split surrogate pair at the cut point.
    const last = content.charCodeAt(content.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) content = content.slice(0, -1);
  }

  const lines: string[] = [];

  // Schema v1.4: @image first when the sibling PNG exists on disk. Skipped
  // when the caller sends the screenshot as a real image_url part (the text
  // ref would duplicate the image). Built after the content cap so the
  // directive line is never truncated.
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

  lines.push(content);

  // Always append @file last when the annotation JSON exists. Built after
  // the content cap so the directive line is never truncated.
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

/** One composer attachment chip: an image thumbnail or a file chip. */
export interface ComposerAttachment {
  kind: "image" | "file";
  path: string;
  label: string;
}

/**
 * Build the composer attach payload for an annotation (exported for tests).
 *
 * The image chip is included only when the screenshot PNG exists on disk;
 * the file chip is included when the annotation JSON exists. Both missing
 * returns an empty array: text-only annotations skip the attach path and
 * ship through the /chat fallback.
 */
export function buildComposerAttachments(
  annotation: JsonObject,
  annotationPath?: string | null,
): ComposerAttachment[] {
  const attachments: ComposerAttachment[] = [];

  const screenshotFile = annotation.screenshotFile;
  if (typeof screenshotFile === "string" && screenshotFile) {
    const pngPath = annotationPath
      ? join(dirname(resolve(annotationPath)), screenshotFile)
      : join(dataDir(), "annotations", screenshotFile);
    try {
      readFileSync(pngPath);
      attachments.push({
        kind: "image",
        path: resolve(pngPath),
        label: "Annotation screenshot",
      });
    } catch {
      // omit the image chip when the PNG is missing on disk
    }
  }

  if (annotationPath) {
    try {
      readFileSync(annotationPath);
      attachments.push({
        kind: "file",
        path: resolve(annotationPath),
        label: basename(resolve(annotationPath)),
      });
    } catch {
      // omit the file chip when the JSON is missing on disk
    }
  }

  return attachments;
}

// Best-effort surface: composer attach must never block or delay the /chat
// fallback, so it gets a short bounded timeout and no retries.
const COMPOSER_ATTACH_TIMEOUT_MS = 15_000;

/**
 * Deliver the annotation's screenshot + JSON to the Hermes gateway composer
 * attach endpoint so the desktop surfaces them as composer chips (image
 * thumbnail + file chip) waiting in the composer. The user then writes their
 * own notes in the composer and sends manually. Defensive by design: a
 * missing endpoint (404 while the gateway side is still being deployed), any
 * other HTTP error, or a network failure is logged and falls through to the
 * /chat fallback so an annotation is never lost.
 *
 * Returns true only when the endpoint accepted the attachments (HTTP 2xx),
 * false otherwise so the caller knows the /chat fallback must run. Never
 * throws.
 */
async function injectComposerAttachments(
  sessionId: string,
  annotationId: string | null,
  attachments: ComposerAttachment[],
): Promise<boolean> {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!(apiUrl && apiKey)) return false;
  if (attachments.length === 0) return false;

  const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/composer/attach`;
  const body = JSON.stringify({ sessionId, attachments });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPOSER_ATTACH_TIMEOUT_MS);
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
      logSuccess({
        adapter: "hermes",
        annotationId,
        sessionId,
        messageId: null,
        message: "composer-attached",
      });
      console.info(
        `Hermes adapter: composer-attached annotation${annotationId ? ` ${annotationId}` : ""} to session ${sessionId} (${attachments.length} attachment(s), HTTP ${response.status})`,
      );
      return true;
    }

    if (response.status === 404) {
      // The gateway endpoint may not be deployed yet; the /chat fallback
      // still carries the annotation, so this is informational.
      console.info(
        `Hermes adapter: composer attach endpoint not available (404) for session ${sessionId}; falling back to /chat`,
      );
      return false;
    }

    console.warn(
      `Hermes adapter: composer attach HTTP ${response.status} for session ${sessionId}; falling back to /chat`,
    );
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Hermes adapter: composer attach failed for session ${sessionId}: ${message}; falling back to /chat`,
    );
    return false;
  }
}

/**
 * Deliver the annotation as a chat message to the Hermes session. This is
 * the FALLBACK path, used only when composer attach could not deliver
 * (zero attachments, 404 from the attach endpoint, or any other attach
 * failure) so an annotation is never lost.
 */
async function deliverViaChat(
  annotation: JsonObject,
  annotationPath: string | null | undefined,
  sessionId: string,
  annotationId: string | null,
): Promise<void> {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!(apiUrl && apiKey)) {
    console.warn(
      "Hermes adapter: HERMES_API_URL/HERMES_API_KEY not set; cannot fall back to /chat",
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
        // The chat endpoint returns the completion object; lift a message id
        // when the response carries one (shape varies by server version).
        let messageId: string | null = null;
        try {
          const parsed = (await response.json()) as unknown;
          if (parsed && typeof parsed === "object") {
            const obj = parsed as JsonObject;
            const data =
              obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
                ? (obj.data as JsonObject)
                : null;
            const message =
              obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)
                ? (obj.message as JsonObject)
                : null;
            const candidate = obj.id ?? data?.id ?? message?.id;
            if (typeof candidate === "string" && candidate) messageId = candidate;
          }
        } catch {
          // body not JSON; messageId stays null
        }
        logSuccess({
          adapter: "hermes",
          annotationId,
          sessionId,
          messageId,
          message: "/chat fallback",
        });
        console.info(
          `Hermes adapter: /chat fallback delivered annotation${annotationId ? ` ${annotationId}` : ""} to session ${sessionId} (${response.status})${messageId ? ` message ${messageId}` : ""}`,
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
          `Hermes adapter: /chat fallback HTTP ${response.status} not retried for session ${sessionId}`,
        );
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        console.warn(
          `Hermes adapter: /chat fallback attempt ${attempt} failed (${message}); retrying in ${attempt}s`,
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

export async function register(
  annotation: JsonObject,
  annotationPath?: string | null,
): Promise<void> {
  const sessionId = resolveSessionId(annotation);
  if (!sessionId) {
    console.info(
      "Hermes adapter: no sessionId in annotation, target.json, or HERMES_SESSION_ID; skipping delivery",
    );
    return;
  }

  // The annotation id dedupes deliveries so a duplicate POST (or a retry
  // that actually succeeded server-side) cannot double-send the annotation.
  const annotationId =
    typeof annotation.id === "string" && annotation.id ? annotation.id : null;
  if (annotationId && deliveredIds.has(annotationId)) {
    console.info(`Hermes adapter: annotation ${annotationId} already delivered; skipping`);
    return;
  }

  // PRIMARY path: composer attach. Surface the screenshot PNG + annotation
  // JSON as composer chips (image thumbnail + file chip) waiting in the
  // desktop composer; the user writes their own notes and sends manually.
  // When the desktop accepts the attachments there is NO /chat POST, so the
  // annotation message is never auto-sent.
  const attachments = buildComposerAttachments(annotation, annotationPath);
  if (attachments.length > 0) {
    const attached = await injectComposerAttachments(
      sessionId,
      annotationId,
      attachments,
    );
    if (attached) {
      if (annotationId) deliveredIds.add(annotationId);
      return;
    }
  } else {
    console.info(
      "Hermes adapter: no composer attachments (screenshot PNG and annotation JSON missing on disk); falling back to /chat",
    );
  }

  // FALLBACK path: /chat delivery. Runs only when composer attach could not
  // deliver, so an annotation is never lost. Without HERMES_API_URL /
  // HERMES_API_KEY nothing can be sent; deliverViaChat logs the skip.
  await deliverViaChat(annotation, annotationPath, sessionId, annotationId);
}
