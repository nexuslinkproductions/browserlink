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
