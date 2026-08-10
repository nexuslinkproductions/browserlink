# browserlink v1.3 — Invoke & Connect from Any Chat (Update B)

Repo: /Users/marcelspatz/browserlink. Ships as its OWN PR (feat/connect-v1.3 -> main),
tag v1.3.0 after merge. Do NOT touch the v1.2 (inspector) feature files.

Goal: from ANY harness chat (Hermes, Claude Code, Cursor, Codex, ...), a user
can invoke the tool — the browser extension activates and annotations deliver
to THAT chat — without manually linking chat to tool.

## Architecture
  any harness chat -> MCP tool browserlink_connect(sessionId, label, activate)
        -> POST http://127.0.0.1:8787/target  (hub persists target.json)
        -> POST http://127.0.0.1:8787/activate (sets activate flag, acked)
        -> extension service worker polls GET /target (chrome.alarms, 30s)
        -> sends browserlinkToggle enabled:true to the active tab (inject)
  annotations -> hub -> hermes adapter resolves session: target.sessionId
        (from target.json, fresh per delivery) OVERRIDES HERMES_SESSION_ID env

## File ownership (single worker)
server/hub.py, server/adapters/hermes.py, mcp/mcp_server.py,
extension/service-worker.js, extension/popup.js, docs/protocol.md,
docs/mcp.md, README.md, CHANGELOG.md, tests/test_hub.py, tests/test_mcp.py
(plus new tests/test_target.py if cleaner). No git. No hermes config.

## Requirements
1. HUB (server/hub.py):
   - GET /target -> target.json content or 404 {"error":"no target"}
   - POST /target body {sessionId: str (non-empty, max 200), label: str? max
     200, activate: bool?} -> atomic write target.json {"sessionId","label",
     "ts","activate"} ; {"ok":true}
   - POST /activate body {active: bool} -> atomic write {"active": active,
     "ts"} into target.json (merge, keep sessionId/label); {"ok":true}
   - /status response gains "target": {"sessionId","label"} or null
2. HERMES ADAPTER (server/adapters/hermes.py):
   - session resolution per delivery: read target.json fresh; sessionId there
     wins; else HERMES_SESSION_ID env; else adapter no-ops with a logged note
   - delivery message: "📎 browserlink annotation\nURL: <url>\nTitle: <title>
     \nLabel: <label>\nE1: button#submit.btn 'Log in' - instruction: ... -
     edits: width=48px fontSize=16px\n..." (elements enumerated; strokes
     summarized as "N stroke(s)")
3. MCP (mcp/mcp_server.py) — new tools (keep existing ones):
   - browserlink_connect(sessionId: str, label: str = "", activate: bool =
     True) -> hub POST /target + /activate; returns {"ok", "sessionId",
     "label", "activate"}
   - browserlink_disconnect() -> hub POST /target with activate:false and
     empty sessionId; {"ok":true}
   - browserlink_status() -> hub GET /status + GET /target merged
   - mcp docs (docs/mcp.md): document the three tools + per-harness examples
     (Claude Code .mcp.json entry, Hermes: `hermes mcp add browserlink --command
     browserlink-mcp` as a user-side command — do NOT run it)
4. EXTENSION (extension/service-worker.js):
   - chrome.alarms.create("browserlink-poll", {periodInMinutes: 0.5}) on
     install/startup; alarm handler: GET <endpoint>/target; if target.activate
     true -> chrome.tabs.query({active:true,currentWindow:true}) -> send
     browserlinkToggle enabled:true -> POST /activate {active:false} (ack,
     so it only injects once per connect)
   - keep existing annotate/hubStatus handlers intact
5. POPUP (extension/popup.js): status row shows "Delivered to: <label>"
   (or sessionId, or "not connected") from GET /target (fetched via SW
   hubStatus-style message or direct fetch)
6. DOCS: protocol.md documents /target and /activate; README gains an
   "Invoke from any chat" section; CHANGELOG [1.3.0] entry. No em-dashes.
7. TESTS: test_hub.py: /target POST+GET round trip, activate merge keeps
   sessionId, empty sessionId rejected (400); test_mcp.py: connect/disconnect/
   status against a temp-data-dir hub (direct function calls, stdio not
   required); adapter test: target.json sessionId wins over env.

## Acceptance (run and report)
py_compile on changed python; pytest -q green (venv /Users/marcelspatz/
browserlink/.venv/bin/python, PYTHONPATH unset); node --check
service-worker.js popup.js; live curl: POST /target, GET /target, POST
/activate, GET /status (temp BROWSERLINK_DATA_DIR, port 8789, clean up);
grep: alarms poll + activate ack in SW, adapter target-over-env resolution.
