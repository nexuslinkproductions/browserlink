# browserlink - Patch Notes v2.7.0

Released: 2026-08-12
Branch: feat/overnight-v2.7 → main (PRs #15, #16)
Extension version: 2.2.0 | Hub version: 2.7.0 | Schema: v1.9

## Added

- **Agent-ready context.** Every annotation now carries a schema v1.9
  environment snapshot (`capturedAt`, page `url`, `viewport`, `userAgent`,
  `language`, `devicePixelRatio`, `timezoneOffsetMinutes`), an optional
  `textQuote` descriptor, and reserved thread identity fields (`threadId`,
  `parentId`). The AI brief gains Agent Context and Reproduction Context
  sections that render these values exactly as captured, with explicit
  `(omitted)` states and nothing ever fabricated.
- **Annotation recall.** Local full-text search across the whole stored
  corpus: `GET /annotations?q=` matches case-insensitively across label,
  url, title, notes, and element text and instructions (NFC-normalized),
  composes with optional `url` and `since` filters, and is mirrored 1:1 in
  the MCP `annotations_list` tool. The popup gains a debounced search box
  with keyboard reachability and per-result navigation.
- **Element threads and webhook handoff.** Committed element instructions
  now form an ordered, append-only reply thread instead of single-turn
  records. The first instruction in a page context mints a stable
  `threadId`; every later committed instruction is a reply whose `parentId`
  references the previous item, and the inspector lists the whole thread
  chronologically. Thread history survives refresh via the draft store
  (capped at 20 items, instructions at 500 characters). The hub validates
  every thread link on store (missing parent, cross-thread parent,
  `parentId` without `threadId`, or a cycle is rejected with HTTP 400),
  and a new `GET /annotations/<name>/thread` route replays the full thread
  in order. Webhook delivery now emits one bounded `annotation.thread.v1`
  JSON event per annotation, far below the 1MB cap; a webhook failure
  never blocks local storage or the other adapters.
- **Text-selection quick actions.** A non-empty page text selection opens a
  compact quick-action surface with Note, Ask AI, and Highlight. Note
  queues a quote-linked note, Ask AI opens the instruction flow without
  auto-send, and Highlight stores a visual quote marker; all carry the
  schema v1.9 `textQuote` descriptor. Whitespace-only selections,
  password/input fields, extension UI, and selections inside inaccessible
  frames produce no surface.
- **Programmatic control.** The MCP `annotations_list` tool gains
  composeable filters (`q`, `url`, `since`, `cssPathPrefix`, `hasEdits`,
  `intent`, `severity`, `limit`) with AND semantics and stable ordering,
  and the extension supports per-route opt-out: exact-origin or
  pathname-prefix entries in the popup keep a route dormant and trigger a
  clean exit on navigation. No new permissions.

## Changed

- Schema v1.9: environment snapshot, `textQuote`, and thread identity
  fields, fully backward compatible with legacy annotations.

## Fixed

- (none in this release)
