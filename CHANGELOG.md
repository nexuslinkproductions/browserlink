# Changelog

All notable changes to browserlink are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), versioning follows
[SemVer](https://semver.org/).

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
