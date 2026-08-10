/** Deliver annotations to a Hermes session when configured. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

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

function resolveSessionId(): string | null {
  // target.json sessionId wins over HERMES_SESSION_ID env (target-over-env).
  const targetSid = readTargetSessionId();
  if (targetSid) return targetSid;
  const envSid = process.env.HERMES_SESSION_ID;
  if (typeof envSid === "string" && envSid.trim()) return envSid.trim();
  return null;
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
): string {
  const lines: string[] = [];

  // Schema v1.4: @image first when the sibling PNG exists on disk.
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

export async function register(
  annotation: JsonObject,
  annotationPath?: string | null,
): Promise<void> {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!(apiUrl && apiKey)) return;

  const sessionId = resolveSessionId();
  if (!sessionId) {
    console.info(
      "Hermes adapter: no sessionId in target.json or HERMES_SESSION_ID; skipping delivery",
    );
    return;
  }

  const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/sessions/${sessionId}/chat`;
  const body = JSON.stringify({ message: formatMessage(annotation, annotationPath) });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    try {
      await fetch(endpoint, {
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
  } catch (error) {
    console.warn("Hermes adapter failed:", error);
  }
}
