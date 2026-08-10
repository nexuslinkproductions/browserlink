# browserlink v1.4 — Attachment Delivery (screenshot + annotation file land in chat)

Repo: /Users/marcelspatz/browserlink. Ships as its own PR (feat/attachments-v1.4 -> main),
tag v1.4.0 after merge.

Problem: annotations land in the target chat as plain text only. The Hermes
desktop renders `@image:<path>` directive lines as an attachments row (image
thumbnail) and `@file:<path>` tokens as file chips (apps/desktop/src/lib/
chat-messages.ts + embedded-images.ts). Deliver both so the annotation lands
as a real attachment.

## File ownership (single worker)
extension/service-worker.js, server/hub.py, server/adapters/hermes.py,
docs/protocol.md, CHANGELOG.md, tests/test_hub.py, tests/test_hermes.py (new
if cleaner). No git. No hermes config. Do NOT touch content.js/overlay.css.

## Requirements
1. EXTENSION (extension/service-worker.js): in the `annotate` handler, before
   POSTing, call `chrome.tabs.captureVisibleTab(null, {format: 'png'})` (activeTab
   permission covers it; the user has interacted with the page). On success,
   add `screenshot: <dataURL>` to the payload. On any failure, proceed WITHOUT
   the screenshot (annotation must never be blocked by capture).
2. HUB (server/hub.py): accept optional `screenshot` field: must be a string
   starting with `data:image/png;base64,` (else 400), max 10MB decoded. Decode
   and write `<timestamp>.png` next to the annotation JSON (same atomic
   temp+replace pattern). In the stored JSON, replace the base64 `screenshot`
   with `"screenshotFile": "<name>.png"` (never store megabytes of base64 in
   the JSON). Payloads without `screenshot` are unchanged (backward compat).
3. ADAPTER (server/adapters/hermes.py): when the annotation has a
   `screenshotFile` (and the PNG exists on disk), prepend to the delivery
   message:
   `@image:<abs path to png>`
   and always append `@file:<abs path to the annotation json>` as the last
   line. Both only when the files exist. Message otherwise unchanged.
4. DOCS: protocol.md documents the optional `screenshot` field (data URL,
   stored as PNG, delivered as @image ref) as schema v1.4, backward
   compatible. CHANGELOG [1.4.0] entry. No em-dashes.
5. TESTS: hub test — payload with a tiny valid base64 PNG stores the PNG file
   and the JSON carries screenshotFile; payload with a non-PNG data URL -> 400;
   payload without screenshot unchanged. Adapter test — message contains
   @image and @file lines when files exist, omits them when missing.

## Acceptance (run and report)
py_compile on changed python; pytest -q green (venv /Users/marcelspatz/
browserlink/.venv/bin/python, PYTHONPATH unset); node --check
extension/service-worker.js; live curl on port 8790 with temp
BROWSERLINK_DATA_DIR: POST with a 1x1 PNG data URL -> 200, PNG file exists,
JSON has screenshotFile; POST without screenshot -> 200, no PNG; clean up.

## Follow-up pass (same PR, after the plumbing above lands): element-crop + multi-select

1. MULTI-SELECT (extension/content.js):
   - Shift+click in Element mode toggles an element in/out of the selection
     set; plain click selects it as the single active element (existing
     behavior). Selected elements keep their numbered markers.
   - The inspector shows a selection header ("N selected") with a compact
     list of the selected elements (E1: tag#id 'text'), each with a remove
     (x) button; clicking a row makes that element active for editing.
   - The instruction textarea and edits apply to the ACTIVE element; the
     Send button ships ALL selected elements in the payload (each with its
     own instruction/edits).
2. ELEMENT-CROP SCREENSHOT (content.js + service-worker.js):
   - On Send, the content script computes the union bounding rect of all
     selected elements (getBoundingClientRect, CSS px, clamped to the
     viewport, 8px padding) and includes captureRect {x,y,w,h,dpr} in the
     annotate message. No elements selected -> no captureRect (full tab).
   - The service worker captures the visible tab, and when captureRect is
     present crops the image to rect x dpr via OffscreenCanvas +
     createImageBitmap, then sends the cropped PNG data URL as the
     screenshot field. Crop failure falls back to the full capture;
     capture failure proceeds without a screenshot.

## Micro-animations & interactivity (content.js + overlay.css, same PR)

Motion principles:
- transform + opacity ONLY (GPU-composited); 120-200ms for chrome controls,
  200-300ms for panels/entrances; ease-out curves
- prefers-reduced-motion: reduce -> ALL animations become instant (no
  transitions, no loops, no lerp)
- No infinite animations except: collapsed-chip breathing (3s, scale
  1->1.03->1, subtle) and the selected-element pulse ring (2s loop) - both
  disabled under reduced motion

Toolbar:
1. Inject entrance: host fades in + slides down 6px (180ms)
2. Button hover: scale 1.08 (120ms); press: scale 0.94 (100ms)
3. Mode toggle (Annotate/Element): sliding pill behind the active label
   (transform translateX, 180ms)
4. Collapse: toolbar scales 0.9 + fades into the chip (200ms); chip pops in
   with a bounce (scale 0.6->1.05->1, 200ms)
5. Drag: shadow lift + scale 1.02 while dragging; settles back (150ms) on drop
6. Exit/power: fade + scale 0.95 out (120ms) BEFORE the host is removed

Inspector:
7. Panel slide-in: translateY(-8px) + fade (200ms)
8. Rows: staggered entrance (fade + 8px slide, 30ms stagger, max 200ms total)
9. Slider tick: the value label scales 1->1.15->1 (100ms) on input
10. Edited row: accent border fades in + one 400ms glow pulse, then a steady
    subtle glow
11. Reset: row background tint flash (200ms)
12. Selection count badge: pop scale 0.5->1.1->1 (150ms) when the count changes
13. Row remove (x): fade + slide out (120ms) before removal

Element picker:
14. Hover highlight LERP: the highlight box position/size eases over ~100ms
    (rAF, ease-out) instead of snapping - the single biggest "not static" win
15. Numbered markers: pop-in scale 0.5->1.1->1 (150ms) when placed
16. Selected element: soft pulsing ring (2s loop, opacity 0.4->0.8) drawn on
    the overlay canvas, only in Element mode with a selection
17. Deselect: marker fade-out (100ms)

Send feedback:
18. Send button: press compress (100ms); success: green flash + checkmark
    (400ms); error: shake translateX +-3px x3 (300ms)
19. Toast: "Sent" slides in (150ms), auto-dismiss fade-out after 1.8s

Constraints: CSS transitions/animations preferred; rAF only for canvas-drawn
effects (highlight lerp, pulse ring); never animate layout properties
(width/height/top/left); existing selectors and behavior must not break;
prefers-reduced-motion honored globally.
