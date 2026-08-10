import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_EDIT_KEYS,
  isSafeName,
  validatePayload,
  validateTargetBody,
} from "../src/schema.ts";

function payload(): Record<string, unknown> {
  return {
    source: "test",
    url: "https://example.test/page",
    title: "Test",
    viewport: { w: 100, h: 100 },
    strokes: [{ color: "#f00", width: 2, points: [[0.1, 0.2], [0.3, 0.4]] }],
  };
}

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = "data:image/png;base64," + TINY_PNG_B64;

describe("validatePayload", () => {
  it("accepts a minimal valid annotation", () => {
    assert.equal(validatePayload(payload()), null);
  });

  it("requires source and url strings", () => {
    assert.equal(validatePayload({ source: "x" }), "url must be a string");
    assert.equal(validatePayload({ url: "https://x" }), "source must be a string");
  });

  it("rejects overlong labels", () => {
    assert.equal(
      validatePayload({ ...payload(), label: "x".repeat(201) }),
      "label must be at most 200 characters",
    );
  });

  it("accepts optional sessionId and trims it", () => {
    const p = payload();
    p.sessionId = "  sess-picker-1  ";
    assert.equal(validatePayload(p), null);
    assert.equal(p.sessionId, "sess-picker-1");
  });

  it("rejects overlong sessionId", () => {
    assert.equal(
      validatePayload({ ...payload(), sessionId: "s".repeat(201) }),
      "sessionId must be at most 200 characters",
    );
  });

  it("rejects empty/whitespace sessionId", () => {
    assert.equal(
      validatePayload({ ...payload(), sessionId: "   " }),
      "sessionId must be a non-empty string",
    );
  });

  it("rejects non-string sessionId", () => {
    assert.equal(
      validatePayload({ ...payload(), sessionId: 123 }),
      "sessionId must be a string",
    );
  });

  it("accepts all allowed edit keys and string values", () => {
    const p = payload();
    p.elements = [
      {
        index: 1,
        tag: "div",
        edits: Object.fromEntries([...ALLOWED_EDIT_KEYS].map((k) => [k, "v"])),
      },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("rejects unknown edits keys", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", edits: { bogusKey: "1px" } }];
    assert.equal(
      validatePayload(p),
      "elements[0].edits has unknown key 'bogusKey'",
    );
  });

  it("requires edits values to be strings", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", edits: { width: 48 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].edits.width must be a string",
    );
  });

  it("requires edits to be an object", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", edits: "48px" }];
    assert.equal(validatePayload(p), "elements[0].edits must be an object");
  });

  it("accepts a valid PNG data URL screenshot", () => {
    const p = payload();
    p.screenshot = TINY_PNG_DATA_URL;
    assert.equal(validatePayload(p), null);
  });

  it("rejects non-PNG screenshot data URLs", () => {
    const p = payload();
    p.screenshot = "data:image/jpeg;base64,/9j/4AAQ";
    const err = validatePayload(p);
    assert.ok(err !== null);
    assert.match(err!, /screenshot/);
  });

  it("rejects invalid stroke points", () => {
    const p = payload();
    p.strokes = [{ color: "#f00", width: 1, points: [[0.1, 0.2]] }];
    assert.equal(
      validatePayload(p),
      "strokes[0].points must contain at least two points",
    );
  });
});

describe("validateTargetBody", () => {
  it("rejects empty sessionId unless activate is false", () => {
    assert.deepEqual(validateTargetBody({ sessionId: "" }), [
      "sessionId must be a non-empty string",
      null,
    ]);
    assert.deepEqual(validateTargetBody({ sessionId: "", activate: false }), [
      null,
      "clear",
    ]);
  });

  it("accepts a normal set payload", () => {
    assert.deepEqual(
      validateTargetBody({ sessionId: "abc", label: "demo", activate: true }),
      [null, "set"],
    );
  });
});

describe("isSafeName", () => {
  it("blocks traversal and accepts timestamp names", () => {
    assert.equal(isSafeName("../escape.json"), false);
    assert.equal(isSafeName("dir\\escape.json"), false);
    assert.equal(isSafeName(".."), false);
    assert.equal(isSafeName("20260101-000000-000.json"), true);
  });
});
