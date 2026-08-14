# Changelog

All notable changes to browserlink are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

## [2.8.0] - 2026-08-13

### Added

- **Removal-aware anchoring (F11)** - feedback from aurascriptworks on reddit:
  anchors now survive outright element removal. A bounded document
  MutationObserver detects anchored-node removal, falls back to the nearest
  surviving ancestor (html/body excluded), else marks the entry detached.
- **Detached drafts and remount recovery (F12)** - removed entries persist as
  detached ghost markers with instruction intact and auto re-anchor when
  matching content remounts.
- **Anchor honesty and diagnostics (F13)** - schema v1.10 adds the 'detached'
  resolution and 'ancestor' fallback signal, markdown exports render the state
  honestly, and lifecycle counters land in diagnostics.

### Changed

- **Content-ready mutation batching** - mutation-driven re-anchoring is
  debounced and coalesced with requestAnimationFrame, with a timeout fallback
  for hidden tabs.

### Fixed

- iframe removal detection now resolves through the cached frame registry because Chrome nulls the live cross-document bridge before the observer callback (F11 follow-up);
- the attrs fallback tier requires matching text when stored text exists, ending silent fuzzy re-anchoring to changed content (F11 follow-up);
- the hidden-tab re-anchor fallback marks the pass only at execution, closing a first-frame/second-frame race (F11 follow-up);
- persistent drafts are keyed per tab so same-page tabs no longer share or overwrite each other's drafts (C6 isolation).

### Hardened

- **Unique annotation file names (H1)** - concurrent stores in the same
  millisecond can no longer collide: `storeAnnotation` bumps a `-N` suffix
  while the target name exists, so two simultaneous sends always produce
  two distinct files and neither delivery is deduped away.
- **Cross-origin request gate (H4)** - the hub now validates the `Origin`
  header on every route: absent origins (curl, MCP, local tooling),
  `chrome-extension:` / `moz-extension:` origins, and same-origin requests
  are allowed; everything else is rejected with 403 `origin not allowed`.
  Web pages can no longer POST annotations, redirect delivery, or read the
  local annotation history without permission.
- **Honest body handling (H10)** - `readJsonBody` accepts chunked
  (`Transfer-Encoding`) requests, applies a 30s read deadline, rejects
  declared-length mismatches with 400 `body length mismatch`, and never
  claims `invalid JSON` for a truncated stream.
- **Corrupt annotations are visible (H11)** - rendered routes
  (export.md, share, share.png, bundle, thread) now return 500
  `corrupt annotation` when a stored file fails to parse, instead of
  hiding data-integrity problems behind 404.
- **Documented screenshot ceiling reachable (H13)** - the raw body cap is
  now 14MB (with the 4/3 base64 inflation documented), so a decoded
  screenshot at the full documented 10MB contract is accepted instead of
  being 413'd before validation.
- **Element index validation (H12)** - `elements[].index` must be
  non-negative; negative indexes are rejected with 400.
- **Text length caps at the hub (H15)** - element instructions, text,
  edits values, and titles are bounded to their documented limits at
  validation time, matching the extension's own caps, so non-extension
  clients cannot store megabyte strings that flow uncapped into exports.
- **MCP watch bound (H14)** - `annotations_watch` seconds are capped
  (max 120) so one call can no longer block the single-threaded stdio
  server for hours.
- **Hermes 5xx backoff actually sleeps (H3)** - the `/chat` fallback
  retry loop now applies its documented backoff to HTTP 5xx responses
  instead of hammering the upstream back-to-back.
- **Sender-tab screenshot guard (H2)** - the extension only captures when
  the sender tab is the active tab of its own window; otherwise the
  screenshot is omitted (honest annotation without `screenshot`) rather
  than storing a different page's capture.
- **Send path endpoint consistency (H5)** - sends resolve the hub endpoint
  exactly like the health check (stale stored endpoint falls back to
  `DEFAULT_ENDPOINT`), so sends always target the endpoint the popup
  reports as connected.
- **Thread id from the send response (H6)** - the extension stamps the
  thread `parentId` from the POST response `file` (the exact annotation
  just stored), eliminating the cross-tab mtime race that produced
  rejected `cross-thread parent` replies.
- **Bounded draft store (H7)** - drafts are capped at 25 per profile with
  oldest-first eviction by `savedAt`, and storage failures on config
  writes are surfaced instead of silently swallowed.
- **Send timeout (H9)** - the hub POST is bounded by a 20s abort timeout;
  a stalled hub surfaces as a send failure and releases the busy lock.

## [2.7.0] - 2026-08-12

### Added

- **Agent-ready context (F4)** - every annotation now carries a schema v1.9
  environment snapshot (`capturedAt`, page `url`, `viewport`, `userAgent`,
  `language`, `devicePixelRatio`, `timezoneOffsetMinutes`), an optional
  `textQuote` descriptor, and optional thread identity fields (`threadId`,
  `parentId`, reserved for element threads). The AI brief gains Agent
  Context and Reproduction Context sections that render these values
  exactly as captured, with explicit `(omitted)` states and nothing ever
  fabricated.
- **Annotation recall (F7)** - local full-text search across all stored
  annotations. `GET /annotations?q=` matches case-insensitively across
  label, url, title, notes, and element text/instructions (NFC-normalized),
  composes with optional `url` and `since` filters, and is mirrored 1:1 in
  the MCP `annotations_list` tool. The popup gains a debounced search box
  with keyboard reachability and per-result navigation.
- **Element threads and webhook handoff (F8)** - committed element
  instructions now form an ordered, append-only reply thread instead of
  single-turn records. The first instruction in a page context mints a
  stable thread id (schema v1.9 `threadId`); every later committed
  instruction is a reply whose `parentId` references the previous item, and
  the element inspector visibly lists the whole thread chronologically
  (root first, replies after) with the existing instruction field preserved
  as the reply composer. The thread history survives refresh via the
  existing draft store (capped at 20 items, instructions at 500
  characters) and keeps its data on unresolved anchors. When a send
  continues a thread that already shipped, the annotation carries
  `parentId` = the stored id of the nearest sent ancestor, so a new
  `GET /annotations/<name>/thread` route (plus `/annotations/latest/thread`)
  replays the full thread in order. The hub validates every thread link on
  store - a missing parent, a cross-thread parent, a `parentId` without
  `threadId`, or a cycle in the parent chain is rejected with HTTP 400
  before the annotation is persisted - while root and legacy annotations
  store unchanged. Webhook delivery (`BROWSERLINK_WEBHOOK_URL`) now emits
  one bounded `annotation.thread.v1` JSON event per annotation with the
  annotation id, thread id, parent id, page URL, element selector, intent,
  severity, instruction, reply text, and the local share URL, staying far
  below the 1MB cap; legacy annotations deliver the same event with null
  thread fields, and a webhook failure never blocks local storage or the
  other adapters.
- **Text-selection quick actions (F9)** - a non-empty page text selection
  opens a compact quick-action surface with Note, Ask AI, and Highlight.
  Note queues a quote-linked note, Ask AI opens the existing instruction
  flow without auto-send, and Highlight stores a visual quote marker; all
  carry the schema v1.9 `textQuote` descriptor. Whitespace-only selections,
  password/input fields, extension UI, and selections inside inaccessible
  frames produce no surface.
- **Programmatic control (F10)** - MCP `annotations_list` gains composeable
  filters (`q`, `url`, `since`, `cssPathPrefix`, `hasEdits`, `intent`,
  `severity`, `limit`) with AND semantics and stable ordering, and the
  extension supports per-route opt-out: exact-origin or pathname-prefix
  entries in the popup keep a route dormant and trigger a clean exit on
  navigation, with a `browserlinkRouteControl` service-worker message for
  harnesses. No new permissions were added.

## [2.6.0] - 2026-08-12

### Added

- **Onboarding pack (three-step intro + session always-on)** - the first
  time the tool activates, three coach marks appear in order - pick an
  element, add an instruction, then send - each targeting the actual
  control it names. Marks advance or dismiss by pointer (Next/Skip) or
  keyboard (Enter, arrow keys, Escape), respect `prefers-reduced-motion`,
  and keep keyboard focus inside the card. Completing or skipping stores a
  one-time local flag (`browserlinkOnboarded`), so refresh, reinjection,
  extension reload, and browser restart never replay the tour; the popup's
  **Replay intro** button resets it explicitly. The popup gains **Always on
  for this browser session**: off by default, newly loaded pages stay
  inactive until activated per page; when on, newly loaded eligible pages
  activate automatically for the rest of the session (session-scoped
  `browserlinkAlwaysOn` flag, cleared at browser restart, per-tab exit
  still respected). Restricted pages (chrome://, web store, ...) show an
  honest unavailable state in the popup with no repeated injection
  attempts, and the popup states its no-account, local-hub, existing
  permission-scope copy. No new permissions were added; the service worker
  exposes session storage to the content script via
  `storage.session.setAccessLevel` so the session flag and per-tab view
  state work as documented.

- **Local save and backup** - the popup gains three browser-native download
  actions (no upload, no account; the destination is chosen in the browser's
  normal download dialog via `chrome.downloads`):
  - **Save newest capture** - downloads the newest annotation's stored
    screenshot as PNG (as stored) or JPEG (converted locally with
    OffscreenCanvas); the chosen format matches the downloaded file bytes
    and extension.
  - **Download newest bundle** - `GET /annotations/<name>/bundle` (and the
    `/annotations/latest/bundle` alias) streams a deterministic ZIP with a
    manifest (`schema: browserlink.annotation.bundle.v1`) naming the
    included files, the annotation JSON byte-for-byte, the AI brief Markdown
    (same sections as `export.md`, with `@file:`/`@image:` references
    relative to the bundle so the archive is portable and never discloses
    absolute host paths), and the PNG when present. A missing PNG is
    declared as `screenshot: null`, never stubbed.
  - **Backup all annotations** - `GET /annotations/backup.zip` streams one
    consistent snapshot of the whole corpus (`schema:
    browserlink.corpus.backup.v1`, `count`, per-record screenshot flags);
    an empty corpus still produces a valid explicit empty backup. PNGs are
    stored before their JSON (atomic renames), so every archive is a
    complete before-or-after snapshot, never a partial file set, even while
    annotations are written concurrently.
  - Archives are deterministic (name-sorted entries, fixed timestamps) and
    contain only safe relative paths (never absolute filesystem paths or
    traversal names). The extension gains the minimal `downloads` permission
    to start downloads and observe completion or cancellation; failures
    (hub offline, empty corpus, absent screenshot, cancelled download) are
    reported honestly. Copy AI Brief is unchanged.
- **Anchor resilience (mutation-resistant draft re-anchoring)** - when an
  element's exact cssPath no longer resolves (DOM drift, SPA route change,
  refresh after a mutation), draft replay falls back deterministically to
  stable attributes, then normalized text/aria label, then prior rectangle
  proximity, and marks the re-anchored target as moved (amber marker).
  Ambiguous or below-threshold candidates stay unresolved: the instruction
  remains in the draft as recoverable, sendable context rendered as a ghost
  marker at the prior rect, and is never attached to a wrong element. SPA
  pushState/replaceState/popstate changes trigger one bounded re-anchor pass
  after the DOM settles, with no duplicate markers or listeners. Exact
  cssPath replay stays the first path, legacy drafts restore unchanged, and
  Send/Clear All keep their existing draft-clearing contract.
- **Share link (local read-only annotation page)** - `GET
  /annotations/<name>/share` renders one stored annotation as a readable,
  read-only HTML page: page URL, title, viewport, label, notes, per-element
  Intent/Priority chips, instruction and selector details, capture state,
  stroke summary, and the stored screenshot (referenced via
  `/annotations/<name>/share.png`, with an explicit no-screenshot state
  when absent). Annotation-derived text is HTML-escaped and the page is
  served with a restrictive CSP, so stored content cannot execute script;
  the page has no edit/delete/reply/account/cloud controls and labels its
  reachability as same-machine (hub binds 127.0.0.1 by default) unless the
  hub was deliberately exposed for LAN use. `GET /annotations/latest/share`
  aliases the newest annotation. The popup gains a **Copy share link**
  button that copies the newest annotation's share URL with a success state
  naming the annotation.
- **Deep picker (shadow DOM + iframes)** - the element picker reaches
  inside open shadow roots (any depth) and same-origin iframes, including
  nested frames: hover highlight, numbered markers, inspector placement,
  and element crops all translate into top-viewport coordinates, and
  stored descriptors carry optional `frame`/`shadow` metadata (schema
  v1.7, strict typing, backward compatible with earlier payloads).
  Cross-origin iframes degrade explicitly: the frame itself becomes a
  bounded best-effort target with an honest "cross-origin" label, and
  browserlink never claims or attempts inner-DOM access for them. Closed
  shadow roots remain opaque.

## [2.5.0] - 2026-08-12

### Added

- **Copy AI Brief** - one click exports the newest annotation as structured
  Markdown for an AI harness: page URL/title/viewport, per-element cssPaths,
  instructions, edits, Intent/Priority labels, capture state, notes, stroke
  summary, and local `@file`/`@image` references. New hub routes
  `GET /annotations/<name>/export.md` and
  `GET /annotations/latest/export.md`; the popup gains a Copy AI Brief
  button that copies the brief to the clipboard.
- **Persistent Drafts** - unsent strokes, queued notes, and element
  instructions survive a refresh: drafts persist locally per canonical URL
  and restore with best-effort cssPath re-anchoring (unresolved markers are
  counted, never dropped). No account or cloud sync; a draft clears only
  after a confirmed Send or Clear All.
- **Freeze State Capture** - one-click Freeze pauses page CSS animations and
  transitions (transition duration/delay zeroed) for a clean, stable crop;
  the annotation payload carries optional `captureState` metadata with the
  frozen flag plus the last observed hovered selector, the focused element
  selector, and open native details selectors. Works on any site without app
  instrumentation, and the injected freeze style is always removed on exit.
- **Intent and Priority metadata** - optional per-element intent chips (`fix`, `change`, `question`, `approve`) and priority chips (`blocking`, `important`, `suggestion`) are stored in `elements[]` and rendered in harness fallback text.

### Fixed

- **Text formatting edits now validate end-to-end (schema v1.5)** - the nine
  inspector-emitted text-format keys (`textAlign`, `textTransform`,
  `letterSpacing`, `wordSpacing`, `whiteSpace`, `verticalAlign`,
  `textDecoration`, `fontStyle`, `textShadow`) are accepted by the hub,
  stored byte-for-byte, and delivered; previously the hub rejected them with
  HTTP 400, breaking the text editor's Send. Unknown edit keys remain
  strictly rejected.

## [2.4.0] - 2026-08-11

### Added

- **Annotation attachments in the chat composer** - sending an annotation now
  lands the screenshot + JSON directly in the selected Hermes chat's composer
  as real attachment chips, exactly like drag-and-drop (hub calls the gateway
  `POST /api/composer/attach`; the desktop docks them into its native
  add-attachment function via `mainComposerScope.add`). The message still
  posts as a fallback, so delivery never blocks.
- **Chat selector drives delivery direction** - picking a session in the
  extension popup auto-connects (`activate: true`) and routes annotations to
  that chat; endpoint porting hardened (`localhost` -> `127.0.0.1`, trailing
  slash strip, stale-endpoint fallback).
- **Transport hardening** - Hermes adapter: response-status checking, bounded
  retry (1s then 2s backoff on network failures, HTTP 5xx retried without
  delay), dedupe by annotation id, structured success/error logging to
  `browserlink-error.log`, /chat fallback only when composer attach cannot
  deliver (no attachments, 404, or attach failure), directive lines protected
  from text caps. Webhook
  adapter: payload size cap + skip logging. Hub: oversized payloads -> 413,
  malformed JSON handling, per-adapter crash isolation.
- **Queued note delivery** - annotation notes (`note` + `notes`) now flow
  through to the chat message (previously dropped).

### Fixed

- **Send keeps the chrome visible** - the capture state always hides the
  hover box + canvas; the toolbar and collapsed chip hide only when they
  intersect the element crop (full mode), so a screenshot never shows the
  tool; the inspector and chat card stay visible during send.
- **'n' key no longer exits isolation** - UI-origin keystrokes call
  `stopImmediatePropagation` so host-page shortcuts (Comet's 'n') never fire
  from extension controls.
- **Selection queue persists** - picking a new element no longer clears
  committed selections; hover chip shows the queue count.
- **Drag never sticks to the cursor** - pointer capture released on
  `lostpointercapture` + window `pointerup`/`mouseup` fallbacks.
- **Inspector info section** - no longer cut off or squashed (flex fixes).

## [2.3.0] - 2026-08-11

### Added

- **Toolbar edge docking** - drag to a screen edge to dock: vertical bar on
  the left/right, horizontal on the bottom; per-tab persistence, animated
  snap, centered-left first-run placement
- **Toolbar orientation morph** - vertical to horizontal layout changes
  animate with a staggered child tween instead of snapping
- **Annotation note queue** - annotate-mode note card, Enter queues notes,
  live toolbar counter, notes ship with Send only
- **Element inspector resize** - corner drag handle with min/max clamps and
  per-tab persistence; cursor glow inside the panel
- **Diagnostics overlay** - Ctrl+Shift+D: state dump, event ring buffer,
  health codes D-1..D-6, `window.__browserlinkDiag` API
- **On-demand injection** - popup master switch injects the content script
  into the active tab directly (no refresh required)

### Fixed

- Typing in inspector text fields no longer lands on the page (composedPath
  UI exclusion)
- Power button exits cleanly with a smooth-out animation; collapse folds with
  a premium tween
- Element screenshots isolate the selection (double-rAF flush, dpr-aware
  crop, no tool UI in captures)
- Hover highlight fully suppressed over the extension's own UI
- Horizontal scroll eliminated from the inspector
- Em-dashes removed from all file content

### Added

- **Session picker** - the extension popup now lists active Hermes sessions
  (title, preview, last activity) and lets you choose where annotations are
  delivered; the hub proxies the Hermes session list (`GET /sessions`) and
  the adapter resolves the target per annotation, then the stored target,
  then the environment pin

## [2.1.0] - 2026-08-10

### Removed

- **Python legacy removed** - the TypeScript hub and MCP server are now the
  only implementation; `server/`, `mcp/`, and Python tests were deleted; CI
  runs the Node suite only

## [1.6.3] - 2026-08-10

### Fixed

- **Element picker blocks page navigation** - clicking a link or button in
  Element mode no longer navigates; mousedown is suppressed DevTools-style
  so the page cannot react to selection clicks

## [1.6.2] - 2026-08-10
## [1.6.2] - 2026-08-10

### Fixed

- **Element-only screenshots** - the service worker now crops the captured
  tab to the selected element(s) rect (dpr-scaled) instead of sending the
  full screen, and the content script hides the tool overlay during capture
  so the toolbar, inspector, and markers never appear in the shot

## [2.0.2] - 2026-08-10

### Fixed

- **Screenshot renders in chat** - the Hermes adapters (TS and Python) now
  send the screenshot as BOTH an `image_url` part (feeds the agent's vision)
  and an `@image:` ref (what the desktop lifts into a rendered attachment
  thumbnail). Without the ref, the desktop showed the `[screenshot]`
  placeholder as literal text and no image.

## [2.0.1] - 2026-08-10

### Fixed

- **TS Hermes adapter delivery parity** - the TypeScript adapter now matches
  the Python adapter's delivery behavior: resolves the target session's own
  provider/model from the session record (any provider, any model, no
  hardcoded pins), sends the screenshot as a real `image_url` attachment
  part instead of a literal `@image:` text ref, and keeps `@file:` refs.
  Verified end-to-end in production (TS hub on 8787).

## [1.6.1] - 2026-08-10

### Fixed

- **Toolbar gap** - the empty status slot no longer reserves 90px between
  Send and the exit ✕; the buttons sit close together until a status message
  appears
- **Screenshot capture on any page** - host permission now covers all URLs,
  so `captureVisibleTab` succeeds on any site (previously only the hub origin
  was permitted and captures silently failed elsewhere)

## [2.0.0] - 2026-08-10

### Added

- **TypeScript hub + MCP** - Node 22 package `browserlink-mcp` with bins
  `browserlink-hub` and `browserlink-mcp`; shared schema module; same REST
  contract, data-dir resolution, env vars, and MCP tool names as the Python
  path (`hub_status`, `annotations_list`, `annotations_latest`,
  `annotations_get`, `annotations_watch`, `browserlink_connect`,
  `browserlink_disconnect`, `browserlink_status`)
- **CI** - Node job under `ts/`: `npm ci`, `tsc --noEmit`, and
  `node --test` for the TypeScript suite
- **Docs** - README TypeScript quickstart (`npx browserlink-hub` /
  `npx browserlink-mcp` or global install)

### Notes

- Python `server/` and `mcp/` remain the legacy path for this release; the
  TypeScript stack is drop-in compatible and intended to become the default
  after production soak.

## [1.6.0] - 2026-08-10

### Added

- **Collapsible inspector categories** - inspector rows group under
  Text / Layout / Appearance / Other headers; click a header to collapse or
  expand the group; collapse state persists per tab
- **Element-mode hover boxes** - hovering in Element mode draws a clear
  outline box around the element under the cursor (tracks scroll and resize),
  so you can see exactly what you are about to select
- **Property-hint exclusion** - hovering a property row highlights what it
  affects on the page, never the inspector/editor UI itself

### Fixed

- **Popup switch no longer flips back** - the service worker's connect poll
  now respects the popup master switch; a stale connect target can no longer
  re-inject the tool (or flip `toolEnabled` back to ON) after you deactivated
  it
- **Hermes delivery routing** - the adapter resolves the target session's
  own provider/model from the session record (any provider, any model) and
  sends the screenshot as a real image attachment (`image_url` part) instead
  of a literal `@image:` text ref; env overrides remain available for
  special cases

## [1.5.0] - 2026-08-10

### Added

- **Text editor edits keys** - hub `elements[].edits` accepts text-formatting
  properties for the inspector editor: `textAlign`, `textTransform`,
  `letterSpacing`, `wordSpacing`, `whiteSpace`, `verticalAlign`,
  `textDecoration`, `fontStyle`, `textShadow` (schema v1.5; unknown keys
  still HTTP 400)
- **Docs** - protocol schema v1.5 documents the new allowed `edits` keys;
  README notes the lightweight text editor feature

## [1.4.0] - 2026-08-10

### Added

- **Attachment delivery** - optional screenshot capture and file refs so
  annotations land in Hermes chat as real attachments (`@image` / `@file`)
- **Extension** - service worker captures the visible tab via
  `chrome.tabs.captureVisibleTab` (PNG data URL) before POST; capture
  failure never blocks the annotation
- **Hub** - optional `screenshot` field (schema v1.4): must be
  `data:image/png;base64,...`, max 10MB decoded; written as sibling
  `<timestamp>.png` (atomic temp+replace); stored JSON carries
  `screenshotFile` instead of base64; payloads without screenshot unchanged
- **Hermes adapter** - prepends `@image:<abs png path>` when the PNG exists;
  appends `@file:<abs annotation json path>` as the last line when the JSON
  exists
- **Docs** - protocol schema v1.4 documents the screenshot wire/on-disk/
  delivery path; backward compatible with v1.0 through v1.3

## [1.2.0] - 2026-08-10

### Added

- **Interactive element inspector** - per-property manipulators (sliders for
  width/height/font-size/line-height/border-radius/margin/padding, font-weight
  and display selects, local-font dropdown via `queryLocalFonts`, color
  pickers, text/href inputs)
- **Live manipulation** - every change applies to the element immediately;
  per-row Reset and Reset All restore the originals; live values ship as the
  structured `edits` payload
- **Property hints** - hovering a row highlights what the property affects on
  the element (edge lines, text-area glow, margin/padding boxes, corner arcs,
  underlines)

## [1.4.0] - 2026-08-10

### Added

- **Attachment delivery** - sending captures the visible tab; the hub stores
  the screenshot as a PNG beside the annotation JSON and the Hermes adapter
  delivers `@image:` and `@file:` refs, so annotations land in the chat as a
  real attachment card (screenshot thumbnail + annotation file)
- **Element-crop screenshots** - the capture is cropped to the union bounding
  box of the selected elements (8px padding, viewport-clamped), so the
  attachment shows exactly what was annotated
- **Multi-select** - Shift+click toggles elements in/out of the selection;
  each element keeps its own instruction and edits; Send ships all selected
  elements in one payload
- **Micro-animations** - hover/press feedback, sliding mode pill, collapse
  bounce, staggered inspector rows, slider value ticks, edited-row glow,
  lerped hover highlight, pulsing selection ring, send success/error feedback
  and toast; all transform/opacity only and disabled under
  `prefers-reduced-motion`
- **Exit/re-invoke fix** - closing the tool persists per tab; a page refresh
  no longer reopens it, and the popup switch reflects the real tab state and
  re-launches the tool on demand

## [1.3.0] - 2026-08-10

### Added

- **Invoke from any chat** - MCP tools `browserlink_connect`,
  `browserlink_disconnect`, and `browserlink_status` post a delivery target
  to the local hub so the extension activates and annotations land in the
  calling session
- **Hub target API** - `GET/POST /target` (atomic `target.json`),
  `POST /activate` (merge activate flag, keep sessionId/label), and
  `/status.target` (`{sessionId,label}` or `null`)
- **Hermes adapter** - per-delivery session resolution: `target.json`
  sessionId wins over `HERMES_SESSION_ID`; structured delivery message with
  URL/Title/Label, enumerated elements, and stroke summary
- **Extension poll** - service worker `chrome.alarms` `browserlink-poll`
  every 30s; on `activate: true` injects the overlay once and acks
  `POST /activate {active:false}`
- **Popup** - status row shows `Delivered to: <label|sessionId>` or
  `not connected` from `GET /target`
- **Docs** - protocol `/target` and `/activate`, MCP harness examples,
  README "Invoke from any chat" section

## [1.1.0] - 2026-08-10

### Added

- **Toolbar** - collapsible and movable control surface with power and exit
  buttons, a drag handle, and per-tab persistence of position and collapse
  state
- **Activation** - popup master switch ("Tool active", default ON, persisted
  per profile) that activates the overlay per tab and fully deactivates it
  (exit) on demand
- **Element inspector** - per-property current values with inline edit inputs
  in Element mode; edits ship as structured `elements[].edits` (schema v1.1)
- **Extension** - MV3 browser extension (Comet, Chrome, Edge, Brave, Arc):
  - Draw annotations (normalized strokes, colors, width, undo/clear)
  - DevTools-style element picker: hover highlight with `tag#id.class` chip,
    click-to-select with numbered markers, real element descriptors
  - Per-element instruction chat card (edit on re-click, batch send)
  - Connection UI: configurable hub endpoint, live hub status, context label,
    test-annotation button
  - Closed ShadowRoot isolation - page DOM untouched
- **Hub** - local REST inbox (`server/hub.py`):
  - `POST/GET /annotations`, `GET /annotations/<name>`, `/health`, `/status`,
    `GET/POST /session`
  - Schema v1 validation, traversal guards, atomic writes, CORS
  - Adapter interface: `hermes` (chat injection via Hermes API server),
    `webhook` (generic HTTP push)
- **MCP server** - `browserlink-mcp` package (stdio):
  - Tools: `hub_status`, `annotations_list`, `annotations_latest`,
    `annotations_get`, `annotations_watch`
  - Works with any MCP-capable harness (Claude Code, Hermes, Codex, Cursor,
    OpenCode, ...)
- **Docs** - protocol v1.1 (public contract), MCP/REST references, harness
  guides, security model
- **CI** - GitHub Actions: py_compile + pytest, `node --check` on extension
  scripts, manifest JSON validation
