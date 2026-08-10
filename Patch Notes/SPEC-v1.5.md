# browserlink v1.5 — Full lightweight text editor in the inspector

Repo: /Users/marcelspatz/browserlink. Ships as its own PR (feat/editor-v1.5 -> main),
tag v1.5.0 after merge. Do NOT touch the TS v2.0 work (ts/ dir) or the
attachment plumbing (already shipped in v1.4).

Problem: the inspector's text input is a single line; users cannot format
text or control alignment. The gap between "saying what I need" and "actually
manipulating the site" must close: a full lightweight editor for the selected
element's text.

## File ownership (two workers, disjoint)
Worker A (cursor/auto): extension/content.js, extension/overlay.css
Worker B (cursor/auto): server/hub.py (edits validation: add textAlign,
  textTransform, letterSpacing, wordSpacing, whiteSpace, verticalAlign,
  textDecoration, fontStyle, textShadow to the allowed edits keys),
  docs/protocol.md (document the new keys), tests/test_hub.py (new keys
  accepted, unknown still 400), CHANGELOG.md [1.5.0] entry, README.md
  (editor feature bullet). No em-dashes.

## Editor requirements (Worker A)
1. The inspector's text row becomes a MULTILINE editor:
   - textarea (min-height 64px, max-height 200px, auto-grow) instead of the
     single-line input
   - Enter inserts a newline (default textarea behavior; no Shift+Enter
     passthrough needed here)
   - The textarea edits element.textContent live; newlines become <br> or
     block-level text nodes (use textContent with \n -> the element's
     white-space handling; simplest correct approach: set textContent and let
     the browser render; if the element is inline, wrap text nodes in <br>
     for newlines)
2. FORMATTING toolbar above the textarea (small icon buttons, 22px):
   - Bold (fontWeight 700/400 toggle), Italic (fontStyle italic/normal),
     Underline (textDecoration underline/none)
   - Alignment: Left / Center / Right / Justify (textAlign left/center/
     right/justify) - segmented control, one active at a time
   - Text transform: UPPER / lower / Title (textTransform uppercase/
     lowercase/capitalize/none) - cycle button
   - Font size: reuse the existing fontSize slider (already present)
   - Color: reuse the existing color picker (already present)
3. All formatting writes element.style live (existing live-apply pattern) and
   records into the edits payload with the existing schema keys (fontWeight,
   fontStyle, textDecoration, textAlign, textTransform are already allowed
   keys in the hub validation; verify against server/hub.py and add any
   missing ones in Worker B).
4. The editor toolbar shows only when the active element has text (or always
   in Element mode with an active element; simpler: always show in the
   inspector, disabled state when no text).
5. Everything else (multi-select, captureRect, animations, exit/re-invoke)
   stays unchanged.

## Acceptance (run and report)
A: node --check content.js; grep evidence: textarea multiline, Enter newline
  handling, alignment segmented control, bold/italic/underline toggles,
  textTransform cycle, live style writes; node-vm harness: typing with \n
  updates textContent, alignment button sets textAlign + records edit,
  bold toggle sets fontWeight.
B: py_compile; pytest -q green (venv, PYTHONPATH unset); grep: new edits
  keys in hub validation; no em-dashes in docs.
