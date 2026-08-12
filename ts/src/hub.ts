/**
 * browserlink HTTP hub, TypeScript port of server/hub.py.
 * Drop-in compatible REST contract (v2.0.0).
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
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
        const files: Array<{ name: string; size: number; mtime: number }> = [];
        try {
          if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
            for (const name of fs.readdirSync(directory)) {
              if (!name.endsWith(".json") || !NAME_RE.test(name)) continue;
              const filePath = path.join(directory, name);
              try {
                const st = fs.statSync(filePath);
                if (st.isFile()) {
                  files.push({ name, size: st.size, mtime: st.mtimeMs / 1000 });
                }
              } catch {
                continue;
              }
            }
          }
        } catch {
          // empty list
        }
        files.sort((a, b) => b.mtime - a.mtime);
        sendJson(res, 200, { files });
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
