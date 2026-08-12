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

  it("accepts the schema v1.5 text-formatting edit keys", () => {
    const p = payload();
    p.elements = [
      {
        index: 1,
        tag: "span",
        edits: {
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: "2px",
          wordSpacing: "3px",
          whiteSpace: "nowrap",
          verticalAlign: "middle",
          textDecoration: "underline",
          fontStyle: "italic",
          textShadow: "1px 1px 2px #000",
        },
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

  it("accepts all valid intent and severity enum values", () => {
    for (const intent of ["fix", "change", "question", "approve"]) {
      for (const severity of ["blocking", "important", "suggestion"]) {
        const p = payload();
        p.elements = [{ index: 1, tag: "button", intent, severity }];
        assert.equal(validatePayload(p), null, `intent=${intent} severity=${severity}`);
      }
    }
  });

  it("accepts intent alone and severity alone (schema v1.6 optional fields)", () => {
    const onlyIntent = payload();
    onlyIntent.elements = [{ index: 1, tag: "button", intent: "question" }];
    assert.equal(validatePayload(onlyIntent), null);
    const onlySeverity = payload();
    onlySeverity.elements = [{ index: 1, tag: "button", severity: "suggestion" }];
    assert.equal(validatePayload(onlySeverity), null);
  });

  it("accepts legacy elements without intent/severity (backward compatible)", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", text: "Log in", edits: { width: "48px" } }];
    assert.equal(validatePayload(p), null);
  });

  it("rejects unknown intent values", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", intent: "bogus" }];
    assert.equal(
      validatePayload(p),
      "elements[0].intent must be one of fix, change, question, approve",
    );
  });

  it("rejects unknown severity values", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", severity: "urgent" }];
    assert.equal(
      validatePayload(p),
      "elements[0].severity must be one of blocking, important, suggestion",
    );
  });

  it("rejects non-string intent", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", intent: 42 }];
    assert.equal(
      validatePayload(p),
      "elements[0].intent must be one of fix, change, question, approve",
    );
  });

  it("rejects non-string severity", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", severity: 42 }];
    assert.equal(
      validatePayload(p),
      "elements[0].severity must be one of blocking, important, suggestion",
    );
  });

  // ---- Schema v1.7 (F1 deep pick): optional frame/shadow metadata ----

  it("accepts elements with valid frame metadata (schema v1.7)", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", frame: { path: [0, 1] } },
      { index: 2, tag: "iframe", frame: { path: [], crossOrigin: true } },
      { index: 3, tag: "div", frame: { path: [2], crossOrigin: false } },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts elements with valid shadow metadata (schema v1.7)", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "span", shadow: { depth: 2, hosts: ["#host-a", "div.x > #host-b"] } },
      { index: 2, tag: "span", shadow: { depth: 0, hosts: [] } },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts frame and shadow metadata together", () => {
    const p = payload();
    p.elements = [
      {
        index: 1,
        tag: "button",
        frame: { path: [1, 0], crossOrigin: false },
        shadow: { depth: 1, hosts: ["#outer-host"] },
      },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts legacy elements without frame/shadow (backward compatible)", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", cssPath: "html body button" }];
    assert.equal(validatePayload(p), null);
  });

  it("rejects a non-object frame", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: "iframe0" }];
    assert.equal(validatePayload(p), "elements[0].frame must be an object");
  });

  it("rejects unknown nested frame keys", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: { path: [0], url: "https://x" } }];
    assert.equal(validatePayload(p), "elements[0].frame has unknown key 'url'");
  });

  it("rejects a non-list frame.path", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: { path: "0" } }];
    assert.equal(validatePayload(p), "elements[0].frame.path must be a list");
  });

  it("rejects negative and non-integer frame.path entries", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: { path: [0, -1] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].frame.path[1] must be a non-negative integer",
    );
    p.elements = [{ index: 1, tag: "button", frame: { path: [0, 1.5] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].frame.path[1] must be a non-negative integer",
    );
  });

  it("rejects overlong frame.path", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: { path: [0, 1, 2, 3, 4, 5, 6, 7, 8] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].frame.path must have at most 8 entries",
    );
  });

  it("rejects non-boolean frame.crossOrigin", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", frame: { crossOrigin: "yes" } }];
    assert.equal(
      validatePayload(p),
      "elements[0].frame.crossOrigin must be a boolean",
    );
  });

  it("rejects a non-object shadow", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", shadow: 3 }];
    assert.equal(validatePayload(p), "elements[0].shadow must be an object");
  });

  it("rejects unknown nested shadow keys", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", shadow: { depth: 1, mode: "open" } }];
    assert.equal(validatePayload(p), "elements[0].shadow has unknown key 'mode'");
  });

  it("rejects non-integer and out-of-range shadow.depth", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", shadow: { depth: 1.5 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.depth must be an integer from 0 to 8",
    );
    p.elements = [{ index: 1, tag: "button", shadow: { depth: 9 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.depth must be an integer from 0 to 8",
    );
    p.elements = [{ index: 1, tag: "button", shadow: { depth: -1 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.depth must be an integer from 0 to 8",
    );
  });

  it("rejects non-list shadow.hosts", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", shadow: { hosts: "#a" } }];
    assert.equal(validatePayload(p), "elements[0].shadow.hosts must be a list");
  });

  it("rejects non-string and empty shadow.hosts entries", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", shadow: { hosts: ["#a", 7] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.hosts[1] must be a non-empty string of at most 500 characters",
    );
    p.elements = [{ index: 1, tag: "button", shadow: { hosts: [""] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.hosts[0] must be a non-empty string of at most 500 characters",
    );
  });

  it("rejects overlong shadow.hosts lists and entries", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", shadow: { hosts: ["#a", "#b", "#c", "#d", "#e", "#f", "#g", "#h", "#i"] } },
    ];
    assert.equal(validatePayload(p), "elements[0].shadow.hosts must have at most 8 entries");
    p.elements = [{ index: 1, tag: "button", shadow: { hosts: ["#" + "x".repeat(501)] } }];
    assert.equal(
      validatePayload(p),
      "elements[0].shadow.hosts[0] must be a non-empty string of at most 500 characters",
    );
  });

  // ---- Schema v1.8 (F2 anchor resilience): optional anchor metadata ----

  it("accepts elements with valid anchor metadata (schema v1.8)", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", anchor: { version: 1, resolution: "exact", confidence: 1 } },
      {
        index: 2,
        tag: "button",
        anchor: { version: 1, resolution: "fallback", confidence: 0.95, fallback: ["attrs"] },
      },
      {
        index: 3,
        tag: "span",
        anchor: { version: 1, resolution: "fallback", confidence: 0.85, fallback: ["text"] },
      },
      {
        index: 4,
        tag: "span",
        anchor: { version: 1, resolution: "fallback", confidence: 0.7, fallback: ["rect"] },
      },
      {
        index: 5,
        tag: "div",
        anchor: {
          version: 1,
          resolution: "fallback",
          confidence: 0.95,
          fallback: ["attrs", "text", "aria", "rect"],
        },
      },
      { index: 6, tag: "div", anchor: { version: 1, resolution: "unresolved", confidence: 0 } },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts anchor metadata combined with frame, shadow, intent, and severity", () => {
    const p = payload();
    p.elements = [
      {
        index: 1,
        tag: "span",
        intent: "fix",
        severity: "blocking",
        frame: { path: [0, 1] },
        shadow: { depth: 1, hosts: ["#host-a"] },
        anchor: { version: 1, resolution: "fallback", confidence: 0.85, fallback: ["text"] },
      },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts legacy elements without anchor metadata (backward compatible)", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", cssPath: "html body button" }];
    assert.equal(validatePayload(p), null);
  });

  it("rejects a non-object anchor", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", anchor: "exact" }];
    assert.equal(validatePayload(p), "elements[0].anchor must be an object");
  });

  it("rejects unknown nested anchor keys", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", anchor: { version: 1, resolution: "exact", signal: "id" } },
    ];
    assert.equal(validatePayload(p), "elements[0].anchor has unknown key 'signal'");
  });

  it("rejects a wrong or missing anchor.version", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", anchor: { version: 2, resolution: "exact" } }];
    assert.equal(validatePayload(p), "elements[0].anchor.version must be 1");
    p.elements = [{ index: 1, tag: "button", anchor: { version: "1", resolution: "exact" } }];
    assert.equal(validatePayload(p), "elements[0].anchor.version must be 1");
    p.elements = [{ index: 1, tag: "button", anchor: { resolution: "exact" } }];
    assert.equal(validatePayload(p), "elements[0].anchor.version must be 1");
  });

  it("rejects unknown and non-string anchor.resolution values", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", anchor: { version: 1, resolution: "moved" } },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.resolution must be one of exact, fallback, unresolved",
    );
    p.elements = [{ index: 1, tag: "button", anchor: { version: 1, resolution: 1 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.resolution must be one of exact, fallback, unresolved",
    );
    p.elements = [{ index: 1, tag: "button", anchor: { version: 1 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.resolution must be one of exact, fallback, unresolved",
    );
  });

  it("rejects out-of-range and non-number anchor.confidence", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", anchor: { version: 1, resolution: "exact", confidence: 1.5 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.confidence must be a number from 0 to 1",
    );
    p.elements = [{ index: 1, tag: "button", anchor: { version: 1, resolution: "exact", confidence: -0.1 } }];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.confidence must be a number from 0 to 1",
    );
    p.elements = [{ index: 1, tag: "button", anchor: { version: 1, resolution: "exact", confidence: "high" } }];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.confidence must be a number from 0 to 1",
    );
  });

  it("rejects empty, overlong, and unknown anchor.fallback lists", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", anchor: { version: 1, resolution: "fallback", fallback: [] } },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.fallback must be a non-empty list of at most 4 signals",
    );
    p.elements = [
      {
        index: 1,
        tag: "button",
        anchor: { version: 1, resolution: "fallback", fallback: ["attrs", "text", "aria", "rect", "id"] },
      },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.fallback must be a non-empty list of at most 4 signals",
    );
    p.elements = [
      {
        index: 1,
        tag: "button",
        anchor: { version: 1, resolution: "fallback", fallback: ["class"] },
      },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.fallback[0] must be one of attrs, text, aria, rect",
    );
    p.elements = [
      {
        index: 1,
        tag: "button",
        anchor: { version: 1, resolution: "fallback", fallback: "attrs" },
      },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].anchor.fallback must be a non-empty list of at most 4 signals",
    );
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

  it("accepts a full captureState object (schema v1.6)", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: true,
      hoveredSelector: "p#format-me",
      activeElementSelector: "input#big-input",
      openDetailsSelectors: ["#open-me"],
    };
    assert.equal(validatePayload(p), null);
  });

  it("accepts captureState with null selectors and empty details list", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: false,
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: [],
    };
    assert.equal(validatePayload(p), null);
  });

  it("accepts captureState with only animationsFrozen", () => {
    const p = payload();
    p.captureState = { animationsFrozen: true };
    assert.equal(validatePayload(p), null);
  });

  it("accepts legacy payloads without captureState (backward compatible)", () => {
    const p = payload();
    assert.equal(validatePayload(p), null);
    assert.equal("captureState" in p, false);
  });

  it("rejects unknown captureState keys", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: true,
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: [],
      bogusKey: "x",
    };
    assert.equal(
      validatePayload(p),
      "captureState has unknown key 'bogusKey'",
    );
  });

  it("rejects non-boolean animationsFrozen", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: "true",
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: [],
    };
    assert.equal(
      validatePayload(p),
      "captureState.animationsFrozen must be a boolean",
    );
  });

  it("rejects captureState missing animationsFrozen", () => {
    const p = payload();
    p.captureState = {
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: [],
    };
    assert.equal(
      validatePayload(p),
      "captureState.animationsFrozen must be a boolean",
    );
  });

  it("rejects non-string hoveredSelector", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: true,
      hoveredSelector: 42,
      activeElementSelector: null,
      openDetailsSelectors: [],
    };
    assert.equal(
      validatePayload(p),
      "captureState.hoveredSelector must be a string or null",
    );
  });

  it("rejects non-list openDetailsSelectors", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: true,
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: "#open-me",
    };
    assert.equal(
      validatePayload(p),
      "captureState.openDetailsSelectors must be a list",
    );
  });

  it("rejects non-string entries in openDetailsSelectors", () => {
    const p = payload();
    p.captureState = {
      animationsFrozen: true,
      hoveredSelector: null,
      activeElementSelector: null,
      openDetailsSelectors: ["#ok", 7],
    };
    assert.equal(
      validatePayload(p),
      "captureState.openDetailsSelectors[1] must be a string",
    );
  });

  it("rejects a non-object captureState", () => {
    const p = payload();
    p.captureState = ["animationsFrozen", true];
    assert.equal(validatePayload(p), "captureState must be an object");
  });

  // ---- Schema v1.9 (F4): optional env snapshot, textQuote, thread fields ----

  it("accepts a valid env block (schema v1.9)", () => {
    const p = payload();
    p.env = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://example.test/page",
      viewport: { w: 1500, h: 993 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/137.0",
      language: "en-US",
      devicePixelRatio: 2,
      timezoneOffsetMinutes: -420,
    };
    assert.equal(validatePayload(p), null);
  });

  it("accepts env with a positive offset and fractional millisecond timestamp", () => {
    const p = payload();
    p.env = {
      capturedAt: "2026-08-12T12:00:00.123Z",
      url: "https://example.test/page",
      viewport: { w: 1280, h: 720 },
      userAgent: "ua",
      language: "de-DE",
      devicePixelRatio: 1,
      timezoneOffsetMinutes: 540,
    };
    assert.equal(validatePayload(p), null);
  });

  it("accepts env combined with textQuote, threadId, and parentId", () => {
    const p = payload();
    p.env = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://example.test/page",
      viewport: { w: 1500, h: 993 },
      userAgent: "ua",
      language: "en-US",
      devicePixelRatio: 1,
      timezoneOffsetMinutes: 0,
    };
    p.textQuote = {
      quote: "Button contrast looks off",
      prefix: "The checkout",
      suffix: "on the cart page",
    };
    p.threadId = "thr-20260812-0001";
    p.parentId = "item-2";
    assert.equal(validatePayload(p), null);
  });

  it("accepts per-element textQuote (schema v1.9)", () => {
    const p = payload();
    p.elements = [
      {
        index: 1,
        tag: "span",
        textQuote: { quote: "normalized quote", prefix: "before", suffix: "after" },
      },
      { index: 2, tag: "span", textQuote: { quote: "bare quote" } },
    ];
    assert.equal(validatePayload(p), null);
  });

  it("accepts legacy v1.8 payloads without env/textQuote/thread fields (backward compatible)", () => {
    const p = payload();
    assert.equal(validatePayload(p), null);
    assert.equal("env" in p, false);
    assert.equal("textQuote" in p, false);
    assert.equal("threadId" in p, false);
  });

  it("rejects a non-object env", () => {
    const p = payload();
    p.env = "chrome";
    assert.equal(validatePayload(p), "env must be an object");
    const q = payload();
    q.env = null;
    assert.equal(validatePayload(q), "env must be an object");
  });

  it("rejects unknown env keys", () => {
    const p = payload();
    p.env = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://x",
      viewport: { w: 100, h: 100 },
      userAgent: "ua",
      language: "en",
      devicePixelRatio: 1,
      timezoneOffsetMinutes: 0,
      os: "macOS",
    };
    assert.equal(validatePayload(p), "env has unknown key 'os'");
  });

  it("rejects invalid env.capturedAt timestamps", () => {
    for (const bad of ["not-a-date", "2026-13-99T99:99:99Z", "2026-08-12", 1723400000000, ""]) {
      const p = payload();
      p.env = {
        capturedAt: bad,
        url: "https://x",
        viewport: { w: 100, h: 100 },
        userAgent: "ua",
        language: "en",
        devicePixelRatio: 1,
        timezoneOffsetMinutes: 0,
      };
      assert.equal(
        validatePayload(p),
        "env.capturedAt must be an ISO-8601 timestamp",
        `capturedAt=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects env missing required fields", () => {
    const p = payload();
    p.env = { capturedAt: "2026-08-12T12:00:00.000Z" };
    assert.equal(
      validatePayload(p),
      "env.url must be a non-empty string of at most 2048 characters",
    );
    const q = payload();
    q.env = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://x",
      viewport: { w: 100, h: 100 },
      userAgent: "ua",
      language: "en",
      devicePixelRatio: 1,
    };
    assert.equal(
      validatePayload(q),
      "env.timezoneOffsetMinutes must be an integer from -840 to 840",
    );
  });

  it("rejects invalid env.viewport bounds", () => {
    for (const vp of [{ w: 0, h: 100 }, { w: 1.5, h: 100 }, { w: 100, h: -1 }, "100x100"]) {
      const p = payload();
      p.env = {
        capturedAt: "2026-08-12T12:00:00.000Z",
        url: "https://x",
        viewport: vp,
        userAgent: "ua",
        language: "en",
        devicePixelRatio: 1,
        timezoneOffsetMinutes: 0,
      };
      const err = validatePayload(p);
      assert.ok(err !== null, `viewport=${JSON.stringify(vp)}`);
      assert.match(err!, /env\.viewport/);
    }
  });

  it("rejects invalid env.devicePixelRatio values", () => {
    for (const dpr of [0, -1, "2", Number.NaN]) {
      const p = payload();
      p.env = {
        capturedAt: "2026-08-12T12:00:00.000Z",
        url: "https://x",
        viewport: { w: 100, h: 100 },
        userAgent: "ua",
        language: "en",
        devicePixelRatio: dpr,
        timezoneOffsetMinutes: 0,
      };
      assert.equal(
        validatePayload(p),
        "env.devicePixelRatio must be a positive number",
        `dpr=${JSON.stringify(dpr)}`,
      );
    }
  });

  it("rejects out-of-range and non-integer env.timezoneOffsetMinutes", () => {
    for (const tz of [841, -841, 1.5, "0"]) {
      const p = payload();
      p.env = {
        capturedAt: "2026-08-12T12:00:00.000Z",
        url: "https://x",
        viewport: { w: 100, h: 100 },
        userAgent: "ua",
        language: "en",
        devicePixelRatio: 1,
        timezoneOffsetMinutes: tz,
      };
      assert.equal(
        validatePayload(p),
        "env.timezoneOffsetMinutes must be an integer from -840 to 840",
        `tz=${JSON.stringify(tz)}`,
      );
    }
  });

  it("rejects oversized env strings", () => {
    const base = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://x",
      viewport: { w: 100, h: 100 },
      userAgent: "ua",
      language: "en",
      devicePixelRatio: 1,
      timezoneOffsetMinutes: 0,
    };
    const longUrl = payload();
    longUrl.env = { ...base, url: "u".repeat(2049) };
    assert.equal(
      validatePayload(longUrl),
      "env.url must be a non-empty string of at most 2048 characters",
    );
    const longUa = payload();
    longUa.env = { ...base, userAgent: "a".repeat(513) };
    assert.equal(
      validatePayload(longUa),
      "env.userAgent must be a non-empty string of at most 512 characters",
    );
    const longLang = payload();
    longLang.env = { ...base, language: "l".repeat(65) };
    assert.equal(
      validatePayload(longLang),
      "env.language must be a non-empty string of at most 64 characters",
    );
    const emptyUa = payload();
    emptyUa.env = { ...base, userAgent: "" };
    assert.equal(
      validatePayload(emptyUa),
      "env.userAgent must be a non-empty string of at most 512 characters",
    );
  });

  it("accepts textQuote with quote only and with prefix/suffix (schema v1.9)", () => {
    const p = payload();
    p.textQuote = { quote: "normalized quote" };
    assert.equal(validatePayload(p), null);
    const q = payload();
    q.textQuote = { quote: "q", prefix: "before", suffix: "after" };
    assert.equal(validatePayload(q), null);
  });

  it("rejects a non-object textQuote", () => {
    const p = payload();
    p.textQuote = "quote";
    assert.equal(validatePayload(p), "textQuote must be an object");
    const q = payload();
    q.textQuote = null;
    assert.equal(validatePayload(q), "textQuote must be an object");
  });

  it("rejects unknown textQuote keys", () => {
    const p = payload();
    p.textQuote = { quote: "q", context: "x" };
    assert.equal(validatePayload(p), "textQuote has unknown key 'context'");
    const el = payload();
    el.elements = [{ index: 1, tag: "span", textQuote: { quote: "q", mode: "x" } }];
    assert.equal(
      validatePayload(el),
      "elements[0].textQuote has unknown key 'mode'",
    );
  });

  it("rejects missing, empty, and oversized textQuote.quote", () => {
    const missing = payload();
    missing.textQuote = { prefix: "p" };
    assert.equal(
      validatePayload(missing),
      "textQuote.quote must be a non-empty string of at most 5000 characters",
    );
    const empty = payload();
    empty.textQuote = { quote: "" };
    assert.equal(
      validatePayload(empty),
      "textQuote.quote must be a non-empty string of at most 5000 characters",
    );
    const long = payload();
    long.textQuote = { quote: "q".repeat(5001) };
    assert.equal(
      validatePayload(long),
      "textQuote.quote must be a non-empty string of at most 5000 characters",
    );
    const el = payload();
    el.elements = [{ index: 1, tag: "span", textQuote: {} }];
    assert.equal(
      validatePayload(el),
      "elements[0].textQuote.quote must be a non-empty string of at most 5000 characters",
    );
  });

  it("rejects oversized and non-string textQuote prefix/suffix", () => {
    const longPrefix = payload();
    longPrefix.textQuote = { quote: "q", prefix: "p".repeat(501) };
    assert.equal(
      validatePayload(longPrefix),
      "textQuote.prefix must be a string of at most 500 characters",
    );
    const numSuffix = payload();
    numSuffix.textQuote = { quote: "q", suffix: 42 };
    assert.equal(
      validatePayload(numSuffix),
      "textQuote.suffix must be a string of at most 500 characters",
    );
    const el = payload();
    el.elements = [{ index: 1, tag: "span", textQuote: { quote: "q", prefix: 7 } }];
    assert.equal(
      validatePayload(el),
      "elements[0].textQuote.prefix must be a string of at most 500 characters",
    );
  });

  it("rejects non-string, empty, and oversized threadId", () => {
    for (const value of [42, "", "t".repeat(101)]) {
      const p = payload();
      p.threadId = value;
      assert.equal(
        validatePayload(p),
        "threadId must be a non-empty string of at most 100 characters",
        `threadId=${JSON.stringify(value)}`,
      );
    }
  });

  it("rejects non-string, empty, and oversized parentId", () => {
    for (const value of [7, "", "p".repeat(101)]) {
      const p = payload();
      p.parentId = value;
      assert.equal(
        validatePayload(p),
        "parentId must be a non-empty string of at most 100 characters",
        `parentId=${JSON.stringify(value)}`,
      );
    }
  });

  it("accepts threadId and parentId independently (schema v1.9)", () => {
    const p = payload();
    p.threadId = "thr-1";
    assert.equal(validatePayload(p), null);
    const q = payload();
    q.parentId = "item-2";
    assert.equal(validatePayload(q), null);
  });

  // H12: negative element indices rejected.
  it("rejects negative element index", () => {
    const p = payload();
    p.elements = [{ index: -5, tag: "button" }];
    assert.equal(
      validatePayload(p),
      "elements[0].index must be a non-negative integer",
    );
  });

  // H15: text caps enforced hub-side (matching extension MAX_INSTR/MAX_TEXT).
  it("rejects overlong element instruction", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", instruction: "x".repeat(501) }];
    assert.equal(
      validatePayload(p),
      "elements[0].instruction must be at most 500 characters",
    );
  });

  it("rejects overlong element text", () => {
    const p = payload();
    p.elements = [{ index: 1, tag: "button", text: "x".repeat(201) }];
    assert.equal(
      validatePayload(p),
      "elements[0].text must be at most 200 characters",
    );
  });

  it("rejects overlong edits values", () => {
    const p = payload();
    p.elements = [
      { index: 1, tag: "button", edits: { fontSize: "x".repeat(501) } },
    ];
    assert.equal(
      validatePayload(p),
      "elements[0].edits.fontSize must be at most 500 characters",
    );
  });

  it("rejects overlong title", () => {
    assert.equal(
      validatePayload({ ...payload(), title: "x".repeat(501) }),
      "title must be at most 500 characters",
    );
  });

  it("rejects overlong note and notes entries", () => {
    assert.equal(
      validatePayload({ ...payload(), note: "x".repeat(201) }),
      "note must be at most 200 characters",
    );
    assert.equal(
      validatePayload({ ...payload(), notes: ["ok", "x".repeat(201)] }),
      "notes[1] must be at most 200 characters",
    );
  });

  it("rejects too many notes entries", () => {
    const p = payload();
    p.notes = Array.from({ length: 21 }, () => "n");
    assert.equal(
      validatePayload(p),
      "notes must have at most 20 entries",
    );
  });

  it("accepts caps-at-limit text values", () => {
    const p = payload();
    p.title = "x".repeat(500);
    p.note = "x".repeat(200);
    p.notes = Array.from({ length: 20 }, () => "x".repeat(200));
    p.elements = [
      {
        index: 0,
        tag: "button",
        text: "x".repeat(200),
        instruction: "x".repeat(500),
        edits: { width: "x".repeat(500) },
      },
    ];
    assert.equal(validatePayload(p), null);
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
