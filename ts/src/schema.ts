/** Shared annotation schema (v1.4) — single source of truth for hub + MCP. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VERSION = "2.2.0";

export const SCREENSHOT_PREFIX = "data:image/png;base64,";
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_EDIT_KEYS = new Set([
  "width",
  "height",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "color",
  "backgroundColor",
  "text",
  "href",
  "display",
  "margin",
  "padding",
  "borderRadius",
]);

export const NAME_RE = /^[A-Za-z0-9._-]+$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = Record<string, unknown>;

export interface AnnotationPayload {
  source: string;
  url: string;
  title?: string;
  viewport: { w: number; h: number };
  label?: string;
  /** Optional per-annotation Hermes session override (max 200 chars). */
  sessionId?: string;
  strokes: Array<{
    color: string;
    width: number;
    points: Array<[number, number]>;
  }>;
  elements?: Array<Record<string, JsonValue>>;
  screenshot?: string;
  screenshotFile?: string;
  [key: string]: JsonValue | undefined;
}

export interface TargetRecord {
  sessionId: string;
  label: string;
  ts: number;
  activate: boolean;
}

function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Data dir: BROWSERLINK_DATA_DIR -> HERMES_HOME/annotations -> ~/.browserlink/annotations */
export function dataDir(): string {
  const configured = process.env.BROWSERLINK_DATA_DIR;
  if (configured) return expandUser(configured);
  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) return path.join(expandUser(hermesHome), "annotations");
  return path.join(os.homedir(), ".browserlink", "annotations");
}

export function annotationsDir(): string {
  return path.join(dataDir(), "annotations");
}

export function targetPath(): string {
  return path.join(dataDir(), "target.json");
}

export function atomicWriteJson(filePath: string, payload: JsonObject): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = path.join(
    directory,
    `.target-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

export function atomicWriteBytes(filePath: string, data: Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tmp = path.join(
    directory,
    `.annotation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate annotation payload. Returns error string or null when valid. */
export function validatePayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return "payload must be a JSON object";
  }
  const obj = payload as Record<string, unknown>;

  if (typeof obj.source !== "string") {
    return "source must be a string";
  }
  if (typeof obj.url !== "string") {
    return "url must be a string";
  }

  const title = obj.title;
  if (title !== undefined && title !== null && typeof title !== "string") {
    return "title must be a string";
  }

  const viewport = obj.viewport;
  if (viewport === null || typeof viewport !== "object" || Array.isArray(viewport)) {
    return "viewport must be an object";
  }
  const vp = viewport as Record<string, unknown>;
  for (const key of ["w", "h"] as const) {
    const value = vp[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return `viewport.${key} must be a positive integer`;
    }
  }

  const strokes = obj.strokes;
  if (!Array.isArray(strokes)) {
    return "strokes must be a list";
  }
  for (let strokeIndex = 0; strokeIndex < strokes.length; strokeIndex++) {
    const stroke = strokes[strokeIndex];
    if (stroke === null || typeof stroke !== "object" || Array.isArray(stroke)) {
      return `strokes[${strokeIndex}] must be an object`;
    }
    const s = stroke as Record<string, unknown>;
    if (typeof s.color !== "string") {
      return `strokes[${strokeIndex}].color must be a string`;
    }
    const width = s.width;
    if (!isNumber(width) || width <= 0) {
      return `strokes[${strokeIndex}].width must be a positive number`;
    }
    const points = s.points;
    if (!Array.isArray(points) || points.length < 2) {
      return `strokes[${strokeIndex}].points must contain at least two points`;
    }
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = points[pointIndex];
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !isNumber(point[0]) ||
        !isNumber(point[1]) ||
        point[0] < 0 ||
        point[0] > 1 ||
        point[1] < 0 ||
        point[1] > 1
      ) {
        return `strokes[${strokeIndex}].points[${pointIndex}] must be [x,y] with values from 0 to 1`;
      }
    }
  }

  const elements = obj.elements;
  if (elements !== undefined && elements !== null) {
    if (!Array.isArray(elements)) {
      return "elements must be a list";
    }
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      const element = elements[elementIndex];
      if (element === null || typeof element !== "object" || Array.isArray(element)) {
        return `elements[${elementIndex}] must be an object`;
      }
      const el = element as Record<string, unknown>;
      const index = el.index;
      if (typeof index !== "number" || !Number.isInteger(index)) {
        return `elements[${elementIndex}].index must be an integer`;
      }
      if (Object.keys(el).length < 2) {
        return `elements[${elementIndex}] must include at least one key besides index`;
      }
      const edits = el.edits;
      if (edits !== undefined && edits !== null) {
        if (typeof edits !== "object" || Array.isArray(edits)) {
          return `elements[${elementIndex}].edits must be an object`;
        }
        for (const [key, value] of Object.entries(edits as Record<string, unknown>)) {
          if (!ALLOWED_EDIT_KEYS.has(key)) {
            return `elements[${elementIndex}].edits has unknown key '${key}'`;
          }
          if (typeof value !== "string") {
            return `elements[${elementIndex}].edits.${key} must be a string`;
          }
        }
      }
    }
  }

  const label = obj.label;
  if (label !== undefined && label !== null) {
    if (typeof label !== "string") {
      return "label must be a string";
    }
    if (label.length > 200) {
      return "label must be at most 200 characters";
    }
  }

  if ("sessionId" in obj) {
    const sessionId = obj.sessionId;
    if (typeof sessionId !== "string") {
      return "sessionId must be a string";
    }
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return "sessionId must be a non-empty string";
    }
    if (trimmed.length > 200) {
      return "sessionId must be at most 200 characters";
    }
    // Normalize to trimmed form for adapters / stored annotations.
    obj.sessionId = trimmed;
  }

  if ("screenshot" in obj) {
    const screenshot = obj.screenshot;
    if (typeof screenshot !== "string") {
      return "screenshot must be a string";
    }
    if (!screenshot.startsWith(SCREENSHOT_PREFIX)) {
      return "screenshot must be a data:image/png;base64, data URL";
    }
    const b64 = screenshot.slice(SCREENSHOT_PREFIX.length).replace(/\s+/g, "");
    // Match Python base64.b64decode(..., validate=True): reject non-alphabet chars.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      return "screenshot must be valid base64 PNG data";
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(b64, "base64");
    } catch {
      return "screenshot must be valid base64 PNG data";
    }
    if (raw.length > MAX_SCREENSHOT_BYTES) {
      return "screenshot exceeds 10MB decoded size";
    }
  }

  return null;
}

/**
 * Validate POST /target body.
 * Returns [error, mode] where mode is "set" | "clear" | null.
 */
export function validateTargetBody(
  payload: unknown,
): [string | null, "set" | "clear" | null] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return ["payload must be a JSON object", null];
  }
  const obj = payload as Record<string, unknown>;
  let sessionId = obj.sessionId ?? "";
  if (sessionId === null) {
    sessionId = "";
  }
  if (typeof sessionId !== "string") {
    return ["sessionId must be a string", null];
  }
  const activate = obj.activate;
  if (sessionId === "" && activate === false) {
    return [null, "clear"];
  }
  if (sessionId === "") {
    return ["sessionId must be a non-empty string", null];
  }
  if (sessionId.length > 200) {
    return ["sessionId must be at most 200 characters", null];
  }
  let label = obj.label ?? "";
  if (label === null) {
    label = "";
  }
  if (typeof label !== "string") {
    return ["label must be a string", null];
  }
  if (label.length > 200) {
    return ["label must be at most 200 characters", null];
  }
  if (activate !== undefined && activate !== null && typeof activate !== "boolean") {
    return ["activate must be a boolean", null];
  }
  return [null, "set"];
}

export function isSafeName(name: string): boolean {
  return (
    NAME_RE.test(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}
