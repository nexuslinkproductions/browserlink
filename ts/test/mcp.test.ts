import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";

import {
  annotationsGet,
  annotationsLatest,
  annotationsList,
  annotationsWatch,
  browserlinkConnect,
  browserlinkDisconnect,
  browserlinkStatus,
  hubStatus,
} from "../src/mcp.ts";

type JsonObject = Record<string, unknown>;

const prevEnv: Record<string, string | undefined> = {
  BROWSERLINK_DATA_DIR: process.env.BROWSERLINK_DATA_DIR,
  BROWSERLINK_HUB_URL: process.env.BROWSERLINK_HUB_URL,
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_API_URL: process.env.HERMES_API_URL,
  HERMES_API_KEY: process.env.HERMES_API_KEY,
  BROWSERLINK_WEBHOOK_URL: process.env.BROWSERLINK_WEBHOOK_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "browserlink-mcp-"));
  process.env.BROWSERLINK_DATA_DIR = dir;
  delete process.env.HERMES_HOME;
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": raw.length,
  });
  res.end(raw);
}

/** Minimal hub stub covering /status, /target, /activate for MCP connect tools. */
async function startTempHub(dataDir: string): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  let target: JsonObject | null = null;
  const targetFile = path.join(dataDir, "target.json");

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/status") {
      sendJson(res, 200, {
        ok: true,
        version: "2.6.0",
        dataDir,
        adapters: [],
        target: target
          ? { sessionId: target.sessionId, label: target.label ?? "" }
          : null,
      });
      return;
    }

    if (method === "GET" && pathname === "/target") {
      if (target === null) {
        sendJson(res, 404, { error: "no target" });
        return;
      }
      sendJson(res, 200, target);
      return;
    }

    if (method === "POST" && pathname === "/target") {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as JsonObject;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const activate = body.activate;
      if (sessionId === "" && activate === false) {
        target = null;
        await rm(targetFile, { force: true });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (sessionId === "") {
        sendJson(res, 400, { error: "sessionId must be a non-empty string" });
        return;
      }
      target = {
        sessionId,
        label: typeof body.label === "string" ? body.label : "",
        activate: Boolean(activate),
        ts: Date.now(),
      };
      await writeFile(targetFile, `${JSON.stringify(target, null, 2)}\n`, "utf8");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/activate") {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as JsonObject;
      if (typeof body.active !== "boolean") {
        sendJson(res, 400, { error: "active must be a boolean" });
        return;
      }
      if (target === null) target = { sessionId: "", label: "", ts: Date.now() };
      target = { ...target, activate: body.active, ts: Date.now() };
      await writeFile(targetFile, `${JSON.stringify(target, null, 2)}\n`, "utf8");
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  process.env.BROWSERLINK_HUB_URL = `http://127.0.0.1:${port}`;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("mcp annotation tools", () => {
  test("hub_status, list, latest, get", async () => {
    await withTempDataDir(async (dir) => {
      const annotations = path.join(dir, "annotations");
      await mkdir(annotations, { recursive: true });
      const first = "20260101-000000-000.json";
      const second = "20260101-000001-000.json";
      await writeFile(
        path.join(annotations, first),
        JSON.stringify({ url: "https://one.test", label: "one" }),
      );
      // Ensure second is newer on disk for mtime ordering.
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(
        path.join(annotations, second),
        JSON.stringify({ url: "https://two.test", label: "two" }),
      );

      const status = await hubStatus();
      assert.equal(status.ok, true);
      assert.equal(status.version, "2.6.0");
      assert.equal(status.dataDir, dir);
      assert.deepEqual(status.adapters, []);

      const listed = await annotationsList(20);
      assert.deepEqual(
        listed.map((item) => item.name),
        [second, first],
      );

      const latest = await annotationsLatest();
      assert.equal(latest.label, "two");

      const got = await annotationsGet(first);
      assert.equal(got.label, "one");

      const limited = await annotationsList(1);
      assert.equal(limited[0]?.name, second);

      await assert.rejects(() => annotationsGet("../escape.json"), /invalid annotation name/);
      await assert.rejects(() => annotationsList(-1), /limit must be non-negative/);
    });
  });

  test("annotations_watch returns new files", async () => {
    await withTempDataDir(async (dir) => {
      const annotations = path.join(dir, "annotations");
      await mkdir(annotations, { recursive: true });
      const newName = "20260101-000002-000.json";
      const creator = (async () => {
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(
          path.join(annotations, newName),
          JSON.stringify({ url: "https://new.test" }),
        );
      })();
      const watched = await annotationsWatch(0.2);
      await creator;
      assert.deepEqual(watched, [newName]);
    });
  });
});

describe("mcp connect tools against temp hub", () => {
  test("connect / status / disconnect / get", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startTempHub(dir);
      try {
        const connected = await browserlinkConnect("mcp-sess-1", "mcp label", true);
        assert.deepEqual(connected, {
          ok: true,
          sessionId: "mcp-sess-1",
          label: "mcp label",
          activate: true,
        });

        const status = await browserlinkStatus();
        assert.equal(status.ok, true);
        assert.equal((status.target as JsonObject).sessionId, "mcp-sess-1");
        assert.equal((status.target as JsonObject).label, "mcp label");
        assert.equal((status.target as JsonObject).activate, true);

        const listed = await annotationsList(5);
        assert.deepEqual(listed, []);

        await assert.rejects(() => annotationsGet("missing.json"), /annotation not found/);

        const disconnected = await browserlinkDisconnect();
        assert.deepEqual(disconnected, { ok: true });

        const after = await browserlinkStatus();
        assert.equal(after.ok, true);
        assert.equal(after.target, null);
      } finally {
        await hub.close();
      }
    });
  });
});
