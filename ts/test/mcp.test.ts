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
        version: "2.8.0",
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
      assert.equal(status.version, "2.8.0");
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

/* ---------------------------------------------------------------------------
 * F7: annotations_list search filters. Same semantics as the hub REST search
 * (NFC-normalized, case-folded substring match over label/url/title/notes/
 * element text/instruction; url and since compose with AND; invalid since
 * rejects). Test names carry 'search', 'filter', or 'annotations_list' for
 * the mechanism gate's --test-name-pattern.
 * ------------------------------------------------------------------------- */
describe("mcp annotations_list search filters", () => {
  const mcpSeed = [
    {
      name: "20260101-000000-000.json",
      record: {
        url: "https://fixture.test/alpha",
        title: "Alpha",
        label: "Needle one",
        notes: ["productivity hack"],
        elements: [],
      },
    },
    {
      name: "20260101-000001-000.json",
      record: {
        url: "https://fixture.test/beta",
        title: "Beta",
        label: "Needle two",
        notes: ["unrelated"],
        elements: [
          { index: 1, tag: "p", text: "Some body", instruction: "Make it pop" },
        ],
      },
    },
    {
      name: "20260101-000002-000.json",
      record: {
        url: "https://other.test/gamma",
        title: "Gamma",
        label: "Unicode record",
        notes: ["caf\u00e9 creme"], // composed e-acute (NFC)
        elements: [],
      },
    },
  ];

  async function seedMcp(dir: string): Promise<void> {
    const annotations = path.join(dir, "annotations");
    await mkdir(annotations, { recursive: true });
    for (const item of mcpSeed) {
      await writeFile(
        path.join(annotations, item.name),
        JSON.stringify(item.record),
      );
      await new Promise((r) => setTimeout(r, 20)); // distinct mtimes
    }
  }

  test("annotations_list q search matches across fields newest first", async () => {
    await withTempDataDir(async (dir) => {
      await seedMcp(dir);
      const names = (list: { name: string }[]) => list.map((f) => f.name);
      const byNeedle = await annotationsList(20, { q: "NEEDLE" });
      assert.deepEqual(names(byNeedle), [
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const byPop = await annotationsList(20, { q: "pop" });
      assert.deepEqual(names(byPop), ["20260101-000001-000.json"]);
      const byGamma = await annotationsList(20, { q: "gamma" });
      assert.deepEqual(names(byGamma), ["20260101-000002-000.json"]);
      // NFC: decomposed query hits the composed stored note.
      const decomposed = await annotationsList(20, { q: "cafe\u0301" });
      assert.deepEqual(names(decomposed), ["20260101-000002-000.json"]);
      const noMatch = await annotationsList(20, { q: "absent" });
      assert.deepEqual(noMatch, []);
    });
  });

  test("annotations_list url and since filters compose with q", async () => {
    await withTempDataDir(async (dir) => {
      await seedMcp(dir);
      const names = (list: { name: string }[]) => list.map((f) => f.name);
      const byUrl = await annotationsList(20, { url: "fixture" });
      assert.deepEqual(names(byUrl), [
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const combined = await annotationsList(20, { q: "needle", url: "fixture" });
      assert.deepEqual(names(combined), [
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const excluded = await annotationsList(20, { q: "needle", url: "other" });
      assert.deepEqual(excluded, []);
      const sinceAll = await annotationsList(20, { since: "2026-01-01T00:00:00.000Z" });
      assert.deepEqual(names(sinceAll), [
        "20260101-000002-000.json",
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const sinceFuture = await annotationsList(20, { since: "2099-01-01T00:00:00.000Z" });
      assert.deepEqual(sinceFuture, []);
    });
  });

  test("annotations_list invalid since rejects", async () => {
    await withTempDataDir(async () => {
      await assert.rejects(
        () => annotationsList(20, { since: "not-a-date" }),
        /invalid since timestamp/,
      );
    });
  });

  test("annotations_list empty q returns the full newest-first list", async () => {
    await withTempDataDir(async (dir) => {
      await seedMcp(dir);
      const names = (list: { name: string }[]) => list.map((f) => f.name);
      const full = await annotationsList(20, { q: "" });
      assert.deepEqual(names(full), [
        "20260101-000002-000.json",
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const noOpts = await annotationsList(20);
      assert.deepEqual(names(noOpts), names(full));
    });
  });
});

/* ---------------------------------------------------------------------------
 * F10: annotations_list programmatic filters. cssPathPrefix, hasEdits,
 * intent, and severity compose with q/url/since using AND semantics and
 * keep the stable newest-first ordering. Invalid filter values reject with
 * documented errors. Test names carry 'annotations_list' or 'filter' for
 * the mechanism gate's --test-name-pattern.
 * ------------------------------------------------------------------------- */
describe("mcp annotations_list programmatic filters", () => {
  const filterSeed = [
    {
      name: "20260101-000000-000.json",
      record: {
        url: "https://fixture.test/a",
        title: "Alpha",
        label: "Combined fixture one",
        notes: [],
        elements: [
          {
            index: 1, tag: "div", cssPath: "#app > div:nth-of-type(1)",
            text: "First card", instruction: "fix the spacing",
            intent: "fix", severity: "blocking",
            edits: [{ key: "color", value: "#fff" }],
          },
        ],
      },
    },
    {
      name: "20260101-000001-000.json",
      record: {
        url: "https://fixture.test/b",
        title: "Beta",
        label: "Combined fixture two",
        notes: [],
        elements: [
          {
            index: 1, tag: "p", cssPath: "#main > p:nth-of-type(2)",
            text: "Second paragraph", instruction: "tweak copy",
            intent: "change", severity: "suggestion",
            edits: [{ key: "fontStyle" }],
          },
          {
            index: 2, tag: "span", cssPath: "#app > div:nth-of-type(1) span",
            text: "inline span",
            intent: "fix", severity: "blocking",
          },
        ],
      },
    },
    {
      name: "20260101-000002-000.json",
      record: {
        url: "https://fixture.test/c",
        label: "Combined fixture three",
        notes: [],
        elements: [
          { index: 1, cssPath: "#app > div:nth-of-type(1)", intent: "fix", severity: "blocking", edits: [] },
        ],
      },
    },
    {
      name: "20260101-000003-000.json",
      record: {
        url: "https://fixture.test/d",
        label: "Combined fixture four",
        notes: [],
        elements: [
          { index: 1, cssPath: "#app > div:nth-of-type(1)", intent: "question", severity: "blocking", edits: [{ key: "x" }] },
        ],
      },
    },
    {
      name: "20260101-000004-000.json",
      record: {
        url: "https://other.test/e",
        label: "Combined fixture five",
        notes: [],
        elements: [
          { index: 1, cssPath: "#app > div:nth-of-type(1)", intent: "fix", severity: "blocking", edits: [{ key: "x" }] },
        ],
      },
    },
    {
      name: "20260101-000005-000.json",
      record: {
        url: "https://fixture.test/f",
        label: "Combined fixture six",
        notes: [],
        elements: [
          { index: 1, cssPath: "#sidebar > ul", intent: "fix", severity: "blocking", edits: [{ key: "x" }] },
        ],
      },
    },
  ];

  async function seedFilterData(dir: string): Promise<void> {
    const annotations = path.join(dir, "annotations");
    await mkdir(annotations, { recursive: true });
    for (const item of filterSeed) {
      await writeFile(
        path.join(annotations, item.name),
        JSON.stringify(item.record),
      );
      await new Promise((r) => setTimeout(r, 20)); // distinct mtimes
    }
  }

  const names = (list: { name: string }[]) => list.map((f) => f.name);
  // Newest-first mtime order after seeding: reverse of the write order.
  const ALL = [
    "20260101-000005-000.json",
    "20260101-000004-000.json",
    "20260101-000003-000.json",
    "20260101-000002-000.json",
    "20260101-000001-000.json",
    "20260101-000000-000.json",
  ];

  test("annotations_list cssPathPrefix filter matches any element prefix", async () => {
    await withTempDataDir(async (dir) => {
      await seedFilterData(dir);
      const byPrefix = await annotationsList(20, { cssPathPrefix: "#app > div" });
      assert.deepEqual(names(byPrefix), [
        "20260101-000004-000.json",
        "20260101-000003-000.json",
        "20260101-000002-000.json",
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      // Case-insensitive, NFC-normalized: a different-case prefix still matches.
      const mixedCase = await annotationsList(20, { cssPathPrefix: "#APP > DIV" });
      assert.deepEqual(names(mixedCase), names(byPrefix));
      const noHit = await annotationsList(20, { cssPathPrefix: "#footer" });
      assert.deepEqual(noHit, []);
    });
  });

  test("annotations_list hasEdits filter separates edited elements", async () => {
    await withTempDataDir(async (dir) => {
      await seedFilterData(dir);
      const edited = await annotationsList(20, { hasEdits: true });
      // A1, A2, A4, A5, A6 carry a non-empty edits array; A3's edits:[] does not count.
      assert.deepEqual(names(edited), [
        "20260101-000005-000.json",
        "20260101-000004-000.json",
        "20260101-000003-000.json",
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const untouched = await annotationsList(20, { hasEdits: false });
      assert.deepEqual(names(untouched), ["20260101-000002-000.json"]);
    });
  });

  test("annotations_list intent and severity filters match any element", async () => {
    await withTempDataDir(async (dir) => {
      await seedFilterData(dir);
      const fix = await annotationsList(20, { intent: "fix" });
      assert.deepEqual(names(fix), [
        "20260101-000005-000.json",
        "20260101-000004-000.json",
        "20260101-000002-000.json",
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      const question = await annotationsList(20, { intent: "question" });
      assert.deepEqual(names(question), ["20260101-000003-000.json"]);
      const blocking = await annotationsList(20, { severity: "blocking" });
      assert.deepEqual(names(blocking), ALL);
      const suggestion = await annotationsList(20, { severity: "suggestion" });
      assert.deepEqual(names(suggestion), ["20260101-000001-000.json"]);
      // AND semantics between intent and severity: each filter matches any
      // element independently, so an annotation with fix on one element and
      // suggestion on another qualifies, while an absent combo does not.
      const fixAndSuggestion = await annotationsList(20, { intent: "fix", severity: "suggestion" });
      assert.deepEqual(names(fixAndSuggestion), ["20260101-000001-000.json"]);
      const changeAndSuggestion = await annotationsList(20, { intent: "change", severity: "suggestion" });
      assert.deepEqual(names(changeAndSuggestion), ["20260101-000001-000.json"]);
      const questionAndSuggestion = await annotationsList(20, { intent: "question", severity: "suggestion" });
      assert.deepEqual(questionAndSuggestion, []);
    });
  });

  test("annotations_list combined filter fixture returns exact ordered ids", async () => {
    await withTempDataDir(async (dir) => {
      await seedFilterData(dir);
      // Every filter narrows: q, url, since, cssPathPrefix, hasEdits,
      // intent, and severity must ALL hold, in newest-first order.
      const combined = await annotationsList(20, {
        q: "combined",
        url: "fixture",
        since: "2026-01-01T00:00:00.000Z",
        cssPathPrefix: "#app > div",
        hasEdits: true,
        intent: "fix",
        severity: "blocking",
      });
      assert.deepEqual(names(combined), [
        "20260101-000001-000.json",
        "20260101-000000-000.json",
      ]);
      // limit composes with the filters and keeps the same ordering.
      const limited = await annotationsList(1, {
        q: "combined",
        url: "fixture",
        since: "2026-01-01T00:00:00.000Z",
        cssPathPrefix: "#app > div",
        hasEdits: true,
        intent: "fix",
        severity: "blocking",
      });
      assert.deepEqual(names(limited), ["20260101-000001-000.json"]);
    });
  });

  test("annotations_list invalid filter values reject", async () => {
    await withTempDataDir(async (dir) => {
      await seedFilterData(dir);
      await assert.rejects(
        () => annotationsList(20, { intent: "bogus" }),
        /intent must be one of fix, change, question, approve/,
      );
      await assert.rejects(
        () => annotationsList(20, { severity: "bogus" }),
        /severity must be one of blocking, important, suggestion/,
      );
      await assert.rejects(
        () => annotationsList(20, { intent: "fix", since: "not-a-date" }),
        /invalid since timestamp/,
      );
    });
  });
});
