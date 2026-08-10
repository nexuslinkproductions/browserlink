# browserlink protocol — annotation schema v1

The public contract between the extension, the hub, and any harness. Versioned;
changes require a new major version and a compatibility shim.

## Data locations

| Source of truth | Path |
|---|---|
| Default data dir | `~/.browserlink/` (override: `BROWSERLINK_DATA_DIR`, back-compat: `HERMES_HOME/annotations`) |
| Inbox | `<data>/annotations/<ts>.json` — `ts = YYYYMMDD-HHMMSS-mmm` |
| Session target | `<data>/session.json` |

All writes are atomic (temp file + `os.replace`). Filenames are validated with
`^[A-Za-z0-9._-]+$` — anything containing `/`, `\`, or `..` is rejected with
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
      "instruction": "Make this blue and round" }
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
| `elements` | array | optional; each: `index` int, `tag` string, `id`/`className`/`text` (≤ 200)/`href`/`ariaLabel` optional strings, `cssPath` optional, `rect` optional normalized box, `instruction` optional string ≤ 500 |

The hub stores the payload verbatim and adds `ts` (epoch ms) and `savedAt`
(ISO-8601 UTC).

### Responses

- `200` → `{"ok": true, "file": "<ts>.json"}`
- `400` → `{"error": "<message>"}` (schema violation, bad filename)
- `404` → `{"error": "annotation not found"}`
- `413` → `{"error": "payload too large"}`

## Reading annotations

| Endpoint | Returns |
|---|---|
| `GET /annotations` | `{"files": [{"name","size","mtime"}]}` newest first |
| `GET /annotations/<name>` | the stored JSON (same schema, plus `ts`, `savedAt`) |
| `GET /health` | `{"ok": true, "version": "1.0.0"}` |
| `GET /status` | `{"ok": true, "version", "dataDir", "adapters": [...]}` |
| `GET/POST /session` | connection target: `{"url": "…", "ts": …}` |

## Coordinates

All coordinates are **normalized** to the annotation viewport at capture time:
`nx = clientX / viewport.w`, `ny = clientY / viewport.h`, clamped to `[0, 1]`.
Consumers map them back by multiplying with their own viewport dimensions.
`rect` boxes follow the same normalization.

## Versioning

This is **schema v1**. Breaking changes (new required fields, coordinate
semantics, endpoint removal) bump to v2 with a deprecation window: the hub
accepts both versions for one minor release.
