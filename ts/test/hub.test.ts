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
  reloadAdapters,
  storeAnnotation,
} from "../src/hub.ts";
import { formatMessage } from "../src/adapters/hermes.ts";

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
        assert.deepEqual(res.json, { ok: true, version: "2.0.0" });

        res = await request(hub.base, "GET", "/status");
        assert.equal(res.status, 200);
        assert.equal(res.json.ok, true);
        assert.equal(res.json.version, "2.0.0");
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
