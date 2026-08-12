# browserlink protocol - annotation schema v1.8

The public contract between the extension, the hub, and any harness. Versioned;
changes require a new minor or major version and a compatibility shim.

**Schema v1.8** (backward compatible with v1.0 through v1.7): adds optional
per-element `elements[].anchor` metadata recording how a stored element was
re-anchored on a changed live page (resolution state, confidence, and the
deterministic fallback signals used, see below). Wrong types, unknown nested
keys, unknown enum values, and out-of-range numbers return HTTP 400; elements
without the field remain valid.

**Schema v1.7** (backward compatible with v1.0 through v1.6): adds optional
per-element `elements[].frame` and `elements[].shadow` deep-pick metadata
carrying same-origin iframe and open shadow-root reach information (see
below). Wrong types, unknown nested keys, and out-of-range values return HTTP
400; elements without either field remain valid.

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
| `elements` | array | optional; each: `index` int, `tag` string, `id`/`className`/`text` (≤ 200)/`href`/`ariaLabel` optional strings, `cssPath` optional, `rect` optional normalized box, `instruction` optional string ≤ 500, `edits` optional object (see below), `intent`/`severity` optional enums (schema v1.6, see below), `frame`/`shadow` optional deep-picker objects (schema v1.7, see below), `anchor` optional object (schema v1.8, see below) |
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

### elements[].frame and elements[].shadow (schema v1.7)

Optional per-element deep-pick metadata emitted by the F1 deep picker. Both
fields are independent and optional: an element can carry either, both, or
neither. Legacy elements without them are stored unchanged (backward
compatible with every earlier schema).

`frame` describes the same-origin iframe chain between the top document and
the element's document:

| Field | Type | Rules |
|---|---|---|
| `path` | array of ints | optional; iframe index chain from the top document to the element's document (`[]` or absent = top document); each entry is the index of the frame element among all `iframe`/`frame` elements in its parent document (document order); at most 8 entries, each a non-negative integer |
| `crossOrigin` | boolean | optional; `true` marks a bounded best-effort target: the element IS a cross-origin frame element whose inner DOM is not accessible, and `path` describes the chain to the document containing that frame element. The extension never claims or attempts inner-DOM access for such targets |

`shadow` describes the open shadow-host boundary chain between the document
and the element:

| Field | Type | Rules |
|---|---|---|
| `depth` | int | optional; number of open shadow boundaries crossed (0 or absent = flat DOM element); integer from 0 to 8 |
| `hosts` | array of strings | optional; cssPath of each shadow host from the document outward (hosts[0] is the outermost host, in the document; hosts[last] directly contains the element). Each entry is a non-empty string of at most 500 characters; at most 8 entries. Closed shadow roots are never represented |

Example:

```json
{ "index": 1, "tag": "span", "cssPath": "div > span:nth-of-type(2)",
  "frame": { "path": [0, 1] },
  "shadow": { "depth": 2, "hosts": ["#widget-host", "#inner-host"] } }
```

Rules:

- `frame` must be an object with only the keys `path` and `crossOrigin`;
  unknown nested keys (e.g. `"frame": { "url": "..." }`) are rejected by hub
  validation with HTTP 400.
- `shadow` must be an object with only the keys `depth` and `hosts`; unknown
  nested keys are rejected with HTTP 400.
- Wrong types, negative or non-integer `path` entries, overlong `path`/`hosts`
  lists, out-of-range `depth`, and empty/overlong host selectors are rejected
  with HTTP 400.
- `cssPath` stays root-relative: for shadow elements it resolves inside the
  innermost shadow root named by `hosts`, and for frame elements inside the
  document named by `frame.path`. Consumers replay in order: frame path, then
  shadow hosts, then cssPath.
- `rect` is always normalized to the TOP annotation viewport, including for
  elements inside same-origin iframes (the extension translates child-frame
  rectangles into top-level viewport coordinates).

### elements[].anchor (schema v1.8)

Optional per-element anchor metadata emitted by the F2 anchor-resilience
replay when a stored element is restored on a page whose DOM has drifted.
The field records the truthful resolution state so consumers know whether
the element was found exactly, re-anchored by fallback signals, or left
unresolved. Legacy elements without it are stored unchanged (backward
compatible with every earlier schema).

| Field | Type | Rules |
|---|---|---|
| `version` | int | required; the anchor format version, currently `1` |
| `resolution` | string enum | required; one of `exact` (original cssPath replay), `fallback` (deterministic signal chain below), `unresolved` (no candidate reached the confidence threshold) |
| `confidence` | number | optional; the 0..1 score of the winning path (`exact` 1, `attrs` 0.95, `text`/`aria` 0.85, `rect` 0.7); must be 0..1 when present |
| `fallback` | array of string enums | optional; the deterministic signals used, in order, each from `attrs`, `text`, `aria`, `rect`; non-empty and at most 4 entries; present only when `resolution` is `fallback` |

Example:

```json
{ "index": 1, "tag": "button", "cssPath": "ul#mut-list > li:nth-of-type(2)",
  "anchor": { "version": 1, "resolution": "fallback", "confidence": 0.85,
              "fallback": ["text"] } }
```

Replay order and rules:

- Exact `cssPath` replay is always the first and fastest path (frame path,
  then shadow hosts, then cssPath), exactly as in schema v1.7. It wins with
  confidence 1 when it resolves to exactly one usable (connected and
  visible) element.
- When the exact path fails, fallback signals run in fixed order:
  - stable attributes: the stored `id` (when present) must match exactly
    AND the stored class tokens (when present) must overlap at least 0.8;
  - normalized text/aria: whitespace-collapsed, case-insensitive match of
    the stored `text` (unique candidate), else of the stored `ariaLabel`;
  - prior rectangle proximity: a unique candidate within 0.18 of the
    stored normalized rect center (as a fraction of the viewport diagonal).
- A tier wins only when it finds exactly one usable candidate. Duplicate
  candidates, hidden or detached elements, and empty tiers fall through to
  the next tier; when no tier wins, the element stays `unresolved` and is
  never attached to a different element.
- `anchor` must be an object with only the keys `version`, `resolution`,
  `confidence`, and `fallback`; unknown nested keys, wrong types, unknown
  enum values, missing `version`/`resolution`, and `confidence` outside
  0..1 are rejected with HTTP 400.
- Re-anchoring never deletes stored drafts and never loops: history
  pushState/replaceState/popstate and hashchange collapse into one bounded
  pass after the DOM stabilizes, with no duplicate markers or listeners.

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
