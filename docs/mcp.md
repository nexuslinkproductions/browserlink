# browserlink MCP tools

The MCP server (`browserlink-mcp`) speaks stdio and exposes read tools for the
annotation inbox plus connect tools that point the local hub at the current
chat. Requires hub listening on `http://127.0.0.1:8787` (override with
`BROWSERLINK_HUB_URL`).

## Annotation tools

| Tool | Args | Returns |
|---|---|---|
| `hub_status` | none | `{ok, version, dataDir, adapters}` from local data-dir resolution |
| `annotations_list` | `limit` (default 20); `q`, `url`, `since`, `cssPathPrefix`, `hasEdits`, `intent`, `severity` (all optional) | newest-first file list `{name,size,mtime}`, filtered with AND semantics and the same normalization, ordering, and result set as `GET /annotations?q=&url=&since=` |
| `annotations_latest` | none | newest annotation object, or `{}` |
| `annotations_get` | `name` | one annotation by safe file name |
| `annotations_watch` | `seconds` (default 10) | names of files that appear while waiting |

## Connect tools (v1.3)

| Tool | Args | Behavior |
|---|---|---|
| `browserlink_connect` | `sessionId` (required), `label` (default `""`), `activate` (default `true`) | `POST /target` then, when `activate` is true, `POST /activate {active:true}`. Returns `{ok, sessionId, label, activate}` |
| `browserlink_disconnect` | none | `POST /target` with empty `sessionId` and `activate:false` (clears target). Returns `{ok:true}` |
| `browserlink_status` | none | Merges hub `GET /status` with `GET /target` into `{ok, version, dataDir, adapters, target}` |

Typical flow from any harness chat:

1. Call `browserlink_connect(sessionId="<this chat>", label="seo task")`.
2. Extension polls `GET /target`, injects overlay once, then acks via
   `POST /activate {active:false}`.
3. Annotate and Send; Hermes adapter delivers to `target.sessionId`.
4. Call `browserlink_disconnect()` when done.

## Per-harness setup

### Claude Code

Add to `.mcp.json` (project or user):

```json
{
  "mcpServers": {
    "browserlink": {
      "command": "browserlink-mcp"
    }
  }
}
```

Install the package first (`npm install -g .` from the repo, or an
equivalent install that puts `browserlink-mcp` on `PATH`).

### Hermes

User-side command (do not run this from automation unless the user asked):

```bash
hermes mcp add browserlink --command browserlink-mcp
```

Then in a chat, invoke `browserlink_connect` with that chat's session id.

### Other MCP clients (Cursor, Codex, OpenCode, ...)

Any client that can spawn a stdio MCP server works with the same command:

```json
{ "command": "browserlink-mcp" }
```

Optional env:

- `BROWSERLINK_HUB_URL` - hub base URL (default `http://127.0.0.1:8787`)
- `BROWSERLINK_DATA_DIR` - shared with the hub for annotation reads

## Notes

- Connect tools talk to the hub over HTTP (`urllib`). The hub must be running.
- Annotation list/get/watch read the filesystem under `BROWSERLINK_DATA_DIR`
  (or the Hermes / default fallbacks documented in `docs/protocol.md`).
- `annotations_list` search filters (F7) mirror the hub REST search: `q` is
  a case-insensitive NFC-normalized substring match across label, URL, page
  title, notes, and per-element text and instruction; `url` and `since`
  compose with AND; an invalid `since` rejects with an error. Records that
  cannot be read are skipped exactly like the REST route's `skippedCorrupt`
  diagnostics, so REST and MCP return the same names in the same order.
- Programmatic filters (F10): `cssPathPrefix`, `hasEdits`, `intent`, and
  `severity` compose with `q`, `url`, and `since` using AND semantics and
  keep the stable newest-first ordering. `cssPathPrefix` is an
  NFC-normalized, case-insensitive prefix over any element's `cssPath`
  (an annotation matches when any element's path starts with the prefix).
  `hasEdits: true` keeps only annotations whose elements include at least
  one non-empty `edits` array; `hasEdits: false` keeps only annotations
  with no element edits (an empty `edits: []` does not count as edits).
  `intent` and `severity` match when any element carries the value, with
  the strict schema enumerations: `fix | change | question | approve` and
  `blocking | important | suggestion`. Validation errors are documented and
  deterministic: an invalid `since` rejects with `invalid since timestamp`,
  an invalid `intent` with `intent must be one of fix, change, question,
  approve`, and an invalid `severity` with `severity must be one of
  blocking, important, suggestion`; the tool schema also rejects unknown
  enum values up front. A negative `limit` rejects with `limit must be
  non-negative`.
- Delivery to Hermes still needs `HERMES_API_URL` and `HERMES_API_KEY` on the
  hub process; the session comes from `target.json` when connected.
