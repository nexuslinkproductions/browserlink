# Changelog

All notable changes to browserlink are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), versioning follows
[SemVer](https://semver.org/).

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
