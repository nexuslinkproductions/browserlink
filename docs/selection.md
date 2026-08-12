# Text-selection quick actions

Browser-native page text selection opens one compact quick-action surface
with three actions: **Note**, **Ask AI**, and **Highlight**. The selection is
captured as a schema v1.9 `textQuote` descriptor (normalized quote text plus
bounded prefix/suffix context) and restores deterministically after refresh
or SPA navigation. This page documents the capture contract, the restore
contract, exclusions, keyboard behavior, and coexistence guarantees.

## Activation

Selecting a non-empty stretch of page text opens the surface near the
selection rect (below it when there is room, above it otherwise, clamped to
the viewport). The surface appears on mouse-up and on keyboard selection
(Shift+arrows). It stays open until one of the actions runs, the selection
is dismissed (Escape, click elsewhere, empty selection), or the mode
changes.

No surface is produced for:

- collapsed or whitespace-only selections,
- selections anchored inside `input`, `textarea`, or `select` elements
  (password fields included),
- selections inside the extension's own overlay UI (the closed shadow
  root), or
- selections inside inaccessible (cross-origin) frames, which the
  extension never enters.

## Actions

| Action | Effect | Payload |
|---|---|---|
| Note | Queues the selected text as an annotation note (queue-first, like the note card Add) | top-level `textQuote` rides with the batch |
| Ask AI | Opens the existing instruction flow (element inspector) with the quote staged for Add; never auto-sends | per-element `textQuote` on the committed element |
| Highlight | Commits a visual quote marker immediately (numbered outline like an element selection) | per-element `textQuote` on the committed element |

All actions carry the schema v1.9 `textQuote` descriptor, capped to the
documented sizes before send: `quote` at most 5000 characters, `prefix` and
`suffix` at most 500 characters each. The extension mirrors the hub caps so
a quick-action payload can never be rejected for an oversized quote. Note
and Highlight call `persistDraft()` so the quote and its marker survive a
refresh; Ask AI persists when the instruction is committed with Add.

The top-level `textQuote` (Note) is cleared after a confirmed successful
Send and by Clear All, exactly like the note queue and the draft.

## Quote descriptor

```json
"textQuote": {
  "quote": "Button contrast looks off",
  "prefix": "The checkout",
  "suffix": "on the cart page"
}
```

- `quote` is the normalized selected text: every whitespace run (including
  newlines and non-breaking spaces) collapses to one space, then the result
  is trimmed.
- `prefix` / `suffix` are bounded raw context sampled from the boundary
  text (at most 120 characters per side at capture time, then capped again
  by the schema caps). A multi-node selection samples the enclosing text of
  the common ancestor instead. When the selection sits at a document
  boundary the corresponding context is empty.
- The same shape and limits are accepted at the top level and per element
  (see docs/protocol.md, textQuote schema v1.9). The extension strips its
  internal bookkeeping (marker flag, resolution stamp) from the shipped
  payload, so only contract fields reach the hub.

## Restore contract

Quote markers restore by TEXT, never by cssPath: the deterministic chain is

1. **exact** - exactly one text node contains the normalized quote;
2. **unique contextual fallback** - several nodes contain the quote, but
   exactly one also matches the stored prefix/suffix around it
   (confidence 0.85);
3. **ambiguous or unresolved** - multiple candidates with context that
   cannot disambiguate, or no candidate at all.

Ambiguous and unresolved quotes stay unresolved: the marker renders as a
ghost at the stored prior rect (like an unresolved element), the resolution
is reported (`quote.resolution`), and the quote is never attached to a
guessed element. The text scan is bounded (at most 4000 text nodes) so
hostile or huge pages cannot stall the restore.

## Keyboard and motion

- The surface is keyboard reachable: its buttons are in the tab order, Tab
  cycles through them, and arrow keys move focus between them when one has
  focus.
- Escape dismisses the surface first (before any chat or inspector cancel)
  and never leaks to the page while the surface is up.
- While a surface button is focused, page keys are blocked from reaching
  the page (the same isolation as the toolbar).
- Enter/Space on a focused button run the action (native button
  activation).
- Reduced motion disables the surface transitions and the entry animation;
  the buttons render instantly in their final state.

## Coexistence

The quick actions add exactly one surface element and one listener set per
page context (surface click plus the mouseup/keyup/selectionchange trio),
all removed on exit. They coexist with element mode (Ask AI is the
element-mode instruction flow), annotation mode, same-origin frames and
shadow DOM picking, drafts (Note/Highlight persist, restore is
text-based), Send (the top-level quote ships and clears with the batch),
and Clear All (clears quote state). A mode switch dismisses an open
surface. The surface hides during captures via the `data-capturing` rules
so a quoted screenshot never contains the action bar.

## Diagnostics

`window.__browserlinkDiag.dump().selection` reports:

- `surface` - whether the quick-action surface is currently visible,
- `topQuote` - whether a quote-linked note is staged for the next send,
- `quoteLen` - length of the live quote snapshot (0 when none),
- `actions` - quick actions taken since injection,
- `listeners` - 1 when the single listener set is bound, 0 otherwise,
- `markers` - committed quote markers in the current batch.
