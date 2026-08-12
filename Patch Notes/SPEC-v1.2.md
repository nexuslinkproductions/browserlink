# browserlink v1.2 - Interactive Element Inspector (Update A)

Repo: /Users/marcelspatz/browserlink. Ships as its OWN PR (feat/inspector-v1.2 -> main),
tag v1.2.0 after merge. Do NOT touch the v1.3 (connect) feature files.

## File ownership (single worker)
ONLY: extension/content.js, extension/overlay.css

## Requirements
Replace the plain text inputs in the element inspector (v1.1) with
interactable value manipulators that DIRECTLY manipulate the element live so
the user sees the effect before sending.

1. MANIPULATORS per property (replacing the edit inputs):
   - width, height: sliders (range input), 0-2000px, step 1, live unit px
   - fontSize: slider 6-96px step 1
   - lineHeight: slider 0.8-3.0 step 0.05 (unitless)
   - borderRadius: slider 0-100px step 1
   - margin, padding: slider 0-200px step 1 (uniform shorthand applied)
   - fontWeight: select 100/200/300/400/500/600/700/800/900
   - fontFamily: dropdown of locally installed fonts (navigator.queryLocalFonts
     when available and permitted; fallback: families from document.fonts plus
     the standard system stack list: system-ui, -apple-system, Segoe UI,
     Roboto, Helvetica, Arial, Georgia, Times New Roman, Courier New, Verdana,
     Tahoma, Trebuchet MS, Impact, Comic Sans MS, monospace, serif, sans-serif)
   - color, backgroundColor: <input type="color">
   - text: text input (max 200)
   - href: text input
   - display: select block/inline/inline-block/flex/grid/none
2. LIVE APPLICATION: every manipulation applies to the element immediately
   (element.style[prop] = value; text -> textContent). Track the ORIGINAL
   computed value per property; each row gets a Reset button; panel footer
   gets "Reset all". Reset restores the original style (style[prop] removal
   when the original came from CSS, or original value when it was inline).
   Live-applied values become the edits payload entries (existing schema).
3. HIGHLIGHT WHAT IS AFFECTED: hovering or focusing a property row draws a
   visual hint on the element via the existing overlay canvas:
   - width: vertical edge lines left/right of the element box
   - height: horizontal edge lines top/bottom
   - fontSize, fontWeight, fontFamily, lineHeight, color: highlight the
     element's text area (Range over first text node, fallback: element box)
   - margin: dashed outer box offset by the margin values
   - padding: dashed inner box inset by padding
   - borderRadius: corner arcs (small circles at the 4 corners)
   - text, href: underline the text / link area
   Clear the hint on row blur/mode switch/panel close; redraw on scroll and
   resize (rAF loop while a row is active).
4. Everything else (draw mode, element picker, instruction chat, toolbar
   controls, exit/power, payload schema, edits validation) stays unchanged.

## Acceptance (run and report)
node --check extension/content.js; grep evidence: queryLocalFonts/document.fonts,
  range input creation per property, element.style live writes, Reset
  tracking original values, overlay hint drawing per property; behavioral
  harness (node vm with stubbed DOM/chrome) covering: slider change applies
  style + records edit, reset restores, hint drawn for width row and cleared
  on blur. No git. No claims of in-browser visual verification.
