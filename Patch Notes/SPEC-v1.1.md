# browserlink v1.1 - Extension Update Spec (toolbar, activation, element inspector)

Repo: /Users/marcelspatz/browserlink (branch main, tag v1.0.0 shipped).
This update ships as a PR: feat/extension-v1.1 -> main, tagged v1.1.0 after merge.
Backward compatible: schema v1 gains an OPTIONAL `edits` field on elements.

## Payload schema addition (protocol v1.1, documented in docs/protocol.md)
elements[].edits - optional object mapping a CSS/text property to the DESIRED
new value (string), e.g. {"width":"48px","fontSize":"16px","color":"#0af",
"text":"Shop now"}. Allowed keys: width, height, fontFamily, fontSize,
fontWeight, lineHeight, color, backgroundColor, text, href, display, margin,
padding, borderRadius. Unknown keys rejected by hub validation (400).
`instruction` stays the free-text field; edits are the structured change list.

## File ownership (two workers, disjoint files)
Worker A (deepseek-v4-flash): ONLY
  /Users/marcelspatz/browserlink/extension/content.js
  /Users/marcelspatz/browserlink/extension/overlay.css
Worker B (deepseek-v4-flash): ONLY
  /Users/marcelspatz/browserlink/extension/popup.html
  /Users/marcelspatz/browserlink/extension/popup.js
  /Users/marcelspatz/browserlink/extension/service-worker.js
  /Users/marcelspatz/browserlink/docs/protocol.md
  /Users/marcelspatz/browserlink/README.md
  /Users/marcelspatz/browserlink/CHANGELOG.md
  /Users/marcelspatz/browserlink/tests/test_hub.py
  /Users/marcelspatz/SEO-OPS/wp/annotations.py
No git. No hermes config. No hub/server changes. Do not claim in-browser
visual verification.

## Toolbar requirements (Worker A, content.js + overlay.css)
1. POWER / EXIT: a power button (⏻) and a close button (✕) in the toolbar.
   Both fully deactivate the tool on the current page: remove the shadow host
   and overlay from the DOM, close the instruction chat card and inspector,
   cancel any pending pointer capture, and set state so the page is 100%
   clean (no leftover nodes). Deactivation persists per tab in
   chrome.storage.session (key: tabId -> {enabled:false}).
   Reactivation: clicking the extension action icon (popup master switch) or
   re-invoking via popup re-injects the overlay.
2. COLLAPSE: a minimize button (−) collapses the toolbar to a small floating
   round chip (48px) showing the extension icon dot; clicking the chip
   restores the full toolbar. Collapsed state persisted per tab.
3. MOVE: the toolbar is draggable by a handle (⋮⋮ area). Drag updates
   position live; position persists in chrome.storage.session per tab
   (default: top-right, 12px inset). Clamp to viewport. The collapsed chip
   moves identically.
4. The toolbar is the single control surface: [⏻ power] [− collapse]
   [⋮⋮ drag handle] [Annotate|Element toggle] [colors] [width] [Undo]
   [Clear] [Send] [✕ exit]. All existing behavior (draw mode, element picker,
   instruction chat) must keep working unchanged.
5. Activation/deactivation messages: content.js listens for
   chrome.runtime.onMessage {type:"browserlinkToggle", enabled:bool} and
   {type:"browserlinkExit"} - exit removes everything (as above); toggle off
   == exit; toggle on == inject (idempotent, guarded by the existing
   __browserlinkInjected flag).

## Element inspector (Worker A, content.js + overlay.css)
1. In Element mode, selecting an element opens the INSPECTOR panel (attached
   below the toolbar, max 320px wide, scrollable, styled with the same
   theme-var approach as the toolbar; no hardcoded colors except the fixed
   annotation palette).
2. The panel shows, for the selected element, one row per property with the
   CURRENT computed value, cleanly labeled:
     width, height            (getBoundingClientRect, px, rounded)
     fontFamily, fontSize, fontWeight, lineHeight, color  (getComputedStyle)
     text                     (textContent, trimmed, max 200)
     href                     (if anchor)
     display, margin, padding, borderRadius (computed shorthand values)
   Each row: label | current value (read-only text) | edit input.
3. Editing: typing in an edit input stores the desired value; a per-row
   "clear" resets it. Edited rows get a visual marker (accent border).
   The panel footer shows "N edits" + the instruction textarea (reuse the
   instruction chat input) + [Send] button.
4. Send payload: elements[] entries now include
   "edits": {property: desiredValue} for edited properties (string values,
   only non-empty edits), alongside the existing descriptor + instruction.
5. Panel closes on: deselection, mode switch to Annotate, exit/power off.

## Popup + SW + docs + agent tooling (Worker B)
1. popup.html/popup.js: add a master switch "Tool active" (default ON,
   persisted chrome.storage.local "toolEnabled"). When toggled OFF: send
   {type:"browserlinkExit"} to the active tab and persist; when ON: send
   {type:"browserlinkToggle", enabled:true} to the active tab and persist.
   Keep endpoint input/status row/label/test button. No "Hermes" strings.
2. service-worker.js: forward runtime messages from popup to the active tab
   (chrome.tabs.query active, chrome.tabs.sendMessage). Endpoint handling
   unchanged.
3. docs/protocol.md: document elements[].edits (allowed keys, string values,
   example) under schema v1.1 note; update example payload.
4. README.md: add features bullets (activation toggle, collapsible/movable
   toolbar with exit, element inspector with inline editing). No em-dashes.
5. CHANGELOG.md: add [1.1.0] section (Unreleased -> entry) describing the
   toolbar, activation, inspector.
6. tests/test_hub.py: add a test that POST body with elements[].edits
   (valid keys) passes validation and round-trips; edits with an UNKNOWN key
   -> 400. Keep the suite green.
7. /Users/marcelspatz/SEO-OPS/wp/annotations.py: `show` prints edits per
   element as "  edits: width=48px fontSize=16px" (after the instruction),
   truncated to 120 chars total. Python3.9-compatible.

## Acceptance (run and report outputs)
A: node --check content.js passes; grep evidence: drag handler +
  chrome.storage.session position persist; exit path removes host node;
  inspector reads getBoundingClientRect + getComputedStyle and writes edits
  into the send payload.
B: node --check popup.js service-worker.js passes; python3 -m py_compile
  tests/test_hub.py /Users/marcelspatz/SEO-OPS/wp/annotations.py; pytest -q
  green (use /Users/marcelspatz/browserlink/.venv/bin/python, PYTHONPATH
  unset); a focused JSON round trip with edits via the hub validator;
  no em-dashes in README.md/CHANGELOG.md.
