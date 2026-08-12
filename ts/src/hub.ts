/**
 * browserlink HTTP hub, TypeScript port of server/hub.py.
 * Drop-in compatible REST contract (v2.0.0).
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import {
  VERSION,
  NAME_RE,
  SCREENSHOT_PREFIX,
  dataDir,
  annotationsDir,
  targetPath,
  isSafeName,
  atomicWriteJson,
  atomicWriteBytes,
  validatePayload,
  validateTargetBody,
  MAX_SCREENSHOT_BYTES,
  type JsonObject,
} from "./schema.ts";
import * as hermes from "./adapters/hermes.ts";
import * as webhook from "./adapters/webhook.ts";
import { formatAnnotationMarkdown } from "./markdown.ts";

export {
  dataDir,
  annotationsDir,
  targetPath,
  isSafeName,
  validatePayload,
  validateTargetBody,
  siblingPngName,
  VERSION,
};
export type { JsonObject };

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

type AdapterFn = (annotation: JsonObject, annotationPath?: string) => void | Promise<void>;
type AdapterEntry = [string, AdapterFn];

export let ADAPTERS: AdapterEntry[] = [];

export function reloadAdapters(): void {
  ADAPTERS = [];
  if (process.env.HERMES_API_URL && process.env.HERMES_API_KEY) {
    ADAPTERS.push(["hermes", hermes.register]);
  }
  if (process.env.BROWSERLINK_WEBHOOK_URL) {
    ADAPTERS.push(["webhook", webhook.register]);
  }
}

export function readTarget(): JsonObject | null {
  const p = targetPath();
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const value = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as JsonObject;
  } catch {
    return null;
  }
}

export function clearTarget(): void {
  try {
    fs.unlinkSync(targetPath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

export function storeAnnotation(payload: JsonObject): string {
  const directory = annotationsDir();
  fs.mkdirSync(directory, { recursive: true });

  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const timestamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-` +
    `${pad(now.getMilliseconds(), 3)}`;

  const stored: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "screenshot") stored[key] = value;
  }

  const screenshot = payload.screenshot;
  if (typeof screenshot === "string" && screenshot.startsWith(SCREENSHOT_PREFIX)) {
    const pngName = `${timestamp}.png`;
    const pngPath = path.join(directory, pngName);
    const raw = Buffer.from(screenshot.slice(SCREENSHOT_PREFIX.length), "base64");
    atomicWriteBytes(pngPath, raw);
    stored.screenshotFile = pngName;
  }

  const jsonPath = path.join(directory, `${timestamp}.json`);
  atomicWriteJson(jsonPath, stored);

  for (const key of Object.keys(payload)) delete payload[key];
  Object.assign(payload, stored);
  // Stable id for adapter idempotency and error logs.
  (payload as Record<string, unknown>).id = path.basename(jsonPath, ".json");
  return jsonPath;
}

export function statusPayload(): JsonObject {
  const target = readTarget();
  let targetSummary: JsonObject | null = null;
  if (target !== null) {
    const sessionId = target.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      targetSummary = {
        sessionId,
        label: typeof target.label === "string" ? target.label : "",
      };
    }
  }
  return {
    ok: true,
    version: VERSION,
    dataDir: dataDir(),
    adapters: ADAPTERS.map(([name]) => name),
    target: targetSummary,
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = jsonBytes(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function sendEmpty(res: http.ServerResponse, status: number): void {
  res.writeHead(status, {
    "Content-Length": 0,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

/** Escape a value for safe inclusion in HTML text and attribute content. */
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* ---------------------------------------------------------------------------
 * F7: local full-text search.
 *
 * GET /annotations?q=<term>&url=<substring>&since=<ISO timestamp> filters the
 * corpus before the newest-first listing. Search text is the NFC-normalized,
 * case-folded concatenation of label, URL, title, notes, the legacy joined
 * note, and per-element text and instruction. A JSON record that cannot be
 * parsed as an object is skipped, never fatal, and counted in skippedCorrupt
 * so callers can diagnose a partial corpus.
 * ------------------------------------------------------------------------- */
function normalizeSearchText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").toLowerCase();
}

/** The full searchable text of one annotation (same fields as the docs). */
function annotationSearchText(annotation: JsonObject): string {
  const parts: string[] = [];
  for (const key of ["label", "url", "title"]) {
    const value = annotation[key];
    if (typeof value === "string") parts.push(value);
  }
  if (Array.isArray(annotation.notes)) {
    for (const note of annotation.notes) {
      if (typeof note === "string") parts.push(note);
    }
  }
  const legacy = annotation.note;
  if (typeof legacy === "string") parts.push(legacy);
  if (Array.isArray(annotation.elements)) {
    for (const element of annotation.elements) {
      if (element === null || typeof element !== "object" || Array.isArray(element)) {
        continue;
      }
      const record = element as JsonObject;
      for (const key of ["text", "instruction"]) {
        const value = record[key];
        if (typeof value === "string") parts.push(value);
      }
    }
  }
  return parts.join("\n").normalize("NFC").toLowerCase();
}

/** Read one stored annotation as an object, or null when unreadable. */
function tryReadAnnotation(filePath: string): JsonObject | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as JsonObject;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Deterministic ZIP writer (store method, no compression).
 *
 * Depends only on the standard library (CRC-32 table built inline), so bundle
 * and backup archives need no new dependency. Every entry carries a fixed DOS
 * timestamp (1980-01-01 00:00:00) and entries are emitted in sorted name
 * order, so identical inputs always produce byte-identical archives. Entry
 * names are validated annotation names (NAME_RE) or fixed strings such as
 * "manifest.json", so every archive path is relative and safe.
 * ------------------------------------------------------------------------- */

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

let crcTable: Uint32Array | null = null;
function crc32(data: Buffer): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { time: number; date: number } {
  // Fixed 1980-01-01 00:00:00 keeps archives byte-deterministic.
  return { time: 0, date: 0x0021 };
}

type ZipEntry = { name: string; data: Buffer };

/** Build a deterministic ZIP archive (store method). Entries are name-sorted. */
function buildZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBytes, entry.data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    centralEntry.writeUInt16LE(20, 4); // version made by
    centralEntry.writeUInt16LE(20, 6); // version needed
    centralEntry.writeUInt16LE(0x0800, 8);
    centralEntry.writeUInt16LE(0, 10); // method
    centralEntry.writeUInt16LE(time, 12);
    centralEntry.writeUInt16LE(date, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(entry.data.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt16LE(0, 30); // extra length
    centralEntry.writeUInt16LE(0, 32); // comment length
    centralEntry.writeUInt16LE(0, 34); // disk number start
    centralEntry.writeUInt16LE(0, 36); // internal attributes
    centralEntry.writeUInt32LE(0, 38); // external attributes
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(sorted.length, 8);
  eocd.writeUInt16LE(sorted.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

const BUNDLE_SCHEMA = "browserlink.annotation.bundle.v1";
const BACKUP_SCHEMA = "browserlink.corpus.backup.v1";

/** Stored annotation JSON names, newest first (same ordering as GET /annotations). */
function listAnnotationNames(): string[] {
  const directory = annotationsDir();
  const names: Array<{ name: string; mtime: number }> = [];
  try {
    if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith(".json") || !NAME_RE.test(name)) continue;
        const filePath = path.join(directory, name);
        try {
          const st = fs.statSync(filePath);
          if (st.isFile()) names.push({ name, mtime: st.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  } catch {
    // empty list
  }
  names.sort((a, b) => b.mtime - a.mtime);
  return names.map((n) => n.name);
}

/**
 * One annotation's bundle entries: JSON (byte-for-byte copy of the stored
 * file), the deterministic Markdown brief (identical bytes to /export.md),
 * and the sibling PNG when present. Missing PNG degrades to screenshot:null
 * instead of failing the export.
 */
function annotationEntries(
  name: string,
): { entries: ZipEntry[]; screenshot: string | null } {
  const directory = annotationsDir();
  const stem = name.replace(/\.json$/, "");
  const jsonPath = path.join(directory, name);
  const annotation = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as JsonObject;
  const entries: ZipEntry[] = [
    { name, data: fs.readFileSync(jsonPath) },
    {
      name: `${stem}.md`,
      data: Buffer.from(
        // No base dir: @file / @image references stay RELATIVE to the
        // bundle, so the archive is portable across machines and never
        // discloses absolute host filesystem paths.
        formatAnnotationMarkdown(annotation, name),
        "utf8",
      ),
    },
  ];
  let screenshot: string | null = null;
  const pngName = siblingPngName(name);
  try {
    const pngPath = path.join(directory, pngName);
    if (fs.existsSync(pngPath) && fs.statSync(pngPath).isFile()) {
      entries.push({ name: pngName, data: fs.readFileSync(pngPath) });
      screenshot = pngName;
    }
  } catch {
    // absent image: declared as null, never a broken reference
  }
  return { entries, screenshot };
}

function sendZip(
  res: http.ServerResponse,
  filename: string,
  body: Buffer,
): void {
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

// The share page is static HTML with no scripts, no forms, and no external
// resources; the CSP makes that a hard guarantee (only same-origin images
// and the inline style element are permitted).
const SHARE_CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The sibling PNG of an annotation JSON file (both share the timestamp stem). */
function siblingPngName(name: string): string {
  return name.replace(/\.json$/, "") + ".png";
}

/**
 * Render one stored annotation as a readable, read-only HTML share page.
 *
 * Pure function of (annotation, name, screenshotAvailable): identical inputs
 * always produce identical bytes, so repeated GETs are deterministic.
 * Every annotation-derived value (URL, title, label, notes, element text,
 * selectors, instructions, edits, chips, capture state) is HTML-escaped, so
 * stored content cannot execute script. The page contains no edit, delete,
 * reply, upload, account, or cloud controls: no forms, no buttons, no links.
 * No U+2014 em-dashes anywhere in the generated markup.
 */
function renderSharePage(
  annotation: JsonObject,
  name: string,
  screenshotAvailable: boolean,
): string {
  const esc = escapeHtml;
  const url = stringOf(annotation.url);
  const title = stringOf(annotation.title);
  const label = stringOf(annotation.label);

  // Notes: prefer the committed notes queue ('notes'), fall back to the
  // legacy joined 'note' string (same rule as the Markdown brief).
  const notes: string[] = [];
  if (Array.isArray(annotation.notes)) {
    for (const n of annotation.notes) {
      const s = stringOf(n).trim();
      if (s) notes.push(s);
    }
  }
  if (notes.length === 0) {
    const legacy = stringOf(annotation.note).trim();
    if (legacy) notes.push(legacy);
  }

  const strokes = Array.isArray(annotation.strokes) ? annotation.strokes : [];
  const elements = Array.isArray(annotation.elements)
    ? annotation.elements
    : [];

  const out: string[] = [];
  out.push("<!DOCTYPE html>");
  out.push('<html lang="en">');
  out.push("<head>");
  out.push('<meta charset="utf-8">');
  out.push(`<title>Annotation ${esc(name)} - Browserlink</title>`);
  out.push('<meta name="robots" content="noindex">');
  out.push("<style>");
  out.push(
    ":root { color-scheme: dark; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; padding: 24px 16px; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #16181e; color: #e8eaed; }",
    ".wrap { max-width: 720px; margin: 0 auto; }",
    "h1 { margin: 0 0 4px; font-size: 20px; }",
    "h2 { margin: 22px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #9aa0a6; }",
    "h3 { margin: 12px 0 6px; font-size: 14px; }",
    ".meta { margin: 0 0 12px; font-size: 12px; color: #9aa0a6; }",
    ".reach { padding: 8px 10px; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 7px; background: rgba(255, 255, 255, 0.05); font-size: 12px; color: #9aa0a6; }",
    "dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }",
    "dt { color: #9aa0a6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }",
    "dd { margin: 0; overflow-wrap: anywhere; }",
    "code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: rgba(255, 255, 255, 0.07); padding: 1px 5px; border-radius: 5px; }",
    ".element { padding: 12px; margin-top: 10px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px; background: rgba(255, 255, 255, 0.03); }",
    ".chips { margin: 0 0 8px; }",
    ".chip { display: inline-block; padding: 2px 9px; margin-right: 6px; border-radius: 999px; font-size: 11px; font-weight: 600; }",
    ".chip-intent { background: rgba(74, 158, 255, 0.18); color: #6ab0ff; }",
    ".chip-severity { background: rgba(255, 210, 90, 0.16); color: #ffd25a; }",
    "ul { margin: 4px 0; padding-left: 20px; }",
    "img { max-width: 100%; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px; }",
    ".noshot { color: #9aa0a6; font-style: italic; }",
  );
  out.push("</style>");
  out.push("</head>");
  out.push("<body>");
  out.push('<main class="wrap">');
  out.push("<header>");
  out.push("<h1>Browserlink annotation</h1>");
  out.push(`<p class="meta">Annotation file: <code>${esc(name)}</code></p>`);
  out.push(
    '<p class="reach">Served from your local browserlink hub. This page is ' +
      "readable only on this machine (or your LAN only if you deliberately " +
      "exposed the hub). It is not a public link.</p>",
  );
  out.push("</header>");

  out.push("<section>");
  out.push("<h2>Page</h2>");
  out.push("<dl>");
  out.push(`<dt>URL</dt><dd>${esc(url) || "(none)"}</dd>`);
  out.push(`<dt>Title</dt><dd>${esc(title) || "(none)"}</dd>`);
  const viewport = annotation.viewport;
  if (
    viewport !== null &&
    typeof viewport === "object" &&
    !Array.isArray(viewport)
  ) {
    const vp = viewport as JsonObject;
    const w = typeof vp.w === "number" ? String(vp.w) : "?";
    const h = typeof vp.h === "number" ? String(vp.h) : "?";
    out.push(`<dt>Viewport</dt><dd>${w}x${h}</dd>`);
  }
  out.push("</dl>");
  out.push("</section>");

  out.push("<section>");
  out.push("<h2>Label</h2>");
  out.push(`<p>${esc(label) || "(none)"}</p>`);
  out.push("</section>");

  out.push("<section>");
  out.push("<h2>Notes</h2>");
  if (notes.length > 0) {
    out.push("<ul>");
    for (const n of notes) out.push(`<li>${esc(n)}</li>`);
    out.push("</ul>");
  } else {
    out.push("<p>None.</p>");
  }
  out.push("</section>");

  out.push("<section>");
  out.push("<h2>Elements</h2>");
  if (elements.length > 0) {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el === null || typeof el !== "object" || Array.isArray(el)) continue;
      const record = el as JsonObject;
      const index = typeof record.index === "number" ? record.index : i + 1;
      out.push('<article class="element">');
      out.push(`<h3>Element ${index}</h3>`);
      const chips: string[] = [];
      if (record.intent !== undefined && record.intent !== null) {
        chips.push(
          `<span class="chip chip-intent">${esc(stringOf(record.intent))}</span>`,
        );
      }
      if (record.severity !== undefined && record.severity !== null) {
        chips.push(
          `<span class="chip chip-severity">${esc(stringOf(record.severity))}</span>`,
        );
      }
      if (chips.length > 0) out.push(`<p class="chips">${chips.join("")}</p>`);
      out.push("<dl>");
      if (record.tag !== undefined && record.tag !== null) {
        out.push(`<dt>Tag</dt><dd>${esc(stringOf(record.tag))}</dd>`);
      }
      if (record.cssPath !== undefined && record.cssPath !== null) {
        out.push(
          `<dt>Selector</dt><dd><code>${esc(stringOf(record.cssPath))}</code></dd>`,
        );
      }
      if (record.text !== undefined && record.text !== null) {
        const text = stringOf(record.text).trim();
        if (text) out.push(`<dt>Text</dt><dd>${esc(text)}</dd>`);
      }
      if (record.instruction !== undefined && record.instruction !== null) {
        out.push(
          `<dt>Instruction</dt><dd>${esc(stringOf(record.instruction))}</dd>`,
        );
      }
      const edits = record.edits;
      if (edits !== null && typeof edits === "object" && !Array.isArray(edits)) {
        const entries = Object.entries(edits as Record<string, unknown>);
        if (entries.length > 0) {
          out.push("<dt>Edits</dt><dd>");
          out.push("<ul>");
          for (const [key, value] of entries) {
            out.push(
              `<li><code>${esc(key)}</code>: ${esc(stringOf(value))}</li>`,
            );
          }
          out.push("</ul>");
          out.push("</dd>");
        }
      }
      out.push("</dl>");
      out.push("</article>");
    }
  } else {
    out.push("<p>None.</p>");
  }
  out.push("</section>");

  const captureState = annotation.captureState;
  if (
    captureState !== null &&
    typeof captureState === "object" &&
    !Array.isArray(captureState)
  ) {
    const cs = captureState as JsonObject;
    out.push("<section>");
    out.push("<h2>Capture State</h2>");
    out.push("<dl>");
    out.push(
      `<dt>Animations frozen</dt><dd>${cs.animationsFrozen === true ? "true" : "false"}</dd>`,
    );
    out.push(
      `<dt>Hovered selector</dt><dd><code>${esc(stringOf(cs.hoveredSelector ?? "null"))}</code></dd>`,
    );
    out.push(
      `<dt>Active element selector</dt><dd><code>${esc(stringOf(cs.activeElementSelector ?? "null"))}</code></dd>`,
    );
    const openDetails = Array.isArray(cs.openDetailsSelectors)
      ? (cs.openDetailsSelectors as unknown[])
      : [];
    out.push(
      `<dt>Open details selectors</dt><dd>${openDetails.length > 0 ? openDetails.map((d) => `<code>${esc(stringOf(d))}</code>`).join(", ") : "none"}</dd>`,
    );
    out.push("</dl>");
    out.push("</section>");
  }

  out.push("<section>");
  out.push("<h2>Strokes</h2>");
  out.push(`<p>Count: ${strokes.length}</p>`);
  const colors = new Set<string>();
  for (const stroke of strokes) {
    if (
      stroke !== null &&
      typeof stroke === "object" &&
      !Array.isArray(stroke)
    ) {
      const color = (stroke as JsonObject).color;
      if (typeof color === "string" && color) colors.add(color);
    }
  }
  if (colors.size > 0) {
    out.push(
      `<p>Colors: ${Array.from(colors).map((c) => `<code>${esc(c)}</code>`).join(", ")}</p>`,
    );
  }
  out.push("</section>");

  out.push("<section>");
  out.push("<h2>Screenshot</h2>");
  if (screenshotAvailable) {
    out.push(
      `<img src="/annotations/${name}/share.png" alt="Annotation screenshot for ${esc(name)}">`,
    );
  } else {
    out.push('<p class="noshot">No screenshot stored for this annotation.</p>');
  }
  out.push("</section>");

  out.push("</main>");
  out.push("</body>");
  out.push("</html>");
  return out.join("\n") + "\n";
}

function requestPathname(reqUrl: string | undefined): string {
  // Match Python urlsplit(path).path: keep raw path (including "..") without
  // URL pathname normalization that collapses "/annotations/../x".
  const raw = reqUrl ?? "/";
  const noQuery = raw.split("?", 1)[0] ?? "/";
  const noHash = noQuery.split("#", 1)[0] ?? "/";
  return noHash || "/";
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<{ payload: unknown; error: string | null; status: number | null }> {
  try {
    const lengthHeader = req.headers["content-length"];
    if (lengthHeader === undefined) {
      return { payload: null, error: "invalid JSON", status: 400 };
    }
    const length = Number.parseInt(String(lengthHeader), 10);
    if (!Number.isFinite(length) || length < 0) {
      return { payload: null, error: "invalid JSON", status: 400 };
    }
    // Oversized annotation payloads (base64 screenshots inflate ~4/3) are
    // rejected up front with 413 so a single bad send can never exhaust the
    // hub or the downstream API server request cap (10 MB there too).
    if (length > MAX_SCREENSHOT_BYTES) {
      return { payload: null, error: "payload too large", status: 413 };
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      received += buf.length;
      if (received > length) break;
    }
    const raw = Buffer.concat(chunks).subarray(0, length).toString("utf8");
    return { payload: JSON.parse(raw), error: null, status: null };
  } catch {
    return { payload: null, error: "invalid JSON", status: 400 };
  }
}

function dispatchAdapter(
  registerFn: AdapterFn,
  annotation: JsonObject,
  annotationPath: string,
): void {
  void Promise.resolve()
    .then(() => {
      try {
        return registerFn(annotation, annotationPath);
      } catch (err) {
        // Some adapters may reject a second arg, try annotation-only.
        if (err instanceof TypeError) {
          return registerFn(annotation);
        }
        throw err;
      }
    })
    .catch((err: unknown) => {
      console.warn("adapter failed:", err);
    });
}

export type HubServer = http.Server & { port: number };

export type FetchLike = typeof fetch;

export type HubSessionSummary = {
  id: string;
  title: string | null;
  preview: string | null;
  updatedAt: string | null;
};

export type ProxySessionsResult =
  | { ok: true; sessions: HubSessionSummary[] }
  | { ok: false; status: number; error: string };

/**
 * Proxy Hermes GET /api/sessions into a hub-friendly list.
 * Requires HERMES_API_URL + HERMES_API_KEY (else 503).
 * fetchImpl is injectable for unit tests.
 */
export async function proxyHermesSessions(
  fetchImpl: FetchLike = fetch,
): Promise<ProxySessionsResult> {
  const apiUrl = process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY;
  if (!(apiUrl && apiKey)) {
    return { ok: false, status: 503, error: "adapter not configured" };
  }

  const endpoint = `${String(apiUrl).replace(/\/+$/, "")}/api/sessions`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!(response.status >= 200 && response.status < 300)) {
      return {
        ok: false,
        status: 502,
        error: `upstream status ${response.status}`,
      };
    }
    const raw = (await response.json()) as unknown;
    const data =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Array.isArray((raw as JsonObject).data)
        ? ((raw as JsonObject).data as unknown[])
        : Array.isArray(raw)
          ? raw
          : [];
    const sessions: HubSessionSummary[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as JsonObject;
      if (typeof row.id !== "string" || !row.id) continue;
      sessions.push({
        id: row.id,
        title: typeof row.title === "string" ? row.title : null,
        preview: typeof row.preview === "string" ? row.preview : null,
        updatedAt:
          typeof row.last_active === "string"
            ? row.last_active
            : row.last_active == null
              ? null
              : String(row.last_active),
      });
    }
    return { ok: true, sessions };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CreateHubOptions = {
  fetchImpl?: FetchLike;
};

export function createHub(port = 0, options: CreateHubOptions = {}): HubServer {
  reloadAdapters();
  const fetchImpl = options.fetchImpl ?? fetch;

  // Serve one stored annotation as a Markdown AI brief. Unsafe names answer
  // 400 "invalid annotation name"; missing files answer 404 "not found".
  function serveExportMd(res: http.ServerResponse, name: string): void {
    const filePath = path.join(annotationsDir(), name);
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const annotation = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as JsonObject;
      const markdown = formatAnnotationMarkdown(
        annotation,
        name,
        annotationsDir(),
      );
      const body = Buffer.from(markdown, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }

  // Serve one stored annotation as a readable, read-only HTML share page.
  // Reads only: no writes, no target changes, no adapter dispatch.
  function serveSharePage(res: http.ServerResponse, name: string): void {
    const filePath = path.join(annotationsDir(), name);
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const annotation = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as JsonObject;
      // Show the screenshot only when the sibling PNG the <img> would fetch
      // actually exists, so a missing file renders the explicit
      // no-screenshot state instead of a broken image.
      const pngPath = path.join(annotationsDir(), siblingPngName(name));
      const screenshotAvailable =
        fs.existsSync(pngPath) && fs.statSync(pngPath).isFile();
      const html = renderSharePage(annotation, name, screenshotAvailable);
      const body = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Content-Security-Policy": SHARE_CSP,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }

  // Serve the stored screenshot PNG referenced by a share page.
  function serveSharePng(res: http.ServerResponse, name: string): void {
    const pngPath = path.join(annotationsDir(), siblingPngName(name));
    try {
      if (!fs.existsSync(pngPath) || !fs.statSync(pngPath).isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const body = fs.readFileSync(pngPath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": body.length,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }

  // One annotation as a deterministic ZIP bundle: manifest.json naming the
  // schema and included files, the annotation JSON byte-for-byte, the same
  // Markdown brief /export.md serves, and the PNG when present. Missing
  // images are declared in the manifest (screenshot: null), never stubbed.
  function serveBundle(res: http.ServerResponse, name: string): void {
    try {
      const filePath = path.join(annotationsDir(), name);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const stem = name.replace(/\.json$/, "");
      const { entries, screenshot } = annotationEntries(name);
      const manifest: JsonObject = {
        schema: BUNDLE_SCHEMA,
        annotation: name,
        brief: `${stem}.md`,
        screenshot,
        files: ["manifest.json", ...entries.map((e) => e.name)].sort(),
      };
      const zip = buildZip([
        { name: "manifest.json", data: jsonBytes(manifest) },
        ...entries,
      ]);
      sendZip(res, `${stem}-bundle.zip`, Buffer.from(zip));
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }

  // Full-corpus backup: one deterministic ZIP snapshot of every stored
  // annotation (JSON + brief + PNG when present) plus a manifest. Reads are
  // snapshot-copy: PNGs are renamed before their JSON on store, so a backup
  // that lists a JSON can always read its PNG, making every archive a
  // complete before-or-after snapshot of the corpus, never a partial file
  // set. An empty corpus still produces a valid archive whose manifest
  // declares count 0. Unreadable records are skipped, never fatal.
  function serveBackup(res: http.ServerResponse): void {
    try {
      const names = listAnnotationNames();
      const entries: ZipEntry[] = [];
      const records: JsonObject[] = [];
      const fileNames: string[] = ["manifest.json"];
      for (const name of names) {
        let record: { entries: ZipEntry[]; screenshot: string | null };
        try {
          record = annotationEntries(name);
        } catch {
          continue; // corrupt/unreadable record: skip honestly
        }
        entries.push(...record.entries);
        records.push({ name, screenshot: record.screenshot });
        for (const e of record.entries) fileNames.push(e.name);
      }
      const manifest: JsonObject = {
        schema: BACKUP_SCHEMA,
        count: records.length,
        annotations: records,
        files: fileNames.filter((n) => NAME_RE.test(n)).sort(),
      };
      const zip = buildZip([
        { name: "manifest.json", data: jsonBytes(manifest) },
        ...entries,
      ]);
      sendZip(res, "browserlink-backup.zip", Buffer.from(zip));
    } catch {
      sendJson(res, 500, { error: "backup failed" });
    }
  }


  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = requestPathname(req.url);

    if (method === "OPTIONS") {
      sendEmpty(res, 204);
      return;
    }

    if (method === "GET") {
      if (pathname === "/health") {
        sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }
      if (pathname === "/status") {
        sendJson(res, 200, statusPayload());
        return;
      }
      if (pathname === "/sessions") {
        const result = await proxyHermesSessions(fetchImpl);
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        sendJson(res, 200, { sessions: result.sessions });
        return;
      }
      if (pathname === "/target") {
        const target = readTarget();
        if (target === null) {
          sendJson(res, 404, { error: "no target" });
          return;
        }
        sendJson(res, 200, target);
        return;
      }
      if (pathname === "/annotations") {
        const directory = annotationsDir();
        const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const q = normalizeSearchText((parsedUrl.searchParams.get("q") ?? "").trim());
        const urlFilter = normalizeSearchText(
          (parsedUrl.searchParams.get("url") ?? "").trim(),
        );
        const sinceRaw = parsedUrl.searchParams.get("since") ?? "";
        let sinceMs: number | null = null;
        if (sinceRaw !== "") {
          const parsed = Date.parse(sinceRaw);
          if (Number.isNaN(parsed)) {
            sendJson(res, 400, { error: "invalid since timestamp" });
            return;
          }
          sinceMs = parsed;
        }
        const filtering = q !== "" || urlFilter !== "" || sinceMs !== null;
        const files: Array<{ name: string; size: number; mtime: number }> = [];
        let skippedCorrupt = 0;
        try {
          if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
            for (const name of fs.readdirSync(directory)) {
              if (!name.endsWith(".json") || !NAME_RE.test(name)) continue;
              const filePath = path.join(directory, name);
              try {
                const st = fs.statSync(filePath);
                if (!st.isFile()) continue;
                if (sinceMs !== null && st.mtimeMs < sinceMs) continue;
                if (filtering) {
                  const annotation = tryReadAnnotation(filePath);
                  if (annotation === null) {
                    skippedCorrupt += 1;
                    continue;
                  }
                  if (
                    urlFilter !== "" &&
                    !normalizeSearchText(annotation.url).includes(urlFilter)
                  ) {
                    continue;
                  }
                  if (q !== "" && !annotationSearchText(annotation).includes(q)) {
                    continue;
                  }
                }
                files.push({ name, size: st.size, mtime: st.mtimeMs / 1000 });
              } catch {
                continue;
              }
            }
          }
        } catch {
          // empty list
        }
        files.sort((a, b) => b.mtime - a.mtime);
        if (filtering) {
          sendJson(res, 200, { files, skippedCorrupt });
        } else {
          sendJson(res, 200, { files });
        }
        return;
      }
      // Convenience alias: export the newest stored annotation (same
      // mtime ordering as GET /annotations) as Markdown.
      if (pathname === "/annotations/latest/export.md") {
        const directory = annotationsDir();
        let newest: string | null = null;
        try {
          if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
            const files: Array<{ name: string; mtime: number }> = [];
            for (const name of fs.readdirSync(directory)) {
              if (!name.endsWith(".json") || !NAME_RE.test(name)) continue;
              const filePath = path.join(directory, name);
              try {
                const st = fs.statSync(filePath);
                if (st.isFile()) files.push({ name, mtime: st.mtimeMs });
              } catch {
                continue;
              }
            }
            files.sort((a, b) => b.mtime - a.mtime);
            newest = files.length > 0 ? files[0].name : null;
          }
        } catch {
          newest = null;
        }
        if (newest === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        serveExportMd(res, newest);
        return;
      }
      if (pathname.startsWith("/annotations/") && pathname.endsWith("/export.md")) {
        const name = pathname.slice(
          "/annotations/".length,
          -"/export.md".length,
        );
        // Unsafe names (any "/", "\", or "..") answer 400; missing files 404.
        if (!isSafeName(name)) {
          sendJson(res, 400, { error: "invalid annotation name" });
          return;
        }
        serveExportMd(res, name);
        return;
      }
      // Share page: convenience alias for the newest stored annotation.
      if (pathname === "/annotations/latest/share") {
        const directory = annotationsDir();
        let newest: string | null = null;
        try {
          if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
            const files: Array<{ name: string; mtime: number }> = [];
            for (const name of fs.readdirSync(directory)) {
              if (!name.endsWith(".json") || !NAME_RE.test(name)) continue;
              const filePath = path.join(directory, name);
              try {
                const st = fs.statSync(filePath);
                if (st.isFile()) files.push({ name, mtime: st.mtimeMs });
              } catch {
                continue;
              }
            }
            files.sort((a, b) => b.mtime - a.mtime);
            newest = files.length > 0 ? files[0].name : null;
          }
        } catch {
          newest = null;
        }
        if (newest === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        serveSharePage(res, newest);
        return;
      }
      if (pathname.startsWith("/annotations/") && pathname.endsWith("/share")) {
        const name = pathname.slice(
          "/annotations/".length,
          -"/share".length,
        );
        // Unsafe names (any "/", "\", or "..") answer 400; missing files 404.
        if (!isSafeName(name)) {
          sendJson(res, 400, { error: "invalid annotation name" });
          return;
        }
        serveSharePage(res, name);
        return;
      }
      if (
        pathname.startsWith("/annotations/") &&
        pathname.endsWith("/share.png")
      ) {
        const name = pathname.slice(
          "/annotations/".length,
          -"/share.png".length,
        );
        if (!isSafeName(name)) {
          sendJson(res, 400, { error: "invalid annotation name" });
          return;
        }
        serveSharePng(res, name);
        return;
      }
      // F3: newest annotation bundle (deterministic ZIP: JSON + brief + PNG).
      if (pathname === "/annotations/latest/bundle") {
        const newest = listAnnotationNames()[0] ?? null;
        if (newest === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        serveBundle(res, newest);
        return;
      }
      if (pathname.startsWith("/annotations/") && pathname.endsWith("/bundle")) {
        const name = pathname.slice(
          "/annotations/".length,
          -"/bundle".length,
        );
        if (!isSafeName(name)) {
          sendJson(res, 400, { error: "invalid annotation name" });
          return;
        }
        serveBundle(res, name);
        return;
      }
      // F3: full-corpus backup (deterministic ZIP snapshot; valid when empty).
      if (pathname === "/annotations/backup.zip") {
        serveBackup(res);
        return;
      }
      if (pathname.startsWith("/annotations/")) {
        const name = pathname.slice("/annotations/".length);
        if (!isSafeName(name)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const filePath = path.join(annotationsDir(), name);
        try {
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          const body = fs.readFileSync(filePath);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body.length,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end(body);
        } catch {
          sendJson(res, 404, { error: "not found" });
        }
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (method === "POST") {
      let status = 500;
      try {
        if (pathname === "/target") {
          const { payload, error: err } = await readJsonBody(req);
          if (err !== null) {
            status = 400;
            sendJson(res, status, { error: err });
            return;
          }
          const [error, mode] = validateTargetBody(payload);
          if (error !== null) {
            status = 400;
            sendJson(res, status, { error });
            return;
          }
          if (mode === "clear") {
            clearTarget();
            status = 200;
            sendJson(res, status, { ok: true });
            return;
          }
          const body = payload as JsonObject;
          let label = body.label ?? "";
          if (label === null || label === undefined) label = "";
          let activate = body.activate ?? false;
          if (activate === null || activate === undefined) activate = false;
          const record: JsonObject = {
            sessionId: body.sessionId,
            label,
            ts: Date.now(),
            activate: Boolean(activate),
          };
          atomicWriteJson(targetPath(), record);
          status = 200;
          sendJson(res, status, { ok: true });
          return;
        }

        if (pathname === "/activate") {
          const { payload, error: err } = await readJsonBody(req);
          if (err !== null) {
            status = 400;
            sendJson(res, status, { error: err });
            return;
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            status = 400;
            sendJson(res, status, { error: "payload must be a JSON object" });
            return;
          }
          const body = payload as JsonObject;
          const active = body.active;
          if (typeof active !== "boolean") {
            status = 400;
            sendJson(res, status, { error: "active must be a boolean" });
            return;
          }
          const existing = readTarget() ?? {};
          const record: JsonObject = {
            sessionId:
              typeof existing.sessionId === "string" ? existing.sessionId : "",
            label: typeof existing.label === "string" ? existing.label : "",
            ts: Date.now(),
            activate: active,
          };
          atomicWriteJson(targetPath(), record);
          status = 200;
          sendJson(res, status, { ok: true });
          return;
        }

        if (pathname !== "/annotations") {
          status = 404;
          sendJson(res, status, { error: "not found" });
          return;
        }

        const { payload, error: err, status: bodyStatus } = await readJsonBody(req);
        if (err !== null) {
          status = bodyStatus ?? 400;
          sendJson(res, status, { error: err });
          return;
        }
        const body = payload as JsonObject;
        const error = validatePayload(body);
        if (error !== null) {
          status = 400;
          sendJson(res, status, { error });
          return;
        }
        const pathOut = storeAnnotation(body);
        for (const [adapterName, adapterRegister] of ADAPTERS) {
          try {
            setImmediate(() => {
              dispatchAdapter(adapterRegister, body, pathOut);
            });
          } catch (adapterError) {
            console.warn(`${adapterName} adapter failed to dispatch:`, adapterError);
          }
        }
        status = 200;
        sendJson(res, status, { ok: true, file: path.basename(pathOut) });
      } finally {
        // Access-log style line matching Python flush print.
        process.stdout.write(`POST ${pathname} ${status}\n`);
      }
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  }) as HubServer;

  return server;
}

/** Alias used by CLI and tests. */
export const createHubServer = createHub;

export function listen(port = DEFAULT_PORT): Promise<HubServer> {
  const server = createHub(port);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        server.port = addr.port;
      } else {
        server.port = port;
      }
      resolve(server);
    });
  });
}

reloadAdapters();
