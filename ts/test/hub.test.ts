import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createHubServer,
  dataDir,
  isSafeName,
  proxyHermesSessions,
  reloadAdapters,
  storeAnnotation,
} from "../src/hub.ts";
import {
  formatMessage,
  register as registerHermes,
  resolveSessionId,
} from "../src/adapters/hermes.ts";
import { register as registerWebhook } from "../src/adapters/webhook.ts";
import { MAX_MESSAGE_TEXT_LENGTH } from "../src/schema.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;
const TINY_PNG = Buffer.from(TINY_PNG_B64, "base64");

function samplePayload() {
  return {
    source: "test",
    url: "https://example.test/page",
    title: "Test",
    viewport: { w: 100, h: 100 },
    strokes: [
      { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
    ],
  };
}

async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "browserlink-hub-"));
  const prevData = process.env.BROWSERLINK_DATA_DIR;
  const prevHermes = process.env.HERMES_HOME;
  process.env.BROWSERLINK_DATA_DIR = dir;
  delete process.env.HERMES_HOME;
  reloadAdapters();
  try {
    return await fn(dir);
  } finally {
    if (prevData === undefined) delete process.env.BROWSERLINK_DATA_DIR;
    else process.env.BROWSERLINK_DATA_DIR = prevData;
    if (prevHermes === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prevHermes;
    reloadAdapters();
    await rm(dir, { recursive: true, force: true });
  }
}

async function startHub(): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = createHubServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("hub data dir + safety", () => {
  test("dataDir precedence", async () => {
    await withTempDataDir(async (explicit) => {
      assert.equal(dataDir(), explicit);
      const hermes = await mkdtemp(path.join(tmpdir(), "browserlink-hermes-"));
      try {
        delete process.env.BROWSERLINK_DATA_DIR;
        process.env.HERMES_HOME = hermes;
        assert.equal(dataDir(), path.join(hermes, "annotations"));
      } finally {
        await rm(hermes, { recursive: true, force: true });
      }
    });
  });

  test("traversal names rejected", () => {
    assert.equal(isSafeName("../escape.json"), false);
    assert.equal(isSafeName("dir\\escape.json"), false);
    assert.equal(isSafeName(".."), false);
    assert.equal(isSafeName("20260101-000000-000.json"), true);
  });
});

describe("storeAnnotation screenshot", () => {
  test("stores png and screenshotFile", async () => {
    await withTempDataDir(async (dir) => {
      const p = samplePayload() as Record<string, unknown>;
      p.screenshot = TINY_PNG_DATA_URL;
      const out = await storeAnnotation(p);
      const stored = JSON.parse(await readFile(out, "utf8"));
      assert.equal("screenshot" in stored, false);
      assert.ok(typeof stored.screenshotFile === "string");
      assert.ok(stored.screenshotFile.endsWith(".png"));
      const pngPath = path.join(dir, "annotations", stored.screenshotFile);
      const bytes = await readFile(pngPath);
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
  });
});

describe("HTTP routes", () => {
  test("health status target activate annotations traversal", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        let res = await request(hub.base, "GET", "/health");
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true, version: "2.2.0" });

        res = await request(hub.base, "GET", "/status");
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.version, "2.2.0");
        assert.equal(res.json.dataDir, dir);
        assert.equal(res.json.target, null);
        assert.ok(Array.isArray(res.json.adapters));

        res = await request(hub.base, "GET", "/target");
        assert.equal(res.status, 404);
        assert.deepEqual(res.json, { error: "no target" });

        res = await request(hub.base, "POST", "/target", {
          sessionId: "sess-abc",
          label: "demo chat",
          activate: true,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true });

        res = await request(hub.base, "GET", "/target");
        assert.equal(res.status, 200);
        assert.equal(res.json.sessionId, "sess-abc");
        assert.equal(res.json.label, "demo chat");
        assert.equal(res.json.activate, true);
        assert.equal(typeof res.json.ts, "number");

        res = await request(hub.base, "POST", "/activate", { active: false });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true });

        res = await request(hub.base, "GET", "/target");
        assert.equal(res.json.sessionId, "sess-abc");
        assert.equal(res.json.label, "demo chat");
        assert.equal(res.json.activate, false);

        res = await request(hub.base, "GET", "/status");
        assert.deepEqual(res.json.target, {
          sessionId: "sess-abc",
          label: "demo chat",
        });

        res = await request(hub.base, "POST", "/target", {
          sessionId: "",
          label: "x",
        });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /sessionId/);

        const payload = samplePayload() as Record<string, unknown>;
        payload.screenshot = TINY_PNG_DATA_URL;
        res = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.ok(typeof res.json.file === "string");
        const stored = JSON.parse(
          await readFile(path.join(dir, "annotations", res.json.file), "utf8"),
        );
        assert.ok(stored.screenshotFile);
        await readFile(path.join(dir, "annotations", stored.screenshotFile));

        res = await request(hub.base, "GET", "/annotations/../escape.json");
        assert.equal(res.status, 404);
        assert.deepEqual(res.json, { error: "not found" });
      } finally {
        await hub.close();
      }
    });
  });
});

describe("hermes message format", () => {
  test("includes @image and @file when present", async () => {
    await withTempDataDir(async (dir) => {
      const annDir = path.join(dir, "annotations");
      await mkdir(annDir, { recursive: true });
      const pngPath = path.join(annDir, "20260101-000000-000.png");
      const jsonPath = path.join(annDir, "20260101-000000-000.json");
      await writeFile(pngPath, TINY_PNG);
      const ann = {
        source: "test",
        url: "https://example.test/login",
        title: "Login",
        label: "qa",
        viewport: { w: 100, h: 100 },
        strokes: [
          { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
        ],
        elements: [
          {
            tag: "button",
            id: "submit",
            className: "btn",
            text: "Log in",
            instruction: "Make primary",
            edits: { width: "48px", fontSize: "16px" },
          },
        ],
        screenshotFile: "20260101-000000-000.png",
      };
      await writeFile(jsonPath, JSON.stringify(ann));
      const msg = formatMessage(ann, jsonPath);
      const lines = msg.split("\n");
      assert.equal(lines[0], `@image:${path.resolve(pngPath)}`);
      assert.equal(lines[lines.length - 1], `@file:${path.resolve(jsonPath)}`);
      assert.ok(msg.includes("📎 browserlink annotation"));
      assert.ok(msg.includes("URL: https://example.test/login"));
      assert.ok(
        msg.includes(
          "E1: button#submit.btn 'Log in' - instruction: Make primary - edits: width=48px fontSize=16px",
        ),
      );
      assert.ok(msg.includes("1 stroke(s)"));
    });
  });
});

describe("resolveSessionId priority", () => {
  test("annotation > target.json > env > null", async () => {
    await withTempDataDir(async (dir) => {
      const prevEnv = process.env.HERMES_SESSION_ID;
      try {
        delete process.env.HERMES_SESSION_ID;
        assert.equal(resolveSessionId(), null);
        assert.equal(resolveSessionId({}), null);

        process.env.HERMES_SESSION_ID = "env-sess";
        assert.equal(resolveSessionId(), "env-sess");

        await writeFile(
          path.join(dir, "target.json"),
          JSON.stringify({ sessionId: "target-sess", label: "t", ts: 1, activate: false }),
        );
        assert.equal(resolveSessionId(), "target-sess");
        assert.equal(resolveSessionId({ sessionId: "ann-sess" }), "ann-sess");
        assert.equal(resolveSessionId({ sessionId: "  ann-trim  " }), "ann-trim");
        // Empty / whitespace annotation sessionId falls through.
        assert.equal(resolveSessionId({ sessionId: "   " }), "target-sess");
        // Overlong annotation sessionId is ignored (falls through).
        assert.equal(resolveSessionId({ sessionId: "x".repeat(201) }), "target-sess");
      } finally {
        if (prevEnv === undefined) delete process.env.HERMES_SESSION_ID;
        else process.env.HERMES_SESSION_ID = prevEnv;
      }
    });
  });
});

describe("GET /sessions proxy", () => {
  test("503 when adapter env missing", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    try {
      delete process.env.HERMES_API_URL;
      delete process.env.HERMES_API_KEY;
      const result = await proxyHermesSessions(async () => {
        throw new Error("fetch should not be called");
      });
      assert.deepEqual(result, {
        ok: false,
        status: 503,
        error: "adapter not configured",
      });
    } finally {
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
    }
  });

  test("normalizes Hermes list and maps last_active to updatedAt", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    process.env.HERMES_API_URL = "http://hermes.test";
    process.env.HERMES_API_KEY = "test-key";
    try {
      const result = await proxyHermesSessions(async (url, init) => {
        assert.equal(String(url), "http://hermes.test/api/sessions");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "s1",
                title: "Chat One",
                preview: "hello",
                last_active: "2026-08-10T12:00:00Z",
              },
              { id: "s2", title: null, preview: null, last_active: null },
              { id: 99, title: "bad" },
            ],
            limit: 50,
            offset: 0,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.sessions, [
          {
            id: "s1",
            title: "Chat One",
            preview: "hello",
            updatedAt: "2026-08-10T12:00:00Z",
          },
          { id: "s2", title: null, preview: null, updatedAt: null },
        ]);
      }
    } finally {
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
    }
  });

  test("502 on non-2xx upstream and on fetch failure", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    process.env.HERMES_API_URL = "http://hermes.test/";
    process.env.HERMES_API_KEY = "test-key";
    try {
      let result = await proxyHermesSessions(async () =>
        new Response("nope", { status: 401 }),
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 502);
        assert.match(result.error, /upstream status 401/);
      }

      result = await proxyHermesSessions(async () => {
        throw new Error("network down");
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 502);
        assert.match(result.error, /network down/);
      }
    } finally {
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
    }
  });

  test("HTTP GET /sessions returns normalized JSON with CORS", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    await withTempDataDir(async () => {
      process.env.HERMES_API_URL = "http://hermes.test";
      process.env.HERMES_API_KEY = "k";
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "live-1", title: "T", preview: "p", last_active: "t1" }],
          }),
          { status: 200 },
        );
      const { createHub } = await import("../src/hub.ts");
      const server = createHub(0, { fetchImpl });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/sessions`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("access-control-allow-origin"), "*");
        const json = await res.json();
        assert.deepEqual(json, {
          sessions: [{ id: "live-1", title: "T", preview: "p", updatedAt: "t1" }],
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        if (prevUrl === undefined) delete process.env.HERMES_API_URL;
        else process.env.HERMES_API_URL = prevUrl;
        if (prevKey === undefined) delete process.env.HERMES_API_KEY;
        else process.env.HERMES_API_KEY = prevKey;
      }
    });
  });
});

describe("hermes text-only fallback and caps", () => {
  test("no screenshot: text-only message with @file chip, no @image", async () => {
    await withTempDataDir(async (dir) => {
      const annDir = path.join(dir, "annotations");
      await mkdir(annDir, { recursive: true });
      const jsonPath = path.join(annDir, "20260101-000000-001.json");
      const ann = {
        source: "test",
        url: "https://example.test/login",
        title: "Login",
        label: "qa",
        viewport: { w: 100, h: 100 },
        strokes: [
          { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
        ],
        note: "capture failed, no screenshot",
      };
      await writeFile(jsonPath, JSON.stringify(ann));
      const msg = formatMessage(ann, jsonPath);
      assert.ok(!msg.includes("@image:"), "no @image: line without a screenshot");
      assert.ok(!msg.includes("image_url"), "no image_url part in text-only fallback");
      assert.ok(msg.endsWith(`@file:${path.resolve(jsonPath)}`), "@file chip appended");
      assert.ok(msg.includes("Note: capture failed, no screenshot"));
    });
  });

  test("MAX_MESSAGE_TEXT_LENGTH never cuts @image or @file lines", async () => {
    await withTempDataDir(async (dir) => {
      const annDir = path.join(dir, "annotations");
      await mkdir(annDir, { recursive: true });
      const pngPath = path.join(annDir, "20260101-000000-002.png");
      const jsonPath = path.join(annDir, "20260101-000000-002.json");
      await writeFile(pngPath, TINY_PNG);
      const ann = {
        source: "test",
        url: "https://example.test/login",
        title: "Login",
        label: "qa",
        viewport: { w: 100, h: 100 },
        strokes: [
          { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
        ],
        elements: [
          { index: 1, tag: "div", text: "x".repeat(MAX_MESSAGE_TEXT_LENGTH + 1000) },
        ],
        screenshotFile: "20260101-000000-002.png",
      };
      await writeFile(jsonPath, JSON.stringify(ann));
      const msg = formatMessage(ann, jsonPath);
      const lines = msg.split("\n");
      assert.ok(lines[0].startsWith("@image:"), "@image line survives the cap");
      assert.ok(
        lines[lines.length - 1].startsWith("@file:"),
        "@file line survives the cap",
      );
      const body = lines.slice(1, -1).join("\n");
      assert.ok(
        body.length <= MAX_MESSAGE_TEXT_LENGTH,
        `body capped (got ${body.length})`,
      );
    });
  });
});

describe("hermes adapter delivery", () => {
  test("attachments present: composer attach called, no /chat POST", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    const prevSid = process.env.HERMES_SESSION_ID;
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await withTempDataDir(async (dir) => {
        process.env.HERMES_API_URL = "http://hermes.test";
        process.env.HERMES_API_KEY = "k";
        process.env.HERMES_SESSION_ID = "sess-live";
        const annDir = path.join(dir, "annotations");
        await mkdir(annDir, { recursive: true });
        const pngPath = path.join(annDir, "20260101-000000-010.png");
        const jsonPath = path.join(annDir, "20260101-000000-010.json");
        await writeFile(pngPath, TINY_PNG);
        const ann = {
          id: "ann-attach-1",
          source: "test",
          url: "https://example.test/",
          viewport: { w: 100, h: 100 },
          strokes: [],
          note: "user note",
          screenshotFile: "20260101-000000-010.png",
        };
        await writeFile(jsonPath, JSON.stringify(ann));
        await registerHermes(ann, jsonPath);
        assert.equal(calls.length, 1, "exactly one POST runs");
        assert.ok(
          calls[0].url.endsWith("/api/composer/attach"),
          `composer attach endpoint called (got ${calls[0].url})`,
        );
        assert.ok(
          !calls[0].url.includes("/api/sessions/"),
          "no /chat POST when composer attach delivers",
        );
        const sent = JSON.parse(calls[0].body) as {
          sessionId: string;
          attachments: { kind: string; path: string; label: string }[];
        };
        assert.equal(sent.sessionId, "sess-live");
        assert.equal(sent.attachments.length, 2);
        assert.equal(sent.attachments[0].kind, "image");
        assert.equal(sent.attachments[0].path, path.resolve(pngPath));
        assert.equal(sent.attachments[1].kind, "file");
        assert.equal(sent.attachments[1].path, path.resolve(jsonPath));
        const logLines = (
          await readFile(path.join(dir, "browserlink-error.log"), "utf8")
        )
          .trim()
          .split("\n");
        const entry = logLines
          .map((l) => JSON.parse(l))
          .find((l) => l.message === "composer-attached");
        assert.ok(entry, "composer-attached line written to the shared log");
        assert.equal(entry.adapter, "hermes");
        assert.equal(entry.annotationId, "ann-attach-1");
        assert.equal(entry.sessionId, "sess-live");
        assert.equal(entry.messageId, null);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
      if (prevSid === undefined) delete process.env.HERMES_SESSION_ID;
      else process.env.HERMES_SESSION_ID = prevSid;
    }
  });

  test("no attachments (text-only): /chat fallback", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    const prevSid = process.env.HERMES_SESSION_ID;
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: "msg-9002" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await withTempDataDir(async (dir) => {
        process.env.HERMES_API_URL = "http://hermes.test";
        process.env.HERMES_API_KEY = "k";
        process.env.HERMES_SESSION_ID = "sess-live";
        const ann = {
          id: "ann-fallback-1",
          source: "test",
          url: "https://example.test/",
          viewport: { w: 100, h: 100 },
          strokes: [],
          note: "no screenshot here",
        };
        // No annotationPath and no screenshotFile: zero attachments, so the
        // composer attach path cannot run and /chat must deliver.
        await registerHermes(ann, null);
        assert.equal(calls.length, 1, "only the /chat POST runs");
        assert.ok(
          calls[0].url.endsWith("/api/sessions/sess-live/chat"),
          `chat endpoint called (got ${calls[0].url})`,
        );
        assert.ok(!calls[0].url.includes("/api/composer/attach"));
        const sent = JSON.parse(calls[0].body) as Record<string, unknown>;
        assert.equal(typeof sent.message, "string");
        assert.ok(!String(sent.message).includes("@image:"));
        assert.ok(!String(sent.message).includes("@file:"));
        assert.ok(String(sent.message).includes("Note: no screenshot here"));
        const logLines = (
          await readFile(path.join(dir, "browserlink-error.log"), "utf8")
        )
          .trim()
          .split("\n");
        const entry = logLines
          .map((l) => JSON.parse(l))
          .find((l) => l.message === "/chat fallback");
        assert.ok(entry, "/chat fallback line written to the shared log");
        assert.equal(entry.adapter, "hermes");
        assert.equal(entry.annotationId, "ann-fallback-1");
        assert.equal(entry.sessionId, "sess-live");
        assert.equal(entry.messageId, "msg-9002");
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
      if (prevSid === undefined) delete process.env.HERMES_SESSION_ID;
      else process.env.HERMES_SESSION_ID = prevSid;
    }
  });

  test("attach 404: /chat fallback delivers with message id", async () => {
    const prevUrl = process.env.HERMES_API_URL;
    const prevKey = process.env.HERMES_API_KEY;
    const prevSid = process.env.HERMES_SESSION_ID;
    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: String(init?.body ?? "") });
      if (u.includes("/api/composer/attach")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ id: "msg-9003" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await withTempDataDir(async (dir) => {
        process.env.HERMES_API_URL = "http://hermes.test";
        process.env.HERMES_API_KEY = "k";
        process.env.HERMES_SESSION_ID = "sess-live";
        const annDir = path.join(dir, "annotations");
        await mkdir(annDir, { recursive: true });
        const jsonPath = path.join(annDir, "20260101-000000-011.json");
        const ann = {
          id: "ann-fallback-2",
          source: "test",
          url: "https://example.test/",
          viewport: { w: 100, h: 100 },
          strokes: [],
          note: "file chip only",
        };
        await writeFile(jsonPath, JSON.stringify(ann));
        await registerHermes(ann, jsonPath);
        assert.equal(calls.length, 2, "attach POST then /chat fallback POST");
        assert.ok(
          calls[0].url.endsWith("/api/composer/attach"),
          `attach endpoint tried first (got ${calls[0].url})`,
        );
        assert.ok(
          calls[1].url.endsWith("/api/sessions/sess-live/chat"),
          `chat endpoint used as fallback (got ${calls[1].url})`,
        );
        const sent = JSON.parse(calls[1].body) as Record<string, unknown>;
        assert.equal(typeof sent.message, "string");
        assert.ok(String(sent.message).includes("@file:"));
        const logLines = (
          await readFile(path.join(dir, "browserlink-error.log"), "utf8")
        )
          .trim()
          .split("\n");
        const entry = logLines
          .map((l) => JSON.parse(l))
          .find((l) => l.message === "/chat fallback");
        assert.ok(entry, "/chat fallback line written to the shared log");
        assert.equal(entry.adapter, "hermes");
        assert.equal(entry.annotationId, "ann-fallback-2");
        assert.equal(entry.sessionId, "sess-live");
        assert.equal(entry.messageId, "msg-9003");
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.HERMES_API_URL;
      else process.env.HERMES_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.HERMES_API_KEY;
      else process.env.HERMES_API_KEY = prevKey;
      if (prevSid === undefined) delete process.env.HERMES_SESSION_ID;
      else process.env.HERMES_SESSION_ID = prevSid;
    }
  });
});

describe("webhook adapter", () => {
  test("missing URL skips without sending", async () => {
    const prevUrl = process.env.BROWSERLINK_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      delete process.env.BROWSERLINK_WEBHOOK_URL;
      await registerWebhook({
        source: "test",
        url: "https://example.test/",
        viewport: { w: 100, h: 100 },
        strokes: [],
      });
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.BROWSERLINK_WEBHOOK_URL;
      else process.env.BROWSERLINK_WEBHOOK_URL = prevUrl;
    }
  });

  test("oversized payload is skipped and logged", async () => {
    const prevUrl = process.env.BROWSERLINK_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      await withTempDataDir(async (dir) => {
        process.env.BROWSERLINK_WEBHOOK_URL = "http://webhook.test/hook";
        await registerWebhook({
          id: "ann-big-1",
          source: "test",
          url: "https://example.test/",
          viewport: { w: 100, h: 100 },
          strokes: [],
          note: "x".repeat(1_100_000),
        });
        assert.equal(called, false, "oversized body never sent");
        const logLines = (
          await readFile(path.join(dir, "browserlink-error.log"), "utf8")
        )
          .trim()
          .split("\n");
        const entry = logLines
          .map((l) => JSON.parse(l))
          .find((l) => l.adapter === "webhook");
        assert.ok(entry, "oversized skip logged to the shared error log");
        assert.equal(entry.annotationId, "ann-big-1");
        assert.match(entry.error, /exceeds/);
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.BROWSERLINK_WEBHOOK_URL;
      else process.env.BROWSERLINK_WEBHOOK_URL = prevUrl;
    }
  });

  test("sends under the cap", async () => {
    const prevUrl = process.env.BROWSERLINK_WEBHOOK_URL;
    const originalFetch = globalThis.fetch;
    let captured: { url: string; body: string } | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body ?? "") };
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      process.env.BROWSERLINK_WEBHOOK_URL = "http://webhook.test/hook";
      await registerWebhook({
        id: "ann-ok-1",
        source: "test",
        url: "https://example.test/",
        viewport: { w: 100, h: 100 },
        strokes: [],
        note: "small payload",
      });
      assert.ok(captured, "fetch was called");
      assert.equal(captured!.url, "http://webhook.test/hook");
      const sent = JSON.parse(captured!.body) as Record<string, unknown>;
      assert.equal(sent.id, "ann-ok-1");
      assert.equal(sent.note, "small payload");
    } finally {
      globalThis.fetch = originalFetch;
      if (prevUrl === undefined) delete process.env.BROWSERLINK_WEBHOOK_URL;
      else process.env.BROWSERLINK_WEBHOOK_URL = prevUrl;
    }
  });
});
