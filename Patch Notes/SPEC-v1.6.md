# SPEC v1.6 - Inspector categories, hover boxes, editor-highlight exclusion

Deterministic build spec. Extension-only wave: `extension/content.js` + `extension/overlay.css`.
No Python, no MCP, no README/CHANGELOG, no git. `node --check` must pass. All existing
test hooks (`window.__BL_TEST__` → `__BL_INSPECTOR__` / `__BL_TEST_API__`) must be preserved.

## Feature A - Collapsible inspector categories

The inspector (`renderInspector`, rows in `inspRows`) currently renders every property
row flat, forcing scroll. Group rows by category with collapsible headers.

- Categories (map each property key to exactly one):
  - **Text**: fontSize, fontFamily, fontWeight, lineHeight, color, textAlign,
    textTransform, letterSpacing, wordSpacing, whiteSpace, textDecoration, fontStyle,
    textShadow, verticalAlign
  - **Layout**: display, position, width, height, margin, padding, flex, flexDirection,
    justifyContent, alignItems, gap, grid, zIndex, overflow, float, clear
  - **Appearance**: background, backgroundColor, border, borderRadius, borderWidth,
    borderColor, boxShadow, opacity, transform, transition, cursor
  - **Other**: any property not in the above
- Each category renders as a header row (label + chevron) followed by its rows.
  Clicking the header toggles collapse/expand. Collapsed hides the rows (header stays).
- Default state: expanded. Collapse state persists per tab via `saveTabState`
  (`collapsedCats: {Text: true, ...}`) and is restored in `restoreTabState`.
- Chevron rotates 90deg when collapsed (CSS transition, `prefers-reduced-motion` honored).
- Must not break: `getRows`, `applyLive`, `recordEdit`, `restoreProp`, per-row Reset,
  Reset All, selection list, instruction input, editor rows, `onInspectorInput`,
  `onInspectorFormatClick`, `onInspectorReset`, pointer-over/focus hints.
- `getRows` must still return ALL rows (collapsed is a view concern only).

## Feature B - Hover boxes in element mode

In element mode, hovering must make it obvious an element is there BEFORE clicking.

- On hover, draw a clear box around the element under the cursor: solid outline
  (2px, `SEL_COLOR`-adjacent accent) + very subtle fill tint, matching the element's
  live `getBoundingClientRect()`.
- The box must track scroll and resize (reuse the existing reposition/scroll handling;
  recompute on `scroll` and `resize` while hovering).
- Keep the existing lerped hover highlight; the box is the stronger, unambiguous
  signal. Both may coexist; the box must be clearly visible (not washed out).
- No perf regression: one rAF-throttled recompute per scroll/resize while hovering;
  no per-frame layout thrash (cache the rect, invalidate on scroll/resize).
- The box must not appear in annotate mode, only element mode.

## Feature C - Property-hint highlight excludes editor UI

Hovering a property row highlights what it affects on the page (`drawPropertyHint`).
It must NEVER highlight elements inside the inspector/editor itself (the editor's
textarea, format buttons, align controls, the inspector panel, the toolbar, the chip).

- Skip any target that is a descendant of the shadow host or carries
  `comet-insp-*` / `comet-toolbar` / `comet-chat-*` classes (or is the host itself).
- The hint should also skip elements whose rect is fully inside the inspector panel
  rect (belt and braces).

## Acceptance (verifier will test)

1. Categories render with headers; collapse/expand works; state persists across
   reopen within a tab; `getRows` returns all rows regardless of collapse.
2. Element mode hover shows a clear box; box updates on scroll/resize; no box in
   annotate mode.
3. Property-hint never highlights editor-internal elements (checked by opening the
   inspector on an element, hovering a property row, and asserting the highlighted
   target is not inside the shadow host).
4. `node --check` passes on content.js; all existing `__BL_TEST__` hooks intact.
5. No changes outside `extension/content.js` and `extension/overlay.css`.

## Constraints

- Match existing code style (const-first, existing helper reuse, no new deps).
- Do not touch the send path, the payload schema, or the hub contract.
- Do not run git. Do not modify any other file.
