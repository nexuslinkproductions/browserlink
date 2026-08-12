/**
 * Deterministic Markdown brief for one stored annotation (Copy AI Brief).
 *
 * Pure formatting helper: same annotation JSON + filename always produces
 * the same Markdown. Values are written as-is (no HTML-style escaping; the
 * brief is plain Markdown text), so annotation content survives verbatim.
 * No U+2014 em-dashes anywhere in this file.
 */

import type { JsonObject } from "./schema.ts";

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lines(parts: string[]): string {
  return parts.join("\n");
}

/**
 * Format one stored annotation as an AI-oriented Markdown brief.
 *
 * @param annotation - the parsed annotation JSON object
 * @param name - the annotation's JSON filename (e.g. `20260812-123456-789.json`)
 * @param baseDir - optional annotations directory used to build absolute
 *   @file / @image references (hub passes annotationsDir()); when omitted,
 *   references stay relative to the annotation filename.
 */
export function formatAnnotationMarkdown(
  annotation: JsonObject,
  name: string,
  baseDir?: string,
): string {
  const url = stringOf(annotation.url);
  const title = stringOf(annotation.title);
  const label = stringOf(annotation.label);

  // Notes: prefer the committed notes queue ('notes'), fall back to the
  // legacy joined 'note' string.
  const notes: string[] = [];
  if (Array.isArray(annotation.notes)) {
    for (const n of annotation.notes) {
      const s = stringOf(n).trim();
      if (s) notes.push(s);
    }
  }
  if (notes.length === 0) {
    const legacy = stringOf(annotation.note).trim();
    if (legacy) notes.push(legacy);
  }

  const strokes = Array.isArray(annotation.strokes) ? annotation.strokes : [];
  const elements = Array.isArray(annotation.elements)
    ? annotation.elements
    : [];
  const screenshotFile = stringOf(annotation.screenshotFile);

  const out: string[] = ["# AI Brief"];

  out.push("", "## Page");
  out.push(`- URL: ${url}`);
  out.push(`- Title: ${title || "(none)"}`);
  const viewport = annotation.viewport;
  if (
    viewport !== null &&
    typeof viewport === "object" &&
    !Array.isArray(viewport)
  ) {
    const vp = viewport as JsonObject;
    out.push(
      `- Viewport: ${typeof vp.w === "number" ? vp.w : "?"}x${typeof vp.h === "number" ? vp.h : "?"}`,
    );
  }

  out.push("", "## Label");
  out.push(label || "(none)");

  out.push("", "## Notes");
  if (notes.length > 0) {
    for (const n of notes) out.push(`- ${n}`);
  } else {
    out.push("None.");
  }

  out.push("", "## Elements");
  if (elements.length > 0) {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el === null || typeof el !== "object" || Array.isArray(el)) continue;
      const record = el as JsonObject;
      const index =
        typeof record.index === "number" ? record.index : i + 1;
      out.push("", `### Element ${index}`);
      if (record.tag !== undefined && record.tag !== null) {
        out.push(`- Tag: ${stringOf(record.tag)}`);
      }
      if (record.cssPath !== undefined && record.cssPath !== null) {
        out.push(`- CSS path: \`${stringOf(record.cssPath)}\``);
      }
      if (record.text !== undefined && record.text !== null) {
        const text = stringOf(record.text).trim();
        if (text) out.push(`- Text: ${text}`);
      }
      if (record.instruction !== undefined && record.instruction !== null) {
        out.push(`- Instruction: ${stringOf(record.instruction)}`);
      }
      const edits = record.edits;
      if (edits !== null && typeof edits === "object" && !Array.isArray(edits)) {
        const entries = Object.entries(edits as Record<string, unknown>);
        if (entries.length > 0) {
          out.push("- Edits:");
          for (const [key, value] of entries) {
            out.push(`  - ${key}: ${stringOf(value)}`);
          }
        }
      }
      // Schema v1.6: wire key is `severity`, user-facing label is Priority
      // (same wording as the Hermes adapter message).
      if (record.intent !== undefined && record.intent !== null) {
        out.push(`- Intent: ${stringOf(record.intent)}`);
      }
      if (record.severity !== undefined && record.severity !== null) {
        out.push(`- Priority: ${stringOf(record.severity)}`);
      }
    }
  } else {
    out.push("None.");
  }

  const captureState = annotation.captureState;
  if (
    captureState !== null &&
    typeof captureState === "object" &&
    !Array.isArray(captureState)
  ) {
    const cs = captureState as JsonObject;
    out.push("", "## Capture State");
    out.push(
      `- Animations frozen: ${cs.animationsFrozen === true ? "true" : "false"}`,
    );
    out.push(
      `- Hovered selector: ${stringOf(cs.hoveredSelector ?? "null")}`,
    );
    out.push(
      `- Active element selector: ${stringOf(cs.activeElementSelector ?? "null")}`,
    );
    const openDetails = Array.isArray(cs.openDetailsSelectors)
      ? (cs.openDetailsSelectors as unknown[])
      : [];
    out.push(
      openDetails.length > 0
        ? `- Open details selectors: ${openDetails.map(stringOf).join(", ")}`
        : "- Open details selectors: none",
    );
  }

  out.push("", "## Strokes");
  out.push(`- Count: ${strokes.length}`);
  const colors = new Set<string>();
  for (const stroke of strokes) {
    if (
      stroke !== null &&
      typeof stroke === "object" &&
      !Array.isArray(stroke)
    ) {
      const color = (stroke as JsonObject).color;
      if (typeof color === "string" && color) colors.add(color);
    }
  }
  if (colors.size > 0) {
    out.push(`- Colors: ${Array.from(colors).join(", ")}`);
  }

  const prefix = baseDir ? `${baseDir.replace(/\/+$/, "")}/` : "";
  out.push("", "## Files");
  out.push(`- Annotation: \`${name}\``);
  out.push(`- @file:${prefix}${name}`);
  if (screenshotFile) {
    out.push(`- Screenshot: \`${screenshotFile}\``);
    out.push(`- @image:${prefix}${screenshotFile}`);
  }

  return lines(out) + "\n";
}
