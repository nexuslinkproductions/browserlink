# browserlink v2.0 - TypeScript rewrite (hub + MCP, shared schema)

Repo: /Users/marcelspatz/browserlink. Ships as its own PR (feat/ts-v2 -> main),
tag v2.0.0 after merge. The Python implementation stays as the legacy path
(server/ + mcp/ untouched) until the TS hub is proven in production, then is
removed in a follow-up.

## Goal
Rewrite the hub and MCP server in TypeScript/Node with a SHARED schema module
so the annotation contract lives in exactly one place. Drop-in compatible:
same REST contract, same data dir, same env vars, same target.json semantics,
same MCP tool names. The extension is untouched (it speaks HTTP).

## Stack
- Node 22, TypeScript ^7.0.2 (native compiler, devDependency), no build step
  beyond tsc; run via node dist/ or tsx in dev
- MCP via @modelcontextprotocol/sdk (stdio transport)
- Tests: node:test (built-in) + supertest-style fetch against a live server
- Package: name "browserlink-mcp", bin "browserlink-mcp" -> dist/mcp.js,
  npx-installable; also "browserlink-hub" bin -> dist/hub.js
- Layout (new top-level dirs, do NOT touch server/ or mcp/):
  ts/package.json, ts/tsconfig.json, ts/src/schema.ts, ts/src/hub.ts,
  ts/src/adapters/hermes.ts, ts/src/adapters/webhook.ts, ts/src/mcp.ts,
  ts/src/cli-hub.ts, ts/src/cli-mcp.ts, ts/test/*.test.ts,
  ts/README.md (or fold into root README section)

## File ownership (two workers, disjoint)
Worker A (Luna): ts/src/schema.ts, ts/src/hub.ts, ts/src/adapters/*.ts,
  ts/src/cli-hub.ts, ts/test/hub.test.ts, ts/test/schema.test.ts
Worker B (Luna): ts/package.json, ts/tsconfig.json, ts/src/mcp.ts,
  ts/src/cli-mcp.ts, ts/test/mcp.test.ts, .github/workflows/ci.yml (add a
  node job), README.md (TS quickstart section), CHANGELOG.md [2.0.0] entry
No git. No hermes config. Do NOT touch server/, mcp/, extension/.

## Contract (must match the Python hub exactly)
- GET /health -> {"ok":true,"version":"2.0.0"}
- GET /status -> {"ok":true,"version":"2.0.0","dataDir":str,"adapters":[...],
  "target":{sessionId,label}|null}
- POST /annotations: validate schema v1.4 (source, url, title?, viewport{w,h},
  label?, strokes[{color,width,points[[nx,ny]]}], elements[{index,tag,id?,
  classes?,text?,href?,cssPath?,rect?,instruction?,edits?}], screenshot?
  data:image/png;base64, max 10MB decoded); unknown edits keys -> 400; atomic
  write <ts>.json (temp+rename+fsync); screenshot decoded to <ts>.png, JSON
  stores "screenshotFile" instead of base64; adapters dispatched async
  (fire-and-forget, never block the response); 200 {"ok":true,"file":name}
- GET /target -> target.json or 404 {"error":"no target"}
- POST /target {sessionId (1..200), label? (<=200), activate? bool} -> atomic
  write; empty sessionId -> 400
- POST /activate {active:bool} -> merge into target.json keeping sessionId/
  label; {"ok":true}
- Data dir resolution: BROWSERLINK_DATA_DIR -> HERMES_HOME/annotations ->
  ~/.browserlink/annotations (same as Python)
- Env: HERMES_API_URL, HERMES_API_KEY, HERMES_SESSION_ID, BROWSERLINK_WEBHOOK_URL
- Hermes adapter: target.json sessionId wins over env; message format:
  "browserlink annotation" + URL/Title/Label lines + "E1: tag#id 'text' -
  instruction: ... - edits: width=48px fontSize=16px" + "N stroke(s)";
  @image:<abs png> prepended when screenshotFile exists, @file:<abs json>
  appended last; timeout 300s; no retry (no duplicates)
- Webhook adapter: POST BROWSERLINK_WEBHOOK_URL with the stored JSON, failure
  logged, never blocks

## MCP tools (same names as Python)
hub_status, annotations_list, annotations_latest, annotations_get,
annotations_watch, browserlink_connect(sessionId,label?,activate?),
browserlink_disconnect, browserlink_status

## Acceptance (run and report)
Worker A: npx tsc --noEmit clean; node --test ts/test/ green; live curl
  round trip on port 8792 with temp BROWSERLINK_DATA_DIR: POST /annotations
  with 1x1 PNG -> 200 + PNG + screenshotFile; POST /target + GET /target +
  POST /activate + GET /status; traversal guard (../) -> 404; clean up.
Worker B: npx tsc --noEmit clean; node --test ts/test/ green; MCP tools
  exercised against a temp-data-dir hub via direct function calls; package
  builds (npm pack dry run); CI node job added; README/CHANGELOG updated,
  no em-dashes.
