# browserlink REST API

The local hub (`browserlink-hub`) listens on `127.0.0.1:8787` by default
(`--port` to change). All responses are UTF-8 JSON unless noted. CORS is
open (`Access-Control-Allow-Origin: *`, methods `GET,POST,OPTIONS`, headers
`Content-Type`); `OPTIONS` answers `204`.

Data dir resolution: `BROWSERLINK_DATA_DIR`, else `HERMES_HOME/annotations`,
else `~/.browserlink/annotations`. Annotations are stored under
`<data>/annotations/` as `<timestamp>.json` plus an optional sibling
`<timestamp>.png` when the payload carried a screenshot.

## Health and status

| Route | Method | Response |
|---|---|---|
| `/health` | GET | `{ok: true, version: "2.5.0"}` |
| `/status` | GET | `{ok, version, dataDir, adapters, target}` (target is `{sessionId,label}` or `null`) |
| `/sessions` | GET | `{sessions: [{id,title,preview,updatedAt}]}` proxied from Hermes; `503` when `HERMES_API_URL`/`HERMES_API_KEY` are unset, `502` on upstream failure |

## Target and activation

| Route | Method | Body | Response |
|---|---|---|---|
| `/target` | GET | - | stored target or `404 {error: "no target"}` |
| `/target` | POST | `{sessionId, label?, activate?}` | `{ok: true}`; `{sessionId: "", activate: false}` clears the target |
| `/activate` | POST | `{active: boolean}` | `{ok: true}`; merges `activate` into the stored target |

## Annotations

| Route | Method | Body | Response |
|---|---|---|---|
| `/annotations` | GET | - | `{files: [{name, size, mtime}]}` newest first (JSON files only) |
| `/annotations` | POST | annotation payload (schema v1.6) | `200 {ok: true, file: "<name>.json"}`; `400` validation error, `413` payload over 10 MB, `400` malformed JSON |
| `/annotations/<name>` | GET | - | stored annotation JSON or `404 {error: "not found"}` |
| `/annotations/<name>/export.md` | GET | - | `200` Markdown AI brief (`text/markdown; charset=utf-8`) or `404` |
| `/annotations/latest/export.md` | GET | - | `200` Markdown AI brief of the newest annotation or `404` |

Annotation names must match `^[A-Za-z0-9._-]+$`; unsafe names (traversal
like `..`, slashes) and missing files answer `404 {error: "not found"}`
everywhere, including the export routes.

## Export (Copy AI Brief)

`GET /annotations/<name>/export.md` renders one stored annotation as a
deterministic Markdown brief for an AI harness:

- `# AI Brief` with `## Page` (URL, title, viewport), `## Label`, `## Notes`
- `## Elements`: per element - tag, CSS path, text snippet, instruction,
  Intent and Priority labels, structured `edits`
- `## Capture State` when `captureState` was recorded (animations frozen,
  hovered/focused selectors, open details selectors)
- `## Strokes`: count and colors
- `## Files`: the annotation JSON name plus `@file:` and (when a screenshot
  was stored) `@image:` absolute path references

`GET /annotations/latest/export.md` is an alias for the newest annotation.
The popup's **Copy AI Brief** button lists `/annotations`, takes the newest
entry, fetches its `export.md`, and copies it to the clipboard.

## Example

```bash
curl -s http://127.0.0.1:8787/annotations/latest/export.md
```

```markdown
# AI Brief

## Page
- URL: https://example.test/shop/cart
- Title: Cart page
- Viewport: 1440x900
...
```
