# browserlink protocol - annotation schema v1.6

The public contract between the extension, the hub, and any harness. Versioned;
changes require a new minor or major version and a compatibility shim.

**Schema v1.6** (backward compatible with v1.0 through v1.5): adds optional
per-element `elements[].intent` and `elements[].severity` metadata chosen from
strict enums and an optional top-level `captureState` object carrying Freeze
State Capture metadata (see below). Wrong types and unknown keys return HTTP
400; payloads without either field remain valid.

**Schema v1.5** (backward compatible with v1.0 through v1.4): extends
`elements[].edits` with text-formatting keys used by the inspector editor
(`textAlign`, `textTransform`, `letterSpacing`, `wordSpacing`, `whiteSpace`,
`verticalAlign`, `textDecoration`, `fontStyle`, `textShadow`). Unknown keys
still return HTTP 400.

**Schema v1.4** (backward compatible with v1.0 through v1.3): adds an optional
`screenshot` field (PNG data URL). The hub stores a sibling PNG and replaces
the base64 blob with `screenshotFile` in the on-disk JSON. Payloads without
`screenshot` remain valid.

**Schema v1.1** (backward compatible with v1.0): adds an optional
`elements[].edits` object carrying structured desired changes per element.
v1.0 payloads (no `edits`) remain valid; the hub accepts both.

## Data locations

| Source of truth | Path |
|---|---|
| Default data dir | `~/.browserlink/` (override: `BROWSERLINK_DATA_DIR`, back-compat: `HERMES_HOME/annotations`) |
| Inbox | `<data>/annotations/<ts>.json` - `ts = YYYYMMDD-HHMMSS-mmm` |
| Delivery target | `<data>/target.json` - active harness session for delivery |

All writes are atomic (temp file + `os.replace`). Filenames are validated with
`^[A-Za-z0-9._-]+$` - anything containing `/`, `\`, or `..` is rejected with
HTTP 400.

## POST /annotations

```json
{
  "source": "browserlink-extension",
  "url": "https://example.com/en/konfigurator/",
  "title": "Configurator",
  "viewport": { "w": 1500, "h": 993 },
  "label": "wp-admin check",
  "strokes": [
    { "color": "#ff5252", "width": 4,
      "points": [[0.1, 0.2], [0.15, 0.25], [0.2, 0.22]] }
  ],
  "elements": [
    { "index": 1, "tag": "button", "id": "submit", "className": "btn",
      "text": "Log in", "href": null, "ariaLabel": null,
      "cssPath": "html body form button",
      "rect": { "x": 0.4, "y": 0.5, "w": 0.2, "h": 0.05 },
      "instruction": "Make this blue and round",
      "intent": "fix",
      "severity": "blocking",
      "edits": { "width": "48px", "fontSize": "16px", "color": "#0af",
                 "text": "Shop now" } }
  ]
}
```

### Field rules

| Field | Type | Rules |
|---|---|---|
| `source` | string | required; identifies the sender |
| `url` | string | required; the annotated page |
| `title` | string | optional |
| `viewport` | object | required; `w`, `h` positive integers |
| `label` | string | optional; user context label, ≤ 200 chars |
| `strokes` | array | required; each: `color` string, `width` number > 0, `points` array of ≥ 2 `[x, y]` pairs, each coordinate in `[0, 1]` (normalized to the annotation viewport) |
| `elements` | array | optional; each: `index` int, `tag` string, `id`/`className`/`text` (≤ 200)/`href`/`ariaLabel` optional strings, `cssPath` optional, `rect` optional normalized box, `instruction` optional string ≤ 500, `edits` optional object (see below), `intent`/`severity` optional enums (schema v1.6, see below) |
| `screenshot` | string | optional (schema v1.4); PNG data URL `data:image/png;base64,<data>`; max 10MB decoded; non-PNG or invalid base64 → HTTP 400 |
| `captureState` | object | optional (schema v1.6); Freeze State Capture metadata, exactly four typed fields (see below); unknown keys → HTTP 400 |

The hub stores the payload and may rewrite `screenshot` (see below). It may
add `ts` (epoch ms) and `savedAt` (ISO-8601 UTC).

### screenshot (schema v1.4)

Optional PNG capture of the visible tab (or a cropped region) as a data URL.

Wire format (POST body):

- Must be a string starting with `data:image/png;base64,`
- Decoded size must be ≤ 10MB; otherwise HTTP 400
- Non-PNG data URLs (e.g. `data:image/jpeg;base64,...`) are rejected with HTTP 400

On-disk format:

- Hub decodes the PNG and writes `<timestamp>.png` next to the annotation JSON
  using the same atomic temp+replace pattern
- Stored JSON replaces `screenshot` with `"screenshotFile": "<timestamp>.png"`
  (never stores megabytes of base64 in the JSON)
- Payloads without `screenshot` are stored unchanged (backward compatible)

Delivery (Hermes adapter):

- When `screenshotFile` exists on disk, the delivery message prepends
  `@image:<abs path to png>`
- When the annotation JSON exists, the message appends
  `@file:<abs path to annotation json>` as the last line
- Both lines are omitted when the corresponding file is missing

### elements[].edits (schema v1.1, extended in v1.5)

Optional object mapping a CSS/text property to the DESIRED new value. Every
value must be a string; keys are restricted to:

`width`, `height`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`,
`color`, `backgroundColor`, `text`, `href`, `display`, `margin`, `padding`,
`borderRadius`, `textAlign`, `textTransform`, `letterSpacing`, `wordSpacing`,
`whiteSpace`, `verticalAlign`, `textDecoration`, `fontStyle`, `textShadow`

Rules:

- `instruction` stays the free-text field; `edits` is the structured change list.
- Unknown keys are rejected by hub validation with HTTP 400.
- Non-string values are rejected by hub validation with HTTP 400.
- Consumers apply the edits onto the captured element; values are applied as
  given (CSS values for style properties, plain text for `text`/`href`).

### elements[].intent and elements[].severity (schema v1.6)

Optional per-element metadata picked in the element chat card and stored inside
`elements[]` (never duplicated at the top level). Both fields are optional and
independent: an element can carry either, both, or neither. The hub validates
them as strict enums.

| Field | Type | Allowed values |
|---|---|---|
| `intent` | string (enum) | `fix`, `change`, `question`, `approve` |
| `severity` | string (enum) | `blocking`, `important`, `suggestion` |

Rules:

- Absent fields are always valid (backward compatible with all earlier
  schemas); they mean "not specified".
- Wrong types (e.g. `"intent": 42`) and unknown values (e.g.
  `"severity": "urgent"`) are rejected by hub validation with HTTP 400.
- The wire key is `severity`; harness-facing text renders it under the
  user-facing label **Priority**.

### captureState (schema v1.6)

Optional top-level object carrying Freeze State Capture metadata: whether the
page's CSS animations and transitions were paused for the capture period, and
the observed hovered / focused / open-details state at send time. The
extension reports observed state only; it never emulates `:hover` or other
pseudo-classes. Payloads without `captureState` are stored unchanged
(backward compatible with every earlier schema).

```json
"captureState": {
  "animationsFrozen": true,
  "hoveredSelector": "p#format-me",
  "activeElementSelector": "input#big-input",
  "openDetailsSelectors": ["details#open-me"]
}
```

| Field | Type | Rules |
|---|---|---|
| `animationsFrozen` | boolean | **required** whenever `captureState` is present; true while the Freeze control is active (one extension-owned style element pauses animations and zeroes transition duration/delay for the capture period) |
| `hoveredSelector` | string \| null | optional; the last meaningful hovered selector observed by the element-mode hover tracking, or null when none was observed |
| `activeElementSelector` | string \| null | optional; `document.activeElement` selector when it is a real page element, or null (never the extension's own UI) |
| `openDetailsSelectors` | array of strings | optional; cssPath of every open native `<details[open]>` element at send time; `[]` when none |

Rules:

- `captureState` must be an object with exactly these four fields; unknown
  keys are rejected by hub validation with HTTP 400.
- Wrong types (e.g. `"animationsFrozen": "true"`, a number in
  `openDetailsSelectors`) are rejected with HTTP 400.
- Selectors are informational metadata for the harness; consumers must not
  rely on them being live `querySelector` targets (elements may change
  between capture and consumption).

### Responses

- `200` → `{"ok": true, "file": "<ts>.json"}`
- `400` → `{"error": "<message>"}` (schema violation, bad filename)
- `404` → `{"error": "annotation not found"}`
- `413` → `{"error": "payload too large"}`

## GET /target and POST /target

Delivery target for invoke-and-connect from any harness chat. Persisted as
`<data>/target.json`.

### GET /target

- `200` → current target object
- `404` → `{"error": "no target"}`

Example `200` body:

```json
{
  "sessionId": "20260810_120000_abcd12",
  "label": "Claude Code SEO",
  "ts": 1723300000000,
  "activate": true
}
```

### POST /target

Body:

```json
{
  "sessionId": "20260810_120000_abcd12",
  "label": "Claude Code SEO",
  "activate": true
}
```

| Field | Type | Rules |
|---|---|---|
| `sessionId` | string | required; non-empty, ≤ 200 chars (empty alone → HTTP 400) |
| `label` | string | optional; ≤ 200 chars; default `""` |
| `activate` | bool | optional; default `false`. When `true`, the extension polls and injects once |

Special case for disconnect: `{"sessionId": "", "activate": false}` clears the
stored target and returns `{"ok": true}`.

Responses:

- `200` → `{"ok": true}`
- `400` → `{"error": "<message>"}` (empty `sessionId` without disconnect, bad types)

Stored record shape: `{"sessionId", "label", "ts", "activate"}`.

## POST /activate

Ack / merge endpoint used by the extension after it injects on connect, and by
MCP `browserlink_connect` when `activate=true`.

Body:

```json
{ "active": false }
```

| Field | Type | Rules |
|---|---|---|
| `active` | bool | required |

Merges into existing `target.json`, keeping `sessionId` and `label`, updating
`activate` (from `active`) and `ts`. If no target exists yet, writes a record
with empty `sessionId`/`label`.

Responses:

- `200` → `{"ok": true}`
- `400` → `{"error": "<message>"}`

## Reading annotations

| Endpoint | Returns |
|---|---|
| `GET /annotations` | `{"files": [{"name","size","mtime"}]}` newest first |
| `GET /annotations/<name>` | the stored JSON (same schema, plus `ts`, `savedAt`) |
| `GET /health` | `{"ok": true, "version": "1.0.0"}` |
| `GET /status` | `{"ok": true, "version", "dataDir", "adapters": [...], "target": {"sessionId","label"} or null}` |
| `GET /target` | current delivery target, or `404 {"error":"no target"}` |
| `POST /target` | set or clear delivery target |
| `POST /activate` | merge `activate` flag into `target.json` |

## Coordinates

All coordinates are **normalized** to the annotation viewport at capture time:
`nx = clientX / viewport.w`, `ny = clientY / viewport.h`, clamped to `[0, 1]`.
Consumers map them back by multiplying with their own viewport dimensions.
`rect` boxes follow the same normalization.

## Versioning

This is **schema v1.6**: backward compatible with v1.0 through v1.5. The
v1.6 additions are additive and optional: the per-element `intent` /
`severity` enums and the top-level `captureState` object; older payloads
validate and store unchanged. Schema v1.5 extended
`elements[].edits` with text-formatting keys. Schema v1.4 added optional
`screenshot` / `screenshotFile`. Schema v1.1 added optional `elements[].edits`.
Breaking changes (new required fields, coordinate semantics, endpoint removal)
bump to v2 with a deprecation window: the hub accepts both versions for one
minor release.
