/** Shared annotation schema (v1.9), single source of truth for hub + MCP. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VERSION = "2.6.0";

export const SCREENSHOT_PREFIX = "data:image/png;base64,";
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

// Keep the text part well below the API server request-body cap; the image
// part is gated separately by MAX_IMAGE_PART_BYTES in the Hermes adapter.
export const MAX_MESSAGE_TEXT_LENGTH = 20_000;

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
  // Schema v1.5: text-formatting keys emitted by the inspector text editor.
  "textAlign",
  "textTransform",
  "letterSpacing",
  "wordSpacing",
  "whiteSpace",
  "verticalAlign",
  "textDecoration",
  "fontStyle",
  "textShadow",
]);

export const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Schema v1.6: optional per-element intent and severity. Both are optional
// for full backward compatibility; when present they must be exact enum
// values (wrong types and unknown values are rejected with HTTP 400).
export const INTENT_VALUES = ["fix", "change", "question", "approve"] as const;
export const SEVERITY_VALUES = ["blocking", "important", "suggestion"] as const;
export type Intent = (typeof INTENT_VALUES)[number];
export type Severity = (typeof SEVERITY_VALUES)[number];

// Schema v1.7 (F1 deep pick): optional per-element frame and shadow metadata.
// frame.path is the same-origin iframe index chain from the top document to
// the element's document ([] = top document); frame.crossOrigin marks a
// bounded best-effort frame-level target whose inner DOM is not accessible.
// shadow.depth/hosts describe the open shadow-host boundary chain
// (hosts[0] is the outermost host). Both fields are optional and strictly
// validated: unknown nested keys, wrong types, and out-of-range values are
// rejected with HTTP 400, while legacy elements without them stay valid.
export const MAX_FRAME_DEPTH = 8;
export const MAX_SHADOW_DEPTH = 8;
export const MAX_HOSTS = 8;
export const MAX_HOST_SELECTOR = 500;
export type FrameMetadata = { path?: number[]; crossOrigin?: boolean };
export type ShadowMetadata = { depth?: number; hosts?: string[] };

// Schema v1.8 (F2 anchor resilience): optional per-element anchor metadata
// describing how a stored element was re-anchored on a changed live page.
// version is the anchor format version (1); resolution is a strict enum
// (exact = original cssPath replay, fallback = deterministic signal chain,
// unresolved = no candidate reached the confidence threshold); confidence is
// the 0..1 score of the winning path; fallback lists the deterministic
// signals used, in order (attrs, text, aria, rect). All fields are strictly
// validated: unknown nested keys, wrong types, unknown enum values, and
// out-of-range numbers are rejected with HTTP 400, while legacy elements
// without anchor stay valid.
export const ANCHOR_VERSION = 1;
export const ANCHOR_RESOLUTIONS = ["exact", "fallback", "unresolved"] as const;
export const ANCHOR_FALLBACK_SIGNALS = ["attrs", "text", "aria", "rect"] as const;
export const MAX_ANCHOR_FALLBACK_SIGNALS = 4;
export type AnchorResolution = (typeof ANCHOR_RESOLUTIONS)[number];
export type AnchorFallbackSignal = (typeof ANCHOR_FALLBACK_SIGNALS)[number];
export type AnchorMetadata = {
  version?: number;
  resolution?: AnchorResolution;
  confidence?: number;
  fallback?: AnchorFallbackSignal[];
};

// Schema v1.9 (F4): optional top-level environment snapshot captured once at
// send start. env records the browser and viewport state exactly as observed
// (ISO-8601 capturedAt, page URL, viewport size, user agent, language,
// device pixel ratio, and timezone offset in minutes). All fields are
// required whenever env is present and strictly validated: unknown keys,
// invalid timestamps, invalid bounds, and oversized strings are rejected
// with HTTP 400, while v1.8 payloads without env stay valid (backward
// compatible with every earlier schema).
export const ENV_KEYS = [
  "capturedAt",
  "url",
  "viewport",
  "userAgent",
  "language",
  "devicePixelRatio",
  "timezoneOffsetMinutes",
] as const;
export const MAX_ENV_URL = 2048;
export const MAX_ENV_UA = 512;
export const MAX_ENV_LANG = 64;
export const MAX_TIMEZONE_OFFSET_MINUTES = 840; // UTC-14 through UTC+14
export type EnvironmentSnapshot = {
  capturedAt: string;
  url: string;
  viewport: { w: number; h: number };
  userAgent: string;
  language: string;
  devicePixelRatio: number;
  timezoneOffsetMinutes: number;
};

// Schema v1.9 (F4): optional textQuote descriptor (reserved for F9 text
// selection). quote is the normalized selected page text; prefix and suffix
// carry the bounded surrounding context used for unique-contextual restore.
// Strictly validated: unknown keys, missing or oversized quote, and
// oversized context strings are rejected with HTTP 400. Accepted at the top
// level (quote-linked notes) and per element (Ask AI / Highlight markers),
// with the same shape and limits at both levels.
export const TEXT_QUOTE_KEYS = ["quote", "prefix", "suffix"] as const;
export const MAX_QUOTE_TEXT = 5000;
export const MAX_QUOTE_CONTEXT = 500;
export type TextQuote = {
  quote: string;
  prefix?: string;
  suffix?: string;
};

// Schema v1.9 (F4): optional thread identity (reserved for F8 element
// threads). threadId identifies the thread a committed element instruction
// belongs to; parentId references an existing item in the same thread. Both
// are optional non-empty strings within documented caps; absence stays valid
// (legacy annotations and root threads).
export const MAX_THREAD_ID = 100;
export const MAX_PARENT_ID = 100;

// Schema v1.6: optional top-level capture state (Freeze State Capture).
// Only these four fields are accepted; unknown keys are rejected with
// HTTP 400. animationsFrozen is required whenever captureState is present.
// Type alias (not interface): implicit index signatures keep this assignable
// to JsonValue for the AnnotationPayload string index.
export type CaptureState = {
  animationsFrozen: boolean;
  hoveredSelector: string | null;
  activeElementSelector: string | null;
  openDetailsSelectors: string[];
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = Record<string, unknown>;

export interface AnnotationPayload {
  /** Optional stable id used for adapter idempotency. */
  id?: string;
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
  captureState?: CaptureState;
  // Schema v1.9 (F4): optional environment snapshot, text quote, and thread
  // identity. All are strictly validated and optional for backward
  // compatibility; see the validation rules below.
  env?: EnvironmentSnapshot;
  textQuote?: TextQuote;
  threadId?: string;
  parentId?: string;
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

export function errorLogPath(): string {
  return path.join(dataDir(), "browserlink-error.log");
}

interface ErrorLogEntry {
  ts: string;
  adapter: string;
  annotationId: string | null;
  sessionId: string | null;
  error: string;
}

export function logError(entry: Omit<ErrorLogEntry, "ts">): void {
  const line: ErrorLogEntry = {
    ts: new Date().toISOString(),
    adapter: entry.adapter,
    annotationId: entry.annotationId || null,
    sessionId: entry.sessionId || null,
    error: entry.error,
  };
  try {
    const logPath = errorLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Last-resort: if we can't write the error log, still emit to stderr.
    console.warn("failed to write error log:", line);
  }
}

interface SuccessLogEntry {
  ts: string;
  adapter: string;
  annotationId: string | null;
  sessionId: string | null;
  messageId: string | null;
  message: string;
}

/**
 * Structured success line for confirmed deliveries. Written to the SAME log
 * file as logError (browserlink-error.log, kept for Python-hub parity) so a
 * single file traces every adapter outcome, success or failure.
 */
export function logSuccess(entry: Omit<SuccessLogEntry, "ts">): void {
  const line: SuccessLogEntry = {
    ts: new Date().toISOString(),
    adapter: entry.adapter,
    annotationId: entry.annotationId || null,
    sessionId: entry.sessionId || null,
    messageId: entry.messageId || null,
    message: entry.message,
  };
  try {
    const logPath = errorLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Last-resort: if we can't write the log, still emit to stderr.
    console.warn("failed to write success log:", line);
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a schema v1.9 textQuote object at the given error path (top level
 * "textQuote" or per-element "elements[N].textQuote"). Strict: only the
 * three known keys, quote required non-empty within MAX_QUOTE_TEXT, and
 * prefix/suffix optional strings within MAX_QUOTE_CONTEXT. Returns an error
 * string or null when valid.
 */
function validateTextQuote(value: unknown, path: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${path} must be an object`;
  }
  const q = value as Record<string, unknown>;
  for (const key of Object.keys(q)) {
    if (!(TEXT_QUOTE_KEYS as readonly string[]).includes(key)) {
      return `${path} has unknown key '${key}'`;
    }
  }
  const quote = q.quote;
  if (
    typeof quote !== "string" ||
    quote.length === 0 ||
    quote.length > MAX_QUOTE_TEXT
  ) {
    return `${path}.quote must be a non-empty string of at most ${MAX_QUOTE_TEXT} characters`;
  }
  for (const key of ["prefix", "suffix"] as const) {
    const context = q[key];
    if (context !== undefined) {
      if (typeof context !== "string" || context.length > MAX_QUOTE_CONTEXT) {
        return `${path}.${key} must be a string of at most ${MAX_QUOTE_CONTEXT} characters`;
      }
    }
  }
  return null;
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
      // Schema v1.6: optional intent and severity, strict enums. Both are
      // optional; absent fields stay valid (backward compatible). Wrong
      // types and unknown values are rejected.
      const intent = el.intent;
      if (intent !== undefined) {
        if (
          typeof intent !== "string" ||
          !(INTENT_VALUES as readonly string[]).includes(intent)
        ) {
          return `elements[${elementIndex}].intent must be one of fix, change, question, approve`;
        }
      }
      const severity = el.severity;
      if (severity !== undefined) {
        if (
          typeof severity !== "string" ||
          !(SEVERITY_VALUES as readonly string[]).includes(severity)
        ) {
          return `elements[${elementIndex}].severity must be one of blocking, important, suggestion`;
        }
      }
      // Schema v1.7: optional frame metadata (deep pick). Must be an object;
      // unknown nested keys, wrong types, negative/non-integer path entries,
      // and overlong paths are rejected. Legacy elements without frame stay
      // valid (backward compatible).
      const frame = el.frame;
      if (frame !== undefined) {
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
          return `elements[${elementIndex}].frame must be an object`;
        }
        const fo = frame as Record<string, unknown>;
        for (const key of Object.keys(fo)) {
          if (key !== "path" && key !== "crossOrigin") {
            return `elements[${elementIndex}].frame has unknown key '${key}'`;
          }
        }
        if (fo.path !== undefined) {
          if (!Array.isArray(fo.path)) {
            return `elements[${elementIndex}].frame.path must be a list`;
          }
          if (fo.path.length > MAX_FRAME_DEPTH) {
            return `elements[${elementIndex}].frame.path must have at most ${MAX_FRAME_DEPTH} entries`;
          }
          for (let i = 0; i < fo.path.length; i++) {
            const n = fo.path[i];
            if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
              return `elements[${elementIndex}].frame.path[${i}] must be a non-negative integer`;
            }
          }
        }
        if (fo.crossOrigin !== undefined && typeof fo.crossOrigin !== "boolean") {
          return `elements[${elementIndex}].frame.crossOrigin must be a boolean`;
        }
      }
      // Schema v1.7: optional shadow metadata (deep pick). Must be an object;
      // unknown nested keys, wrong types, out-of-range depth, and non-string
      // hosts are rejected. Legacy elements without shadow stay valid.
      const shadow = el.shadow;
      if (shadow !== undefined) {
        if (shadow === null || typeof shadow !== "object" || Array.isArray(shadow)) {
          return `elements[${elementIndex}].shadow must be an object`;
        }
        const so = shadow as Record<string, unknown>;
        for (const key of Object.keys(so)) {
          if (key !== "depth" && key !== "hosts") {
            return `elements[${elementIndex}].shadow has unknown key '${key}'`;
          }
        }
        if (so.depth !== undefined) {
          if (
            typeof so.depth !== "number" ||
            !Number.isInteger(so.depth) ||
            so.depth < 0 ||
            so.depth > MAX_SHADOW_DEPTH
          ) {
            return `elements[${elementIndex}].shadow.depth must be an integer from 0 to ${MAX_SHADOW_DEPTH}`;
          }
        }
        if (so.hosts !== undefined) {
          if (!Array.isArray(so.hosts)) {
            return `elements[${elementIndex}].shadow.hosts must be a list`;
          }
          if (so.hosts.length > MAX_HOSTS) {
            return `elements[${elementIndex}].shadow.hosts must have at most ${MAX_HOSTS} entries`;
          }
          for (let i = 0; i < so.hosts.length; i++) {
            if (
              typeof so.hosts[i] !== "string" ||
              so.hosts[i].length === 0 ||
              so.hosts[i].length > MAX_HOST_SELECTOR
            ) {
              return `elements[${elementIndex}].shadow.hosts[${i}] must be a non-empty string of at most ${MAX_HOST_SELECTOR} characters`;
            }
          }
        }
      }
      // Schema v1.8: optional anchor metadata (F2 anchor resilience). Must be
      // an object with only the four known keys; version and resolution are
      // required whenever anchor is present, confidence must be 0..1, and
      // fallback must be a non-empty list of strict enum signals with at
      // most MAX_ANCHOR_FALLBACK_SIGNALS entries. Unknown nested keys, wrong
      // types, unknown enum values, and out-of-range numbers are rejected.
      // Legacy elements without anchor stay valid (backward compatible).
      const anchor = el.anchor;
      if (anchor !== undefined) {
        if (anchor === null || typeof anchor !== "object" || Array.isArray(anchor)) {
          return `elements[${elementIndex}].anchor must be an object`;
        }
        const ao = anchor as Record<string, unknown>;
        for (const key of Object.keys(ao)) {
          if (
            key !== "version" &&
            key !== "resolution" &&
            key !== "confidence" &&
            key !== "fallback"
          ) {
            return `elements[${elementIndex}].anchor has unknown key '${key}'`;
          }
        }
        if (ao.version !== ANCHOR_VERSION) {
          return `elements[${elementIndex}].anchor.version must be ${ANCHOR_VERSION}`;
        }
        if (
          typeof ao.resolution !== "string" ||
          !(ANCHOR_RESOLUTIONS as readonly string[]).includes(ao.resolution)
        ) {
          return `elements[${elementIndex}].anchor.resolution must be one of exact, fallback, unresolved`;
        }
        if (ao.confidence !== undefined) {
          if (!isNumber(ao.confidence) || ao.confidence < 0 || ao.confidence > 1) {
            return `elements[${elementIndex}].anchor.confidence must be a number from 0 to 1`;
          }
        }
        if (ao.fallback !== undefined) {
          if (
            !Array.isArray(ao.fallback) ||
            ao.fallback.length === 0 ||
            ao.fallback.length > MAX_ANCHOR_FALLBACK_SIGNALS
          ) {
            return `elements[${elementIndex}].anchor.fallback must be a non-empty list of at most ${MAX_ANCHOR_FALLBACK_SIGNALS} signals`;
          }
          for (let i = 0; i < ao.fallback.length; i++) {
            if (
              typeof ao.fallback[i] !== "string" ||
              !(ANCHOR_FALLBACK_SIGNALS as readonly string[]).includes(ao.fallback[i])
            ) {
              return `elements[${elementIndex}].anchor.fallback[${i}] must be one of attrs, text, aria, rect`;
            }
          }
        }
      }
      // Schema v1.9 (F4): optional per-element textQuote (reserved for F9
      // text selection). Same shape and limits as the top-level textQuote;
      // unknown keys, missing or oversized quote, and oversized context
      // strings are rejected with HTTP 400. Legacy elements without
      // textQuote stay valid (backward compatible).
      const elQuote = el.textQuote;
      if (elQuote !== undefined) {
        const err = validateTextQuote(
          elQuote,
          `elements[${elementIndex}].textQuote`,
        );
        if (err !== null) return err;
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

  // Schema v1.6: optional top-level captureState (Freeze State Capture).
  // Backward compatible: payloads without captureState stay valid. When
  // present it must be an object with exactly the four typed fields and
  // nothing else; animationsFrozen is required, the two selectors are
  // optional string|null, openDetailsSelectors is an optional string list.
  const CAPTURE_STATE_KEYS = [
    "animationsFrozen",
    "hoveredSelector",
    "activeElementSelector",
    "openDetailsSelectors",
  ] as const;
  if ("captureState" in obj) {
    const cs = obj.captureState;
    if (cs === null || typeof cs !== "object" || Array.isArray(cs)) {
      return "captureState must be an object";
    }
    const cso = cs as Record<string, unknown>;
    for (const key of Object.keys(cso)) {
      if (!(CAPTURE_STATE_KEYS as readonly string[]).includes(key)) {
        return `captureState has unknown key '${key}'`;
      }
    }
    if (typeof cso.animationsFrozen !== "boolean") {
      return "captureState.animationsFrozen must be a boolean";
    }
    for (const key of ["hoveredSelector", "activeElementSelector"] as const) {
      const value = cso[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return `captureState.${key} must be a string or null`;
      }
    }
    const openDetails = cso.openDetailsSelectors;
    if (openDetails !== undefined && openDetails !== null) {
      if (!Array.isArray(openDetails)) {
        return "captureState.openDetailsSelectors must be a list";
      }
      for (let i = 0; i < openDetails.length; i++) {
        if (typeof openDetails[i] !== "string") {
          return `captureState.openDetailsSelectors[${i}] must be a string`;
        }
      }
    }
  }

  // Schema v1.9 (F4): optional top-level env snapshot. Strictly validated:
  // when env is present it must be an object with exactly the seven known
  // keys, every field required and typed exactly; capturedAt must be an
  // ISO-8601 timestamp, viewport positive integers, devicePixelRatio a
  // positive finite number, timezoneOffsetMinutes an integer within
  // UTC-14..UTC+14, and strings non-empty within documented caps. Unknown
  // keys, invalid timestamps, invalid bounds, and oversized strings are
  // rejected with HTTP 400. v1.8 payloads without env stay valid.
  const ISO_TIMESTAMP_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  if ("env" in obj) {
    const env = obj.env;
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      return "env must be an object";
    }
    const eo = env as Record<string, unknown>;
    for (const key of Object.keys(eo)) {
      if (!(ENV_KEYS as readonly string[]).includes(key)) {
        return `env has unknown key '${key}'`;
      }
    }
    const capturedAt = eo.capturedAt;
    if (
      typeof capturedAt !== "string" ||
      !ISO_TIMESTAMP_RE.test(capturedAt) ||
      Number.isNaN(Date.parse(capturedAt))
    ) {
      return "env.capturedAt must be an ISO-8601 timestamp";
    }
    const envUrl = eo.url;
    if (
      typeof envUrl !== "string" ||
      envUrl.length === 0 ||
      envUrl.length > MAX_ENV_URL
    ) {
      return `env.url must be a non-empty string of at most ${MAX_ENV_URL} characters`;
    }
    const envViewport = eo.viewport;
    if (
      envViewport === null ||
      typeof envViewport !== "object" ||
      Array.isArray(envViewport)
    ) {
      return "env.viewport must be an object";
    }
    const evp = envViewport as Record<string, unknown>;
    for (const key of ["w", "h"] as const) {
      const value = evp[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return `env.viewport.${key} must be a positive integer`;
      }
    }
    const userAgent = eo.userAgent;
    if (
      typeof userAgent !== "string" ||
      userAgent.length === 0 ||
      userAgent.length > MAX_ENV_UA
    ) {
      return `env.userAgent must be a non-empty string of at most ${MAX_ENV_UA} characters`;
    }
    const language = eo.language;
    if (
      typeof language !== "string" ||
      language.length === 0 ||
      language.length > MAX_ENV_LANG
    ) {
      return `env.language must be a non-empty string of at most ${MAX_ENV_LANG} characters`;
    }
    const dpr = eo.devicePixelRatio;
    if (!isNumber(dpr) || dpr <= 0) {
      return "env.devicePixelRatio must be a positive number";
    }
    const tz = eo.timezoneOffsetMinutes;
    if (
      typeof tz !== "number" ||
      !Number.isInteger(tz) ||
      tz < -MAX_TIMEZONE_OFFSET_MINUTES ||
      tz > MAX_TIMEZONE_OFFSET_MINUTES
    ) {
      return `env.timezoneOffsetMinutes must be an integer from -${MAX_TIMEZONE_OFFSET_MINUTES} to ${MAX_TIMEZONE_OFFSET_MINUTES}`;
    }
  }

  // Schema v1.9 (F4): optional top-level textQuote (reserved for F9 text
  // selection). Same shape and limits as the per-element textQuote; unknown
  // keys, missing or oversized quote, and oversized context strings are
  // rejected with HTTP 400. Absence stays valid (backward compatible).
  const topQuote = obj.textQuote;
  if (topQuote !== undefined) {
    const err = validateTextQuote(topQuote, "textQuote");
    if (err !== null) return err;
  }

  // Schema v1.9 (F4): optional thread identity, reserved for F8 element
  // threads. threadId identifies the thread a committed element instruction
  // belongs to; parentId references an existing item in the same thread.
  // Both are optional non-empty strings within documented caps; wrong
  // types, empty strings, and oversized strings are rejected with HTTP 400.
  if ("threadId" in obj) {
    const threadId = obj.threadId;
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      threadId.length > MAX_THREAD_ID
    ) {
      return `threadId must be a non-empty string of at most ${MAX_THREAD_ID} characters`;
    }
  }
  if ("parentId" in obj) {
    const parentId = obj.parentId;
    if (
      typeof parentId !== "string" ||
      parentId.length === 0 ||
      parentId.length > MAX_PARENT_ID
    ) {
      return `parentId must be a non-empty string of at most ${MAX_PARENT_ID} characters`;
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
