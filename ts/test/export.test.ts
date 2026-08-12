import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatAnnotationMarkdown } from "../src/markdown.ts";
import type { JsonObject } from "../src/schema.ts";

/** Complete fixture: elements with edits + intent/severity, notes, strokes,
 * capture state, and a stored screenshot. */
function fixtureAnnotation(): JsonObject {
  return {
    source: "comet-extension",
    url: "https://example.test/shop/cart",
    title: "Cart page",
    viewport: { w: 1440, h: 900 },
    label: "Checkout flow",
    notes: ["Button contrast looks off", "Hero animation stutters"],
    strokes: [
      { color: "#4a9eff", width: 4, points: [[0.1, 0.2], [0.3, 0.4]] },
      { color: "#ff5252", width: 2, points: [[0.5, 0.5], [0.6, 0.6]] },
    ],
    elements: [
      {
        index: 1,
        tag: "button",
        cssPath: "html body div#app button.checkout",
        text: "Checkout",
        instruction: "Widen the hit area and increase contrast",
        intent: "fix",
        severity: "blocking",
        edits: {
          backgroundColor: "#1a73e8",
          padding: "16px 24px",
          fontSize: "18px",
        },
      },
      {
        index: 2,
        tag: "h1",
        cssPath: "html body div#app h1.hero",
        text: "Your cart",
        instruction: "Keep the heading, tweak the tracking",
        intent: "change",
        severity: "suggestion",
        edits: { letterSpacing: "0.02em" },
      },
    ],
    captureState: {
      animationsFrozen: true,
      hoveredSelector: "button.checkout",
      activeElementSelector: null,
      openDetailsSelectors: ["details.shipping"],
    },
    env: {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://example.test/shop/cart",
      viewport: { w: 1440, h: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0 Safari/537.36",
      language: "en-US",
      devicePixelRatio: 2,
      timezoneOffsetMinutes: -420,
    },
    textQuote: {
      quote: "Button contrast looks off",
      prefix: "The checkout",
      suffix: "on the cart page",
    },
    screenshotFile: "20260812-120000-000.png",
  };
}

describe("formatAnnotationMarkdown", () => {
  test("renders page context, elements, edits, intent/priority, notes, strokes, and refs", () => {
    const md = formatAnnotationMarkdown(
      fixtureAnnotation(),
      "20260812-120000-000.json",
      "/tmp/bl-f4-data/annotations",
    );
    assert.ok(md.startsWith("# AI Brief\n"));
    assert.match(md, /## Page/);
    assert.match(md, /- URL: https:\/\/example\.test\/shop\/cart/);
    assert.match(md, /- Title: Cart page/);
    assert.match(md, /- Viewport: 1440x900/);
    assert.match(md, /## Label/);
    assert.match(md, /Checkout flow/);
    assert.match(md, /## Notes/);
    assert.match(md, /- Button contrast looks off/);
    assert.match(md, /- Hero animation stutters/);
    // Element blocks: cssPath, text, instruction, intent/priority, edits.
    assert.match(md, /### Element 1/);
    assert.match(md, /- Tag: button/);
    assert.match(md, /- CSS path: `html body div#app button\.checkout`/);
    assert.match(md, /- Text: Checkout/);
    assert.match(md, /- Instruction: Widen the hit area and increase contrast/);
    assert.match(md, /- Intent: fix/);
    assert.match(md, /- Priority: blocking/);
    assert.match(md, /- Edits:/);
    assert.match(md, /  - backgroundColor: #1a73e8/);
    assert.match(md, /  - padding: 16px 24px/);
    assert.match(md, /  - fontSize: 18px/);
    assert.match(md, /### Element 2/);
    assert.match(md, /- Intent: change/);
    assert.match(md, /- Priority: suggestion/);
    assert.match(md, /  - letterSpacing: 0\.02em/);
    // Capture state.
    assert.match(md, /## Capture State/);
    assert.match(md, /- Animations frozen: true/);
    assert.match(md, /- Hovered selector: button\.checkout/);
    assert.match(md, /- Open details selectors: details\.shipping/);
    // Schema v1.9: Agent context renders the env snapshot one-to-one.
    assert.match(md, /## Agent Context/);
    assert.match(md, /- Captured at: 2026-08-12T12:00:00\.000Z/);
    assert.match(md, /- User agent: Mozilla\/5\.0/);
    assert.match(md, /- Language: en-US/);
    assert.match(md, /- Device pixel ratio: 2/);
    assert.match(md, /- Timezone offset \(minutes\): -420/);
    // Schema v1.9: Reproduction context with selector, text quote, screenshot.
    assert.match(md, /## Reproduction Context/);
    assert.match(md, /- Selector: `html body div#app button\.checkout`/);
    assert.match(md, /- Text quote: Button contrast looks off/);
    assert.match(md, /- Quote prefix: The checkout/);
    assert.match(md, /- Quote suffix: on the cart page/);
    assert.match(md, /- Screenshot file: `20260812-120000-000\.png`/);
    // Strokes summary.
    assert.match(md, /## Strokes/);
    assert.match(md, /- Count: 2/);
    assert.match(md, /- Colors: #4a9eff, #ff5252/);
    // File references: JSON @file + PNG @image with the base dir.
    assert.match(md, /## Files/);
    assert.match(md, /- Annotation: `20260812-120000-000\.json`/);
    assert.match(md, /- @file:\/tmp\/bl-f4-data\/annotations\/20260812-120000-000\.json/);
    assert.match(md, /- Screenshot: `20260812-120000-000\.png`/);
    assert.match(md, /- @image:\/tmp\/bl-f4-data\/annotations\/20260812-120000-000\.png/);
  });

  test("is deterministic for the same input", () => {
    const a = formatAnnotationMarkdown(fixtureAnnotation(), "a.json");
    const b = formatAnnotationMarkdown(fixtureAnnotation(), "a.json");
    assert.equal(a, b);
  });

  test("annotation without a screenshot omits the @image reference", () => {
    const annotation = fixtureAnnotation();
    delete annotation.screenshotFile;
    const md = formatAnnotationMarkdown(annotation, "a.json");
    assert.ok(!md.includes("@image:"));
    assert.match(md, /- @file:a\.json/);
    assert.match(md, /## Files/);
  });

  test("legacy single 'note' string is used when 'notes' is absent", () => {
    const annotation = fixtureAnnotation();
    delete annotation.notes;
    annotation.note = "legacy note text";
    const md = formatAnnotationMarkdown(annotation, "a.json");
    assert.match(md, /- legacy note text/);
  });

  test("agent context and reproduction context render explicit omitted states when env is absent", () => {
    const annotation = fixtureAnnotation();
    delete annotation.env;
    delete annotation.textQuote;
    delete annotation.screenshotFile;
    const md = formatAnnotationMarkdown(annotation, "a.json");
    assert.match(md, /## Agent Context/);
    assert.match(md, /- Captured at: \(omitted\)/);
    assert.match(md, /- URL: \(omitted\)/);
    assert.match(md, /- Viewport: \(omitted\)/);
    assert.match(md, /- User agent: \(omitted\)/);
    assert.match(md, /- Language: \(omitted\)/);
    assert.match(md, /- Device pixel ratio: \(omitted\)/);
    assert.match(md, /- Timezone offset \(minutes\): \(omitted\)/);
    assert.match(md, /## Reproduction Context/);
    assert.match(md, /- Selector: `html body div#app button\.checkout`/);
    assert.match(md, /- Text quote: \(omitted\)/);
    assert.match(md, /- Screenshot file: \(omitted\)/);
  });

  test("partial env values render omitted, never fabricated", () => {
    const annotation = fixtureAnnotation();
    annotation.env = {
      capturedAt: "2026-08-12T12:00:00.000Z",
      url: "https://example.test/shop/cart",
      viewport: { w: 1440, h: 900 },
      userAgent: "Mozilla/5.0",
      language: "en-US",
    };
    const md = formatAnnotationMarkdown(annotation, "a.json");
    assert.match(md, /- Device pixel ratio: \(omitted\)/);
    assert.match(md, /- Timezone offset \(minutes\): \(omitted\)/);
    assert.ok(!md.includes("- Device pixel ratio: 2"));
    assert.ok(!md.includes("- Timezone offset (minutes): -420"));
  });

  test("thread fields are not rendered by the formatter (F8 owns threads)", () => {
    const annotation = fixtureAnnotation();
    annotation.threadId = "thr-1";
    annotation.parentId = "item-2";
    const md = formatAnnotationMarkdown(annotation, "a.json");
    assert.ok(!md.includes("thr-1"));
    assert.ok(!md.includes("item-2"));
    assert.ok(md.startsWith("# AI Brief"));
  });

  test("no U+2014 em-dash characters in the output", () => {
    const md = formatAnnotationMarkdown(fixtureAnnotation(), "a.json");
    assert.ok(!md.includes("\u2014"));
  });
});
