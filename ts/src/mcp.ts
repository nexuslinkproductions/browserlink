/**
 * Browserlink MCP server (TypeScript).
 * Same tool names and semantics as mcp/mcp_server.py; hub over HTTP.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { INTENT_VALUES, SEVERITY_VALUES } from "./schema.ts";

export const VERSION = "2.7.0";
export const DEFAULT_HUB = "http://127.0.0.1:8787";
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export type JsonObject = Record<string, unknown>;

export function dataDir(): string {
  const configured = process.env.BROWSERLINK_DATA_DIR;
  if (configured) {
    return configured.replace(/^~(?=$|[/\\])/, homedir());
  }
  const hermesHome = process.env.HERMES_HOME;
  if (hermesHome) {
    return join(hermesHome.replace(/^~(?=$|[/\\])/, homedir()), "annotations");
  }
  return join(homedir(), ".browserlink", "annotations");
}

export function annotationsDir(): string {
  return join(dataDir(), "annotations");
}

export function safeName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

export function hubBase(): string {
  const configured = process.env.BROWSERLINK_HUB_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return DEFAULT_HUB;
}

export async function hubRequest(
  method: string,
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const url = hubBase() + path;
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  init.signal = controller.signal;

  try {
    const response = await fetch(url, init);
    const raw = await response.text();
    let value: unknown = null;
    if (raw) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
    }

    if (!response.ok) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as JsonObject;
        if (obj.error) {
          return { ok: false, error: String(obj.error), status: response.status };
        }
      }
      return { ok: false, error: raw || response.statusText, status: response.status };
    }

    if (!raw) {
      return { ok: true };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonObject;
    }
    return { ok: true, data: value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export type AnnotationFileInfo = { name: string; size: number; mtime: number };

export type AnnotationListOptions = {
  /** Full-text term across label, URL, title, notes, element text and instruction. */
  q?: string;
  /** URL substring filter (same normalization as q). */
  url?: string;
  /** ISO 8601 timestamp; only annotations stored at or after it are returned. */
  since?: string;
  /** Element CSS-path prefix filter (NFC-normalized, case-insensitive prefix over any element's cssPath). */
  cssPathPrefix?: string;
  /** True: only annotations whose elements include at least one non-empty edits array; false: only annotations with no element edits. */
  hasEdits?: boolean;
  /** Any element carries this intent (one of fix, change, question, approve). */
  intent?: string;
  /** Any element carries this severity (one of blocking, important, suggestion). */
  severity?: string;
};

/* ---------------------------------------------------------------------------
 * F7: local full-text search. Same normalization, ordering, and result set
 * as GET /annotations?q=&url=&since= on the hub: NFC-normalized,
 * case-folded substring match across label, URL, title, notes, the legacy
 * joined note, and per-element text and instruction. Unreadable records are
 * skipped, never fatal, mirroring the REST route's skippedCorrupt behavior.
 * ------------------------------------------------------------------------- */
function normalizeSearchText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").toLowerCase();
}

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

async function tryReadAnnotation(name: string): Promise<JsonObject | null> {
  try {
    const value = JSON.parse(
      await fs.readFile(join(annotationsDir(), name), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as JsonObject;
  } catch {
    return null;
  }
}

export async function listAnnotationFiles(): Promise<AnnotationFileInfo[]> {
  const directory = annotationsDir();
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: AnnotationFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !safeName(entry.name)) {
      continue;
    }
    try {
      const stat = await fs.stat(join(directory, entry.name));
      result.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs / 1000 });
    } catch {
      continue;
    }
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

function elementEditCount(element: JsonObject): number {
  const edits = element.edits;
  return Array.isArray(edits) ? edits.length : 0;
}

/* Any element carries a non-empty edits array. */
function hasEdits(annotation: JsonObject): boolean {
  if (!Array.isArray(annotation.elements)) return false;
  for (const element of annotation.elements) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      continue;
    }
    if (elementEditCount(element as JsonObject) > 0) return true;
  }
  return false;
}

/* Any element carries the given scalar field value (intent / severity). */
function anyElementField(annotation: JsonObject, key: string, value: string): boolean {
  if (!Array.isArray(annotation.elements)) return false;
  for (const element of annotation.elements) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      continue;
    }
    if ((element as JsonObject)[key] === value) return true;
  }
  return false;
}

/* Any element's cssPath starts with the normalized prefix. */
function anyElementCssPathPrefix(annotation: JsonObject, prefix: string): boolean {
  if (!Array.isArray(annotation.elements)) return false;
  for (const element of annotation.elements) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      continue;
    }
    const cssPath = (element as JsonObject).cssPath;
    if (typeof cssPath === "string" && normalizeSearchText(cssPath).startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export async function listAnnotationFilesFiltered(
  options: AnnotationListOptions = {},
): Promise<AnnotationFileInfo[]> {
  const q = normalizeSearchText((options.q ?? "").trim());
  const urlFilter = normalizeSearchText((options.url ?? "").trim());
  const cssPathPrefix = normalizeSearchText((options.cssPathPrefix ?? "").trim());
  if (options.intent !== undefined && !(INTENT_VALUES as readonly string[]).includes(options.intent)) {
    throw new Error(
      `intent must be one of ${INTENT_VALUES.join(", ")}`,
    );
  }
  if (options.severity !== undefined && !(SEVERITY_VALUES as readonly string[]).includes(options.severity)) {
    throw new Error(
      `severity must be one of ${SEVERITY_VALUES.join(", ")}`,
    );
  }
  const sinceRaw = options.since ?? "";
  let sinceMs: number | null = null;
  if (sinceRaw !== "") {
    const parsed = Date.parse(sinceRaw);
    if (Number.isNaN(parsed)) {
      throw new Error("invalid since timestamp");
    }
    sinceMs = parsed;
  }
  const all = await listAnnotationFiles();
  const filtering = q !== "" || urlFilter !== "" || sinceMs !== null
    || cssPathPrefix !== "" || options.hasEdits !== undefined
    || options.intent !== undefined || options.severity !== undefined;
  if (!filtering) return all;

  const out: AnnotationFileInfo[] = [];
  for (const info of all) {
    if (sinceMs !== null && info.mtime * 1000 < sinceMs) continue;
    const annotation = await tryReadAnnotation(info.name);
    if (annotation === null) continue; // corrupt record: skipped like REST
    if (urlFilter !== "" && !normalizeSearchText(annotation.url).includes(urlFilter)) {
      continue;
    }
    if (cssPathPrefix !== "" && !anyElementCssPathPrefix(annotation, cssPathPrefix)) {
      continue;
    }
    if (options.hasEdits === true && !hasEdits(annotation)) continue;
    if (options.hasEdits === false && hasEdits(annotation)) continue;
    if (options.intent !== undefined && !anyElementField(annotation, "intent", options.intent)) {
      continue;
    }
    if (options.severity !== undefined && !anyElementField(annotation, "severity", options.severity)) {
      continue;
    }
    if (q !== "" && !annotationSearchText(annotation).includes(q)) continue;
    out.push(info);
  }
  return out;
}

export async function annotationsList(
  limit = 20,
  options: AnnotationListOptions = {},
): Promise<AnnotationFileInfo[]> {
  if (limit < 0) {
    throw new Error("limit must be non-negative");
  }
  const files = await listAnnotationFilesFiltered(options);
  return files.slice(0, limit);
}

export async function hubStatus(): Promise<JsonObject> {
  const adapters: string[] = [];
  if (process.env.HERMES_API_URL && process.env.HERMES_API_KEY) {
    adapters.push("hermes");
  }
  if (process.env.BROWSERLINK_WEBHOOK_URL) {
    adapters.push("webhook");
  }
  return { ok: true, version: VERSION, dataDir: dataDir(), adapters };
}

export async function annotationsGet(name: string): Promise<JsonObject> {
  if (!safeName(name)) {
    throw new Error("invalid annotation name");
  }
  const path = join(annotationsDir(), name);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    throw new Error("annotation not found");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("annotation could not be read");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("annotation must be an object");
  }
  return value as JsonObject;
}

export async function annotationsLatest(): Promise<JsonObject> {
  const files = await listAnnotationFiles();
  if (files.length === 0) {
    return {};
  }
  return annotationsGet(files[0].name);
}

// H14: annotations_watch awaits inside the single-threaded stdio server, so
// an unbounded seconds value would block every other MCP tool for hours.
// Cap the wait at 120s; the zod schema enforces the same bound.
export const MAX_WATCH_SECONDS = 120;

export async function annotationsWatch(seconds = 10): Promise<string[]> {
  if (seconds < 0 || seconds > MAX_WATCH_SECONDS) {
    throw new Error(`seconds must be between 0 and ${MAX_WATCH_SECONDS}`);
  }
  const before = new Set((await listAnnotationFiles()).map((item) => item.name));
  if (seconds) {
    await delay(seconds * 1000);
  }
  const after = (await listAnnotationFiles())
    .map((item) => item.name)
    .filter((name) => !before.has(name));
  return after.reverse();
}

// Popup session picker and browserlink_connect both write target.json;
// last writer wins.
export async function browserlinkConnect(
  sessionId: string,
  label = "",
  activate = true,
): Promise<JsonObject> {
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "sessionId must be a non-empty string" };
  }
  if (sessionId.length > 200) {
    return { ok: false, error: "sessionId must be at most 200 characters" };
  }
  if (typeof label !== "string") {
    return { ok: false, error: "label must be a string" };
  }
  if (label.length > 200) {
    return { ok: false, error: "label must be at most 200 characters" };
  }
  if (typeof activate !== "boolean") {
    return { ok: false, error: "activate must be a boolean" };
  }

  const targetResult = await hubRequest("POST", "/target", {
    sessionId,
    label,
    activate,
  });
  if (!targetResult.ok) {
    return {
      ok: false,
      error: targetResult.error ?? "POST /target failed",
      sessionId,
      label,
      activate,
    };
  }

  if (activate) {
    const activateResult = await hubRequest("POST", "/activate", { active: true });
    if (!activateResult.ok) {
      return {
        ok: false,
        error: activateResult.error ?? "POST /activate failed",
        sessionId,
        label,
        activate,
      };
    }
  }

  return { ok: true, sessionId, label, activate };
}

export async function browserlinkDisconnect(): Promise<JsonObject> {
  const result = await hubRequest("POST", "/target", {
    sessionId: "",
    label: "",
    activate: false,
  });
  if (!result.ok) {
    return { ok: false, error: result.error ?? "disconnect failed" };
  }
  return { ok: true };
}

export async function browserlinkStatus(): Promise<JsonObject> {
  const status = await hubRequest("GET", "/status");
  if (status.ok === false && "error" in status && !("version" in status)) {
    return status;
  }

  const target = await hubRequest("GET", "/target");
  if (target.ok === false && target.status === 404) {
    status.target = null;
  } else if (target.ok === false && "error" in target && !("sessionId" in target)) {
    status.target = null;
    status.targetError = target.error;
  } else {
    status.target = {
      sessionId: target.sessionId ?? "",
      label: target.label ?? "",
      activate: target.activate ?? false,
      ts: target.ts,
    };
  }
  if (!("ok" in status)) {
    status.ok = true;
  }
  return status;
}

function asText(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "browserlink", version: VERSION });

  server.registerTool(
    "hub_status",
    { description: "Return Browserlink MCP status and resolved data directory." },
    async () => asText(await hubStatus()),
  );

  server.registerTool(
    "annotations_list",
    {
      description:
        "List annotation files, newest first. Optional filters compose with AND semantics and match the hub REST search normalization: q (full-text term across label, URL, title, notes, element text and instruction), url (URL substring), since (ISO 8601 timestamp), cssPathPrefix (element CSS-path prefix), hasEdits (boolean: elements include a non-empty edits array), intent (fix, change, question, or approve on any element), and severity (blocking, important, or suggestion on any element).",
      inputSchema: {
        limit: z.number().int().default(20).describe("Max files to return"),
        q: z.string().optional().describe("Full-text term; case-insensitive NFC-normalized substring match"),
        url: z.string().optional().describe("URL substring filter (same normalization as q)"),
        since: z.string().optional().describe("ISO 8601 timestamp; only annotations stored at or after it"),
        cssPathPrefix: z.string().optional().describe("Element cssPath prefix filter (NFC-normalized, case-insensitive; any element)"),
        hasEdits: z.boolean().optional().describe("True: only annotations whose elements include at least one non-empty edits array; false: only annotations with no element edits"),
        intent: z.enum(["fix", "change", "question", "approve"]).optional().describe("Only annotations where any element carries this intent"),
        severity: z.enum(["blocking", "important", "suggestion"]).optional().describe("Only annotations where any element carries this severity"),
      },
    },
    async ({ limit, q, url, since, cssPathPrefix, hasEdits, intent, severity }) =>
      asText(await annotationsList(limit ?? 20, {
        q,
        url,
        since,
        cssPathPrefix,
        hasEdits,
        intent,
        severity,
      })),
  );

  server.registerTool(
    "annotations_latest",
    { description: "Read the newest annotation, or return an empty object." },
    async () => asText(await annotationsLatest()),
  );

  server.registerTool(
    "annotations_get",
    {
      description: "Read one annotation by its safe file name.",
      inputSchema: { name: z.string().describe("Annotation file name") },
    },
    async ({ name }) => asText(await annotationsGet(name)),
  );

  server.registerTool(
    "annotations_watch",
    {
      description: "Wait for new annotation files and return their names.",
      inputSchema: {
        seconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WATCH_SECONDS)
          .default(10)
          .describe(`Seconds to wait for new files (0-${MAX_WATCH_SECONDS})`),
      },
    },
    async ({ seconds }) => asText(await annotationsWatch(seconds ?? 10)),
  );

  server.registerTool(
    "browserlink_connect",
    {
      description:
        "Connect this chat as the annotation delivery target and optionally activate the extension.",
      inputSchema: {
        sessionId: z.string().describe("Session id for delivery"),
        label: z.string().default("").describe("Optional human label"),
        activate: z.boolean().default(true).describe("Activate extension overlay"),
      },
    },
    async ({ sessionId, label, activate }) =>
      asText(await browserlinkConnect(sessionId, label ?? "", activate ?? true)),
  );

  server.registerTool(
    "browserlink_disconnect",
    {
      description: "Clear the connected chat target so annotations are no longer delivered there.",
    },
    async () => asText(await browserlinkDisconnect()),
  );

  server.registerTool(
    "browserlink_status",
    {
      description: "Return hub /status merged with the current /target (or null target).",
    },
    async () => asText(await browserlinkStatus()),
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export const main = runMcpServer;