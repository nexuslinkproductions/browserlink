# AGENTS.md

## Project overview

Browserlink is an MV3 browser annotation extension plus a local TypeScript hub and stdio MCP server.
It captures strokes, selected elements, notes, and cropped screenshots, then routes the stored annotation to an AI harness, primarily the Hermes desktop composer.

## Architecture map

- Extension: `extension/content.js` draws/selects/inspects and builds payloads; `extension/service-worker.js` captures, crops, and POSTs; `extension/popup.js` configures the hub and target session; `extension/manifest.json` defines MV3 wiring and permissions.
- TypeScript hub: `ts/src/cli-hub.ts` starts the local server; `ts/src/hub.ts` owns HTTP routes, persistence, validation, target state, and adapter dispatch; `ts/src/schema.ts` owns shared validation, limits, data paths, and logs.
- MCP: `ts/src/cli-mcp.ts` starts the stdio server; `ts/src/mcp.ts` exposes annotation read/watch and connect/status tools and uses `BROWSERLINK_HUB_URL`.
- Delivery adapters: `ts/src/adapters/hermes.ts` attaches files to the Hermes composer, then falls back to session chat; `ts/src/adapters/webhook.ts` posts optional webhook deliveries.
- Docs and release authority: `README.md`, `docs/protocol.md`, `docs/mcp.md`, `CHANGELOG.md`, and `.github/workflows/ci.yml`. Treat executable code and `CHANGELOG.md` as authoritative when docs disagree.

## Commands and gates

| Check | Exact command | Working directory | Verifies |
|---|---|---|---|
| Build | `npm run build` | `ts/` | `tsc` compiles `ts/src` into `ts/dist` |
| Tests | `npm test` | `ts/` | Node test suite (`test/*.test.ts`), including hub, MCP, and schema behavior |
| Typecheck | `npm run typecheck` | `ts/` | Strict `tsc --noEmit` type validation |
| Extension syntax | `node --check extension/content.js && node --check extension/service-worker.js && node --check extension/popup.js` | repo root | Parses every extension JS entrypoint; CI's multi-file form (`node --check a b c`) only checks the FIRST file, so prefer the chained command in CI too |
| Manifest check | `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"` | repo root | Parses `extension/manifest.json` as JSON |

Run `npm ci` in `ts/` before the TypeScript commands when dependencies are absent. There is no lint, formatter, or `scripts/` directory. Node 22+ is required by `ts/package.json`.

## Delivery chain

1. `extension/content.js` `send()` builds the annotation and `captureRect`, hides capture-sensitive overlay pieces, flushes with double `requestAnimationFrame`, and sends `{type: "annotate", payload}` to the service worker.
2. `extension/service-worker.js` handles the message, calls `chrome.tabs.captureVisibleTab`, and crops with `OffscreenCanvas` to the dpr-aware rect. If a requested crop fails, it omits the screenshot rather than storing an overlay-polluted full-page image. It then POSTs JSON to `<hub>/annotations`.
3. `ts/src/hub.ts` validates the body, enforces the request cap, atomically stores JSON under `<data>/annotations/`, extracts the PNG beside it, and dispatches configured adapters.
4. `ts/src/adapters/hermes.ts` resolves the session as `annotation.sessionId > target.json > HERMES_SESSION_ID`, builds attachment chips, and POSTs `{sessionId, attachments}` to `${HERMES_API_URL}/api/composer/attach`. A 2xx is primary success: screenshot and annotation JSON appear as composer chips for the Hermes desktop composer, where the user sends them manually.
5. If attach has no attachments, returns 404 or another error, or has a network failure, the adapter falls back to `POST ${HERMES_API_URL}/api/sessions/<sessionId>/chat`. The fallback carries formatted text, a real image part when available, and file/image references. Dedupe is by annotation id. Missing Hermes URL/key means no Hermes delivery.

Important environment variables:
`HERMES_API_URL`, `HERMES_API_KEY`, `HERMES_SESSION_ID`, `HERMES_HOME`, `BROWSERLINK_DATA_DIR`, `BROWSERLINK_WEBHOOK_URL`, and `BROWSERLINK_HUB_URL`, plus `HERMES_PROVIDER` and `HERMES_MODEL` (explicit /chat fallback routing overrides; they supersede the session `model_config` for fallback chat delivery only).
`BROWSERLINK_DATA_DIR` wins for data storage, then `HERMES_HOME/annotations`, then `~/.browserlink/annotations`. `BROWSERLINK_HUB_URL` selects the MCP client's hub base URL. `BROWSERLINK_WEBHOOK_URL` enables the webhook adapter.

## Hard repo conventions

- Never introduce U+2014 em-dash characters in an edited file. Use a hyphen.
- MV3 means service-worker-only background execution, no remote code, and permissions exactly centered on `activeTab`, `storage`, `scripting`, and `alarms`.
- Version tracks are separate: extension version in `extension/manifest.json`; hub package version in `ts/package.json` plus `VERSION` constants; release truth is the head of `CHANGELOG.md`. Do not silently synchronize tracks.
- Limits are contracts: decoded screenshot 10MB; formatted content body 20,000 characters, excluding the appended `@image:`/`@file:` directive lines (probe: a 20,030-char message was produced with the file line intact); element instruction 500 characters (extension-enforced `MAX_INSTR`; hub validation does not inspect `instruction`); label 200 characters; annotation note queue 20 entries.
- `ts/src/schema.ts` `ALLOWED_EDIT_KEYS` is the edit-key source of truth. `docs/protocol.md` currently claims schema v1.5 text-format keys that the hub does not accept. Do not let docs get ahead of `ALLOWED_EDIT_KEYS`; update code and validation first when expanding the schema.

## Testing doctrine

Mechanism checks are mandatory gates before claiming success: build, test, typecheck, extension syntax, and manifest validation as applicable. Never claim success without actual command output and exit status.

Extension QA hooks are conditional. Set `window.__BL_TEST__` before injection; only then the extension exposes `window.__BL_TEST_API__` and `window.__BL_INSPECTOR__`. Behavioral verification must drive the shipped extension in a real browser, including capture, crop, popup targeting, send, diagnostics, and failure paths. Do not substitute static inspection for browser behavior.

## Git and release workflow

Use scoped commits. Add the corresponding `CHANGELOG.md` entry in the same commit, using Keep a Changelog sections and ordering. Before release, verify the README version badge matches the CHANGELOG head, and verify docs match executable behavior. Review `git diff`, run mandatory gates, and report the actual outputs.

## Diagnostics

Open the live overlay with Ctrl+Shift+D (Cmd+Shift+D on macOS). The same dump is exposed as `window.__browserlinkDiag`. Health checks are D-1 host attached, D-2 shadow root, D-3 canvas and 2d context, D-4 toolbar/chat/inspector references, D-5 GSAP loaded, and D-6 runtime listener bound. Structured success and error lines are appended to `browserlink-error.log` in the resolved data directory, normally `~/.browserlink/annotations/browserlink-error.log`.
