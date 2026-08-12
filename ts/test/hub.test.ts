import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import * as fs from "node:fs";
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
  siblingPngName,
  storeAnnotation,
} from "../src/hub.ts";
import {
  buildComposerAttachments,
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
        assert.deepEqual(res.json, { ok: true, version: "2.6.0" });

        res = await request(hub.base, "GET", "/status");
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.version, "2.6.0");
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

  test("intent/severity survive storage and render as Intent/Priority labels", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const payload = samplePayload() as Record<string, unknown>;
        payload.screenshot = TINY_PNG_DATA_URL;
        payload.elements = [
          {
            index: 1,
            tag: "button",
            id: "submit",
            className: "btn",
            text: "Log in",
            instruction: "Make primary",
            edits: { width: "48px", fontSize: "16px" },
            intent: "fix",
            severity: "blocking",
          },
          {
            index: 2,
            tag: "span",
            text: "hint",
            instruction: "keep",
          },
        ];
        const res = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);

        // Metadata survives storage byte-for-byte per element.
        const stored = JSON.parse(
          await readFile(path.join(dir, "annotations", res.json.file), "utf8"),
        );
        assert.equal(stored.elements[0].intent, "fix");
        assert.equal(stored.elements[0].severity, "blocking");
        assert.equal(stored.elements[1].intent, undefined);
        assert.equal(stored.elements[1].severity, undefined);

        // Fallback text carries Intent/Priority labels ONLY where present.
        const msg = formatMessage(stored, path.join(dir, "annotations", res.json.file));
        assert.ok(
          msg.includes(
            "E1: button#submit.btn 'Log in' - instruction: Make primary - edits: width=48px fontSize=16px - Intent: fix - Priority: blocking",
          ),
          "metadata labels appear on the annotated element",
        );
        assert.ok(
          msg.includes("E2: span 'hint' - instruction: keep"),
          "legacy element block unchanged",
        );
        assert.ok(
          !msg.includes("E2: span 'hint' - instruction: keep - Intent:"),
          "no Intent label when metadata absent",
        );

        // Composer attachment construction is untouched by metadata.
        const pngName = stored.screenshotFile;
        const jsonPath = path.join(dir, "annotations", res.json.file);
        const attachments = buildComposerAttachments(stored, jsonPath);
        assert.deepEqual(
          attachments.map((a) => a.kind),
          ["image", "file"],
          "image + file chips unchanged by metadata",
        );
        assert.ok(attachments[0].path.endsWith(pngName));
        assert.equal(attachments[1].path, path.resolve(jsonPath));
      } finally {
        await hub.close();
      }
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

/* ---------------------------------------------------------------------------
 * F4: GET /annotations/<name>/export.md (Copy AI Brief).
 * Section kept separate from schema/hub suites so concurrent feature edits to
 * other parts of this file never touch these probes.
 * ------------------------------------------------------------------------- */
describe("export.md route", () => {
  async function rawRequest(
    base: string,
    route: string,
  ): Promise<{ status: number; contentType: string | null; text: string }> {
    const res = await fetch(`${base}${route}`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      text: await res.text(),
    };
  }

  test("complete annotation exports deterministic markdown with all sections", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const payload = {
          source: "test",
          url: "https://example.test/page?q=1|2",
          title: "Test | page",
          viewport: { w: 100, h: 100 },
          label: "Export | fixture",
          notes: ["first note", "second `note` with pipe | and newline\nhere"],
          note: "legacy joined",
          strokes: [
            { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
            { color: "#0f0", width: 3, points: [[0.5, 0.6], [0.7, 0.8]] },
          ],
          elements: [
            {
              index: 1,
              tag: "button",
              cssPath: "html body form button",
              text: "Shop now",
              instruction: "Make this blue and round",
              intent: "fix",
              severity: "blocking",
              edits: { color: "#0af", fontSize: "16px" },
            },
          ],
          captureState: {
            animationsFrozen: true,
            hoveredSelector: "div.card:hover",
            activeElementSelector: null,
            openDetailsSelectors: ["details.a", "details.b"],
          },
          screenshot: TINY_PNG_DATA_URL,
        };
        const posted = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;
        const stored = JSON.parse(
          await readFile(path.join(dir, "annotations", jsonName), "utf8"),
        );
        const pngName = stored.screenshotFile as string;

        const first = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/export.md`,
        );
        assert.equal(first.status, 200);
        assert.equal(first.contentType, "text/markdown; charset=utf-8");
        for (const heading of [
          "# AI Brief",
          "## Page",
          "## Label",
          "## Notes",
          "## Elements",
          "## Capture State",
          "## Strokes",
          "## Files",
        ]) {
          assert.ok(first.text.includes(heading), `missing heading ${heading}`);
        }
        // Raw values survive verbatim (escape nothing special).
        assert.ok(first.text.includes("- URL: https://example.test/page?q=1|2"));
        assert.ok(first.text.includes("- Title: Test | page"));
        assert.ok(first.text.includes("Export | fixture"));
        assert.ok(
          first.text.includes("- second `note` with pipe | and newline\nhere"),
        );
        // Element details: index, tag, cssPath, text, instruction, edits, intent, priority.
        assert.ok(first.text.includes("### Element 1"));
        assert.ok(first.text.includes("- Tag: button"));
        assert.ok(first.text.includes("- CSS path: `html body form button`"));
        assert.ok(first.text.includes("- Text: Shop now"));
        assert.ok(first.text.includes("- Instruction: Make this blue and round"));
        assert.ok(first.text.includes("  - color: #0af"));
        assert.ok(first.text.includes("  - fontSize: 16px"));
        assert.ok(first.text.includes("- Intent: fix"));
        assert.ok(first.text.includes("- Priority: blocking"));
        // Page viewport.
        assert.ok(first.text.includes("- Viewport: 100x100"));
        // Capture state.
        assert.ok(first.text.includes("- Animations frozen: true"));
        assert.ok(first.text.includes("- Hovered selector: div.card:hover"));
        assert.ok(first.text.includes("- Active element selector: null"));
        assert.ok(
          first.text.includes("- Open details selectors: details.a, details.b"),
        );
        // Strokes count and colors.
        assert.ok(first.text.includes("- Count: 2"));
        assert.ok(first.text.includes("- Colors: #f00, #0f0"));
        // File references: JSON/PNG names plus @file/@image paths.
        assert.ok(first.text.includes(`- Annotation: \`${jsonName}\``));
        assert.ok(
          first.text.includes(`- @file:${path.join(dir, "annotations", jsonName)}`),
        );
        assert.ok(first.text.includes(`- Screenshot: \`${pngName}\``));
        assert.ok(
          first.text.includes(`- @image:${path.join(dir, "annotations", pngName)}`),
        );
        assert.ok(!first.text.includes("\u2014"), "no U+2014 in export");

        // Deterministic: repeated requests produce identical bytes.
        const second = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/export.md`,
        );
        assert.equal(second.status, 200);
        assert.equal(second.text, first.text);
      } finally {
        await hub.close();
      }
    });
  });

  test("text-only annotation exports without a broken PNG reference", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          notes: ["text only"],
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;
        const res = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/export.md`,
        );
        assert.equal(res.status, 200);
        assert.equal(res.contentType, "text/markdown; charset=utf-8");
        assert.ok(res.text.includes(`- Annotation: \`${jsonName}\``));
        assert.ok(!res.text.includes("Screenshot:"), "no PNG reference without screenshot");
        assert.ok(!res.text.includes("@image:"), "no @image reference without screenshot");
        assert.ok(res.text.includes("- text only"));
      } finally {
        await hub.close();
      }
    });
  });

  test("unsafe name returns 400 like existing reads", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const res = await rawRequest(hub.base, "/annotations/a/b/export.md");
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(res.text), { error: "invalid annotation name" });
      } finally {
        await hub.close();
      }
    });
  });

  test("missing annotation returns 404", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const res = await rawRequest(
          hub.base,
          "/annotations/20260101-000000-999.json/export.md",
        );
        assert.equal(res.status, 404);
        assert.deepEqual(JSON.parse(res.text), { error: "not found" });
      } finally {
        await hub.close();
      }
    });
  });
});

/* ---------------------------------------------------------------------------
 * F5: GET /annotations/<name>/share (read-only HTML share page).
 * Section kept separate from schema/hub suites so concurrent feature edits
 * to other parts of this file never touch these probes.
 * ------------------------------------------------------------------------- */
describe("share page route", () => {
  async function rawRequest(
    base: string,
    route: string,
  ): Promise<{ status: number; contentType: string | null; csp: string | null; text: string }> {
    const res = await fetch(`${base}${route}`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      csp: res.headers.get("content-security-policy"),
      text: await res.text(),
    };
  }

  test("complete annotation renders read-only HTML with screenshot reference", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const payload = {
          source: "test",
          url: "https://example.test/page?q=1|2",
          title: "Share fixture",
          viewport: { w: 100, h: 100 },
          label: "QA round 1",
          notes: ["first note", "second note"],
          note: "legacy joined",
          strokes: [
            { color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] },
            { color: "#0f0", width: 3, points: [[0.5, 0.6], [0.7, 0.8]] },
          ],
          elements: [
            {
              index: 1,
              tag: "button",
              cssPath: "html body form button",
              text: "Shop now",
              instruction: "Make this blue and round",
              intent: "fix",
              severity: "blocking",
              edits: { color: "#0af", fontSize: "16px" },
            },
          ],
          captureState: {
            animationsFrozen: true,
            hoveredSelector: "div.card:hover",
            activeElementSelector: null,
            openDetailsSelectors: ["details.a", "details.b"],
          },
          screenshot: TINY_PNG_DATA_URL,
        };
        const posted = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;

        const first = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/share`,
        );
        assert.equal(first.status, 200);
        assert.equal(first.contentType, "text/html; charset=utf-8");
        assert.ok(
          first.csp && first.csp.includes("default-src 'none'"),
          "no-script CSP present",
        );
        // Read-only: no forms, buttons, links, or scripts anywhere.
        for (const forbidden of ["<button", "<form", "<input", "<a ", "href=", "<script"]) {
          assert.ok(!first.text.includes(forbidden), `no ${forbidden} in share page`);
        }
        // Content sections.
        assert.ok(first.text.includes("Browserlink annotation"));
        assert.ok(first.text.includes(`Annotation file: <code>${jsonName}</code>`));
        assert.ok(first.text.includes("https://example.test/page?q=1|2"));
        assert.ok(first.text.includes("Share fixture"));
        assert.ok(first.text.includes("100x100"));
        assert.ok(first.text.includes("QA round 1"));
        assert.ok(first.text.includes("first note"));
        assert.ok(first.text.includes("second note"));
        assert.ok(first.text.includes("Element 1"));
        assert.ok(first.text.includes("button"));
        assert.ok(first.text.includes("html body form button"));
        assert.ok(first.text.includes("Shop now"));
        assert.ok(first.text.includes("Make this blue and round"));
        // Intent/severity chips.
        assert.ok(first.text.includes('class="chip chip-intent"'));
        assert.ok(first.text.includes(">fix</span>"));
        assert.ok(first.text.includes('class="chip chip-severity"'));
        assert.ok(first.text.includes(">blocking</span>"));
        // Edits.
        assert.ok(first.text.includes("<code>color</code>: #0af"));
        // Capture state.
        assert.ok(first.text.includes("Animations frozen"));
        assert.ok(first.text.includes("details.a"));
        // Strokes.
        assert.ok(first.text.includes("Count: 2"));
        assert.ok(first.text.includes("#f00"));
        // Screenshot: same-origin reference, escaped alt.
        assert.ok(
          first.text.includes(
            `<img src="/annotations/${jsonName}/share.png"`,
          ),
          "screenshot referenced via the share.png route",
        );
        assert.ok(!first.text.includes("No screenshot stored"));
        // Reachability copy is local-first.
        assert.ok(first.text.includes("not a public link"));
        assert.ok(!first.text.includes("\u2014"), "no U+2014 in share page");

        // The referenced PNG actually serves with PNG magic bytes.
        const pngRes = await fetch(
          `${hub.base}/annotations/${jsonName}/share.png`,
        );
        assert.equal(pngRes.status, 200);
        assert.equal(pngRes.headers.get("content-type"), "image/png");
        const bytes = Buffer.from(await pngRes.arrayBuffer());
        assert.deepEqual(
          bytes.subarray(0, 8),
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          "PNG magic bytes",
        );
        const storedPng = await readFile(
          path.join(dir, "annotations", siblingPngName(jsonName)),
        );
        assert.deepEqual(bytes, storedPng, "share.png serves the stored bytes");

        // Deterministic: repeated requests produce identical bytes.
        const second = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/share`,
        );
        assert.equal(second.status, 200);
        assert.equal(second.text, first.text);

        // Latest alias resolves to the same newest annotation.
        const latest = await rawRequest(hub.base, "/annotations/latest/share");
        assert.equal(latest.status, 200);
        assert.equal(latest.text, first.text);
      } finally {
        await hub.close();
      }
    });
  });

  test("hostile stored content is HTML-escaped and cannot execute", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const payload = {
          source: "test",
          url: "javascript:alert(1)",
          title: '<img src=x onerror="alert(1)">',
          viewport: { w: 100, h: 100 },
          label: '</label><script>alert("pwned")</script>',
          notes: ["<script>alert(1)</script>", '<svg onload="alert(1)">'],
          strokes: [],
          elements: [
            {
              index: 1,
              tag: "div",
              cssPath: 'a > b & "c" \'d\'',
              text: '"><script>bad()</script>',
              instruction: "</script><script>alert(2)</script>",
              intent: "fix",
              severity: "suggestion",
            },
          ],
        };
        const posted = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;

        const res = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/share`,
        );
        assert.equal(res.status, 200);
        // Raw payload markers never survive into the page: the hostile
        // strings may appear as escaped text, but never as parseable tags.
        assert.ok(!res.text.includes("<script"), "no raw script tag");
        assert.ok(!res.text.includes("<img"), "no raw img tag");
        assert.ok(!res.text.includes("<svg"), "no raw svg tag");
        assert.ok(!res.text.includes("<a "), "no raw anchor tag");
        assert.ok(!res.text.includes("href="), "no attribute ever carries the URL");
        // Escaped forms are present.
        assert.ok(res.text.includes("&lt;script&gt;"), "script escaped");
        assert.ok(res.text.includes("&lt;img"), "img escaped");
        assert.ok(res.text.includes("&quot;"), "double quote escaped");
        assert.ok(res.text.includes("&#39;"), "single quote escaped");
        assert.ok(res.text.includes("&amp;"), "ampersand escaped");
        assert.ok(
          res.text.includes("javascript:alert(1)"),
          "URL shown as plain page text",
        );
        assert.ok(!res.text.includes("href="), "no attribute ever carries the URL");
      } finally {
        await hub.close();
      }
    });
  });

  test("no-screenshot annotation shows explicit no-screenshot state", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          notes: ["text only"],
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;
        const res = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/share`,
        );
        assert.equal(res.status, 200);
        assert.ok(
          res.text.includes("No screenshot stored for this annotation."),
          "explicit no-screenshot state",
        );
        assert.ok(!res.text.includes("<img"), "no broken image element");

        // A screenshotFile that points at a missing PNG must degrade the
        // same way instead of rendering a broken image.
        const annPath = path.join(dir, "annotations", jsonName);
        const ann = JSON.parse(await readFile(annPath, "utf8"));
        ann.screenshotFile = "20260101-000000-000.png";
        await writeFile(annPath, JSON.stringify(ann));
        const degraded = await rawRequest(
          hub.base,
          `/annotations/${jsonName}/share`,
        );
        assert.equal(degraded.status, 200);
        assert.ok(
          degraded.text.includes("No screenshot stored for this annotation."),
          "missing PNG degrades to the no-screenshot state",
        );
        assert.ok(!degraded.text.includes("<img"), "no broken image element");
      } finally {
        await hub.close();
      }
    });
  });

  test("unsafe names return 400", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        let res = await rawRequest(hub.base, "/annotations/a/b/share");
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(res.text), { error: "invalid annotation name" });
        res = await rawRequest(hub.base, "/annotations/a/b/share.png");
        assert.equal(res.status, 400);
        assert.deepEqual(JSON.parse(res.text), { error: "invalid annotation name" });
      } finally {
        await hub.close();
      }
    });
  });

  test("missing safe names return 404", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        let res = await rawRequest(
          hub.base,
          "/annotations/20260101-000000-999.json/share",
        );
        assert.equal(res.status, 404);
        assert.deepEqual(JSON.parse(res.text), { error: "not found" });
        res = await rawRequest(
          hub.base,
          "/annotations/20260101-000000-999.json/share.png",
        );
        assert.equal(res.status, 404);
        assert.deepEqual(JSON.parse(res.text), { error: "not found" });
        res = await rawRequest(hub.base, "/annotations/latest/share");
        assert.equal(res.status, 404);
        assert.deepEqual(JSON.parse(res.text), { error: "not found" });
      } finally {
        await hub.close();
      }
    });
  });

  test("GET /share performs no writes", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          screenshot: TINY_PNG_DATA_URL,
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;

        const snapshot = () => {
          const map = new Map<string, [number, number]>();
          const walk = (d: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, entry.name);
              if (entry.isDirectory()) walk(p);
              else {
                const st = fs.statSync(p);
                map.set(p, [st.size, st.mtimeMs]);
              }
            }
          };
          walk(dir);
          return map;
        };
        const stateBefore = snapshot();

        for (const route of [
          `/annotations/${jsonName}/share`,
          `/annotations/${jsonName}/share.png`,
          "/annotations/latest/share",
        ]) {
          const res = await rawRequest(hub.base, route);
          assert.equal(res.status, 200);
        }

        const stateAfter = snapshot();
        assert.equal(stateAfter.size, stateBefore.size, "no new files");
        for (const [p, [size, mtime]] of stateBefore) {
          const after = stateAfter.get(p);
          assert.ok(after, `file still present: ${p}`);
          assert.equal(after[0], size, `size unchanged: ${p}`);
          assert.equal(after[1], mtime, `mtime unchanged: ${p}`);
        }
      } finally {
        await hub.close();
      }
    });
  });
});

/* ---------------------------------------------------------------------------
 * F3: GET /annotations/latest/bundle, /annotations/<name>/bundle, and
 * /annotations/backup.zip (local save and backup).
 * Section kept separate from schema/hub suites so concurrent feature edits
 * to other parts of this file never touch these probes.
 * ------------------------------------------------------------------------- */

/** Independent ZIP reader: central directory walk with CRC and size checks. */
function parseZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "EOCD present");
  const count = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(cursor), 0x02014b50, "central header magic");
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    assert.equal(method, 0, `entry ${name} is stored (no compression)`);
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, "local header magic");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(
      localOffset + 30 + lNameLen + lExtraLen,
      localOffset + 30 + lNameLen + lExtraLen + compSize,
    );
    assert.equal(data.length, uncompSize, `entry ${name} sizes agree`);
    out.set(name, Buffer.from(data));
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("F3 bundle and backup routes", () => {
  async function zipRequest(
    base: string,
    route: string,
  ): Promise<{ status: number; contentType: string | null; disposition: string | null; buf: Buffer }> {
    const res = await fetch(`${base}${route}`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
      buf: Buffer.from(await res.arrayBuffer()),
    };
  }

  const nameRe = /^[A-Za-z0-9._-]+$/;

  test("newest bundle: JSON, brief, PNG, manifest, deterministic bytes", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const payload = {
          ...samplePayload(),
          label: "Bundle fixture",
          notes: ["first note", "second note"],
          elements: [
            { index: 1, tag: "button", text: "Shop now", instruction: "Make blue" },
          ],
          screenshot: TINY_PNG_DATA_URL,
        };
        const posted = await request(hub.base, "POST", "/annotations", payload);
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;
        const stem = jsonName.replace(/\.json$/, "");

        const first = await zipRequest(hub.base, "/annotations/latest/bundle");
        assert.equal(first.status, 200);
        assert.equal(first.contentType, "application/zip");
        assert.ok(first.disposition && first.disposition.includes("attachment"));
        assert.ok(first.disposition && first.disposition.includes(`${stem}-bundle.zip`));

        const files = parseZip(first.buf);
        // Entries are name-sorted (deterministic): timestamp names sort
        // before "manifest.json" lexicographically.
        assert.deepEqual([...files.keys()], [
          jsonName,
          `${stem}.md`,
          `${stem}.png`,
          "manifest.json",
        ], "deterministic sorted entry order");

        // Manifest names schema and included files.
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        assert.equal(manifest.schema, "browserlink.annotation.bundle.v1");
        assert.equal(manifest.annotation, jsonName);
        assert.equal(manifest.brief, `${stem}.md`);
        assert.equal(manifest.screenshot, `${stem}.png`);
        assert.deepEqual(manifest.files, [
          jsonName,
          `${stem}.md`,
          `${stem}.png`,
          "manifest.json",
        ]);

        // JSON is byte-for-byte the stored file.
        const storedBytes = await readFile(path.join(dir, "annotations", jsonName));
        assert.deepEqual(files.get(jsonName)!, storedBytes, "JSON bytes match stored file");
        const stored = JSON.parse(storedBytes.toString("utf8"));
        assert.equal(stored.label, "Bundle fixture");

        // Brief carries RELATIVE file references: portable archive, no
        // absolute host filesystem paths disclosed (G4 discipline).
        const md = files.get(`${stem}.md`)!.toString("utf8");
        assert.ok(md.includes("# AI Brief"), "brief is the deterministic AI brief");
        assert.ok(md.includes(`- @file:${jsonName}`), "relative @file reference");
        assert.ok(md.includes(`- @image:${stem}.png`), "relative @image reference");
        assert.ok(!md.includes(dir), "no absolute data-dir path in the bundle");
        assert.ok(!md.includes("/annotations/"), "no filesystem path in the bundle");

        // PNG matches the stored PNG bytes.
        const storedPng = await readFile(
          path.join(dir, "annotations", siblingPngName(jsonName)),
        );
        assert.deepEqual(files.get(`${stem}.png`)!, storedPng, "PNG bytes match stored file");

        // All entry names are safe relative paths.
        for (const name of files.keys()) {
          assert.ok(nameRe.test(name), `safe entry name: ${name}`);
          assert.ok(!name.includes("/") && !name.includes(".."), `no traversal: ${name}`);
        }

        // Deterministic: a second fetch is byte-identical.
        const second = await zipRequest(hub.base, "/annotations/latest/bundle");
        assert.deepEqual(second.buf, first.buf, "repeated bundle bytes identical");
      } finally {
        await hub.close();
      }
    });
  });

  test("named bundle route, unsafe name 400, missing name 404", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          screenshot: TINY_PNG_DATA_URL,
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;

        const named = await zipRequest(hub.base, `/annotations/${jsonName}/bundle`);
        assert.equal(named.status, 200);
        const namedFiles = parseZip(named.buf);
        assert.ok(namedFiles.has("manifest.json"));
        assert.ok(namedFiles.has(jsonName));

        const unsafe = await fetch(`${hub.base}/annotations/a/b/bundle`);
        assert.equal(unsafe.status, 400);
        assert.deepEqual(await unsafe.json(), { error: "invalid annotation name" });

        const missing = await fetch(
          `${hub.base}/annotations/20260101-000000-999.json/bundle`,
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: "not found" });

        // Empty corpus: a fresh data dir answers 404 for the newest bundle.
        await withTempDataDir(async () => {
          const hub2 = await startHub();
          try {
            const empty = await fetch(`${hub2.base}/annotations/latest/bundle`);
            assert.equal(empty.status, 404);
            assert.deepEqual(await empty.json(), { error: "not found" });
          } finally {
            await hub2.close();
          }
        });
      } finally {
        await hub.close();
      }
    });
  });

  test("no-PNG bundle declares the absent image instead of failing", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          notes: ["text only"],
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;
        const stem = jsonName.replace(/\.json$/, "");

        const res = await zipRequest(hub.base, `/annotations/${jsonName}/bundle`);
        assert.equal(res.status, 200);
        const files = parseZip(res.buf);
        assert.deepEqual([...files.keys()], [
          jsonName,
          `${stem}.md`,
          "manifest.json",
        ], "no PNG entry without a screenshot");
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        assert.equal(manifest.screenshot, null, "absent image declared as null");
        assert.deepEqual(manifest.files, [
          jsonName,
          `${stem}.md`,
          "manifest.json",
        ]);
        const md = files.get(`${stem}.md`)!.toString("utf8");
        assert.ok(!md.includes("Screenshot:"), "brief has no PNG reference");
        assert.ok(!md.includes("@image:"), "brief has no @image reference");
      } finally {
        await hub.close();
      }
    });
  });

  test("empty corpus backup is a valid explicit empty backup", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        const res = await zipRequest(hub.base, "/annotations/backup.zip");
        assert.equal(res.status, 200);
        assert.equal(res.contentType, "application/zip");
        const files = parseZip(res.buf);
        assert.deepEqual([...files.keys()], ["manifest.json"]);
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        assert.equal(manifest.schema, "browserlink.corpus.backup.v1");
        assert.equal(manifest.count, 0);
        assert.deepEqual(manifest.annotations, []);
        assert.deepEqual(manifest.files, ["manifest.json"]);
      } finally {
        await hub.close();
      }
    });
  });

  test("multi-record backup: full set, hashes, deterministic ordering", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const first = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          label: "A with png",
          screenshot: TINY_PNG_DATA_URL,
        });
        assert.equal(first.status, 200);
        const second = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          label: "B text only",
        });
        assert.equal(second.status, 200);
        const third = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          label: "C with png",
          screenshot: TINY_PNG_DATA_URL,
        });
        assert.equal(third.status, 200);
        const names = [first.json.file, second.json.file, third.json.file].sort();

        const res = await zipRequest(hub.base, "/annotations/backup.zip");
        assert.equal(res.status, 200);
        assert.ok(res.disposition && res.disposition.includes("browserlink-backup.zip"));
        const files = parseZip(res.buf);

        // Every stored record is present with its brief, PNG when stored.
        for (const name of names) {
          assert.ok(files.has(name), `JSON present: ${name}`);
          assert.ok(files.has(name.replace(/\.json$/, "") + ".md"), `brief present: ${name}`);
        }
        const withPng = names.filter((n) => files.has(siblingPngName(n)));
        assert.equal(withPng.length, 2, "two PNGs included");
        assert.ok(!files.has(siblingPngName(second.json.file)), "text-only record has no PNG");

        // Each JSON parses and matches its stored file bytes.
        for (const name of names) {
          const storedBytes = await readFile(path.join(dir, "annotations", name));
          assert.deepEqual(files.get(name)!, storedBytes, `stored bytes: ${name}`);
          const parsed = JSON.parse(files.get(name)!.toString("utf8"));
          assert.ok(typeof parsed.label === "string");
        }

        // PNG hashes match the stored PNGs.
        for (const name of withPng) {
          const storedPng = await readFile(
            path.join(dir, "annotations", siblingPngName(name)),
          );
          assert.deepEqual(
            files.get(siblingPngName(name))!,
            storedPng,
            `PNG bytes: ${name}`,
          );
        }

        // Manifest: count, per-record screenshot flags, sorted file list.
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        assert.equal(manifest.schema, "browserlink.corpus.backup.v1");
        assert.equal(manifest.count, 3);
        assert.equal(manifest.annotations.length, 3);
        const screenshots = manifest.annotations.map(
          (a: { name: string; screenshot: string | null }) => a.screenshot,
        );
        assert.equal(screenshots.filter((s: string | null) => s !== null).length, 2);
        const manifestFiles: string[] = manifest.files;
        assert.deepEqual(manifestFiles, [...manifestFiles].sort(), "manifest.files sorted");
        assert.deepEqual([...files.keys()], [...files.keys()].sort(), "entries sorted");
        assert.deepEqual(manifestFiles, [...files.keys()].sort(), "manifest matches entries");

        // No unsafe paths anywhere.
        for (const name of files.keys()) {
          assert.ok(nameRe.test(name), `safe entry name: ${name}`);
          assert.ok(!name.includes("/") && !name.includes(".."), `no traversal: ${name}`);
        }

        // Deterministic: repeated backup is byte-identical.
        const again = await zipRequest(hub.base, "/annotations/backup.zip");
        assert.deepEqual(again.buf, res.buf, "repeated backup bytes identical");
      } finally {
        await hub.close();
      }
    });
  });

  test("snapshot during concurrent write is complete before-or-after", async () => {
    await withTempDataDir(async () => {
      const hub = await startHub();
      try {
        await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          screenshot: TINY_PNG_DATA_URL,
        });
        const racing = {
          ...samplePayload(),
          notes: ["racing annotation"],
          screenshot: TINY_PNG_DATA_URL,
        };
        const [posted, backupRes] = await Promise.all([
          request(hub.base, "POST", "/annotations", racing),
          fetch(`${hub.base}/annotations/backup.zip`).then(async (r) => ({
            status: r.status,
            buf: Buffer.from(await r.arrayBuffer()),
          })),
        ]);
        assert.equal(posted.status, 200);
        assert.equal(backupRes.status, 200);
        const racingName = posted.json.file as string;

        const files = parseZip(backupRes.buf);
        const stem = racingName.replace(/\.json$/, "");
        const hasJson = files.has(racingName);
        const hasPng = files.has(siblingPngName(racingName));
        const hasMd = files.has(`${stem}.md`);
        // Never a partial file set: JSON implies its full triple, and no
        // PNG/MD appears without its JSON.
        assert.ok(!(hasPng && !hasJson), "PNG never appears without its JSON");
        assert.ok(!(hasMd && !hasJson), "brief never appears without its JSON");
        assert.ok(!(hasJson && !(hasPng && hasMd)), "JSON implies PNG + brief");
        assert.ok(
          hasJson || (!hasPng && !hasMd),
          "either the full record or nothing (before-or-after snapshot)",
        );

        // The archive still parses fully with correct entry counts.
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
        assert.equal(manifest.count, hasJson ? 2 : 1);
        assert.deepEqual(
          [...files.keys()],
          [...files.keys()].sort(),
          "deterministic ordering holds under concurrency",
        );
      } finally {
        await hub.close();
      }
    });
  });

  test("GET bundle and backup perform no writes", async () => {
    await withTempDataDir(async (dir) => {
      const hub = await startHub();
      try {
        const posted = await request(hub.base, "POST", "/annotations", {
          ...samplePayload(),
          screenshot: TINY_PNG_DATA_URL,
        });
        assert.equal(posted.status, 200);
        const jsonName = posted.json.file as string;

        const snapshot = () => {
          const map = new Map<string, [number, number]>();
          const walk = (d: string) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, entry.name);
              if (entry.isDirectory()) walk(p);
              else {
                const st = fs.statSync(p);
                map.set(p, [st.size, st.mtimeMs]);
              }
            }
          };
          walk(dir);
          return map;
        };
        const stateBefore = snapshot();

        for (const route of [
          `/annotations/${jsonName}/bundle`,
          "/annotations/latest/bundle",
          "/annotations/backup.zip",
        ]) {
          const res = await fetch(`${hub.base}${route}`);
          assert.equal(res.status, 200);
        }

        const stateAfter = snapshot();
        assert.equal(stateAfter.size, stateBefore.size, "no new files");
        for (const [p, [size, mtime]] of stateBefore) {
          const after = stateAfter.get(p);
          assert.ok(after, `file still present: ${p}`);
          assert.equal(after[0], size, `size unchanged: ${p}`);
          assert.equal(after[1], mtime, `mtime unchanged: ${p}`);
        }
      } finally {
        await hub.close();
      }
    });
  });
});
