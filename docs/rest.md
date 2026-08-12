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
| `/health` | GET | `{ok: true, version: "2.6.0"}` |
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
| `/annotations` | GET | - | `{files: [{name, size, mtime}]}` newest first (JSON files only); optional `q`, `url`, and `since` query params filter the corpus (see [Search](#search-f7)) |
| `/annotations` | POST | annotation payload (schema v1.8) | `200 {ok: true, file: "<name>.json"}`; `400` validation error, `413` payload over 10 MB, `400` malformed JSON |
| `/annotations/<name>` | GET | - | stored annotation JSON or `404 {error: "not found"}` |
| `/annotations/<name>/export.md` | GET | - | `200` Markdown AI brief (`text/markdown; charset=utf-8`) or `404` |
| `/annotations/latest/export.md` | GET | - | `200` Markdown AI brief of the newest annotation or `404` |
| `/annotations/<name>/share` | GET | - | `200` read-only HTML share page (`text/html; charset=utf-8`) or `404` |
| `/annotations/latest/share` | GET | - | `200` read-only HTML share page of the newest annotation or `404` |
| `/annotations/<name>/share.png` | GET | - | `200` stored screenshot PNG (`image/png`) referenced by the share page, or `404` |
| `/annotations/<name>/bundle` | GET | - | `200` deterministic ZIP bundle (`application/zip`, `Content-Disposition: attachment`) or `404` |
| `/annotations/latest/bundle` | GET | - | `200` bundle of the newest annotation or `404` when the corpus is empty |
| `/annotations/backup.zip` | GET | - | `200` full-corpus backup ZIP snapshot (`application/zip`); valid and explicit even when the corpus is empty |

Annotation names must match `^[A-Za-z0-9._-]+$`; unsafe names (traversal
like `..`, slashes) answer `400 {error: "invalid annotation name"}` on the
export and share routes, and `404` on the plain annotation read; missing
files answer `404 {error: "not found"}` everywhere.

## Search (F7)

`GET /annotations` accepts three optional query parameters that compose
with AND semantics:

| Param | Meaning |
|---|---|
| `q` | Full-text term: case-insensitive, NFC-normalized substring match across label, URL, page title, notes (and the legacy joined note), and per-element text and instruction |
| `url` | URL substring filter, matched with the same normalization as `q` |
| `since` | ISO 8601 timestamp; only annotations stored at or after it are returned. An unparseable value answers `400 {error: "invalid since timestamp"}` |

An empty or absent `q` (with no other filter) preserves the plain
newest-first list behavior and the exact `{files}` response shape. When any
filter is present the response is `{files, skippedCorrupt}`:
`skippedCorrupt` counts JSON records that could not be parsed and were
skipped, so one corrupt record can never fail the whole query. Results stay
newest-first, matching the plain list ordering.

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

## Share page (read-only)

`GET /annotations/<name>/share` renders one stored annotation as a
readable, read-only HTML page for a human (`text/html; charset=utf-8`):

- Page URL, title, viewport, label, notes, per-element tag/selector/text/
  instruction plus Intent and Priority chips, capture state, stroke count,
  and the stored screenshot (referenced via
  `GET /annotations/<name>/share.png`, same origin).
- All annotation-derived text is HTML-escaped and the response carries a
  restrictive Content-Security-Policy (`default-src 'none'`), so stored
  content cannot execute script.
- The page has no edit, delete, reply, upload, account, or cloud controls.
  It labels its reachability: the hub binds `127.0.0.1` by default, so the
  link is same-machine unless the operator deliberately bound the hub
  beyond loopback for LAN use. It is never a public link.
- An annotation without a stored screenshot renders an explicit
  no-screenshot state instead of a broken image.

Unsafe names answer `400 {error: "invalid annotation name"}`; missing files
answer `404 {error: "not found"}`. `GET /annotations/latest/share` is an
alias for the newest annotation. Reads never write to the data dir.

The popup's **Copy share link** button lists `/annotations`, takes the
newest entry, and copies `<endpoint>/annotations/<name>/share` to the
clipboard with a success state naming the annotation.

## Bundle and backup (local downloads)

`GET /annotations/<name>/bundle` downloads one annotation as a deterministic
ZIP archive (`application/zip`, `Content-Disposition: attachment; filename="<stem>-bundle.zip"`):

- `manifest.json` - `schema: "browserlink.annotation.bundle.v1"` plus the
  annotation name, the brief name, the PNG name (or `null` when the
  annotation has no screenshot), and the sorted list of included files.
- `<name>.json` - the stored annotation JSON, byte-for-byte identical to the
  file on disk.
- `<stem>.md` - the deterministic AI brief Markdown (the same sections as
  `GET /annotations/<name>/export.md`), but with `@file:`/`@image:`
  references RELATIVE to the bundle files, so the archive is portable
  across machines and never discloses absolute host filesystem paths.
- `<stem>.png` - the stored screenshot when present. A missing PNG is
  declared as `manifest.screenshot: null`; the bundle never contains a
  broken or fabricated image reference.

`GET /annotations/latest/bundle` is an alias for the newest annotation and
answers `404 {error: "not found"}` when the corpus is empty.

`GET /annotations/backup.zip` downloads one consistent snapshot of the whole
corpus (`Content-Disposition: attachment; filename="browserlink-backup.zip"`):

- `manifest.json` - `schema: "browserlink.corpus.backup.v1"`, `count`, a
  per-annotation `annotations` list (`{name, screenshot}`), and the sorted
  list of included files. An empty corpus yields a valid archive whose
  manifest declares `count: 0`.
- For every stored annotation: the JSON, the Markdown brief, and the PNG
  when present. Unreadable records are skipped, never fatal.

Determinism and safety: entries are name-sorted and carry a fixed timestamp,
so identical corpora produce byte-identical archives. Every entry name comes
from the safe-name rule `^[A-Za-z0-9._-]+$` (or the fixed `manifest.json`),
so archives contain only safe relative paths - never absolute filesystem
paths and never traversal names. Reads never write to the data dir.

Snapshot semantics: the hub stores each annotation as PNG first, then JSON
(both atomic renames). A backup that lists a JSON can therefore always read
its sibling PNG: every archive is a complete before-or-after snapshot of the
corpus, never a partial file set, even while annotations are being written
concurrently.

Unsafe names answer `400 {error: "invalid annotation name"}`; missing files
answer `404 {error: "not found"}`.

Downloads are browser-native: the extension fetches these routes and hands
the bytes to `chrome.downloads.download`, so the user picks the destination
through the browser's normal download dialog. Nothing is uploaded anywhere;
see [security.md](security.md).

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
