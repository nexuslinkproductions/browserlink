# browserlink - Release Build Spec v1.0.0

Repo root: /Users/marcelspatz/browserlink (git, branch main, public release).
Goal: a GENERAL, harness-agnostic "annotate in your browser → deliver to any AI
harness" product. Comet is the flagship browser; Chrome/Edge/Brave/Arc all work
(the extension is plain MV3). Hermes is ONE adapter, never the core.

## Repo layout (final)
  extension/   MV3 extension: draw annotate + element picker + instruction chat
               + connection UI (configurable hub endpoint + status)
  server/      hub.py (local REST inbox) + adapters/ (hermes.py, webhook.py)
  mcp/         MCP server package (official `mcp` SDK) - the universal door
  docs/        protocol.md (schema v1 - THE public contract), mcp.md, rest.md,
               harnesses.md, security.md
  tests/       pytest: hub validation, schema, mcp tools
  README.md, LICENSE (MIT), CHANGELOG.md, .github/workflows/ci.yml

## Contracts (unchangeable by workers)
Schema v1 POST /annotations body:
  {source:str, url:str, title:str?, viewport:{w:int>0,h:int>0},
   label:str? (<=200), strokes:[{color:str,width:num>0,points:[[float,float] 0..1 len>=2]}],
   elements?:[{index:int, tag, id?, className?, text? (<=200), href?, ariaLabel?,
               cssPath?, rect?:{x,y,w,h normalized}, instruction? (<=500)}]}
Response: {"ok":true,"file":"<ts>.json"} | 4xx {"error":str}. ts=YYYYMMDD-HHMMSS-mmm.
Data dir resolution (hub, mcp, tests): $BROWSERLINK_DATA_DIR → $HERMES_HOME/annotations
(back-compat) → ~/.browserlink/annotations. Inbox subdir: <data>/annotations/.
Traversal guard: names ^[A-Za-z0-9._-]+$, reject "/", "\\", "..". Atomic writes.

## Worker A (deepseek-v4-flash) - extension/ ONLY
1. Brand: manifest.json name "Browserlink - Browser Annotate & Connect",
   version 1.1.0, description harness-agnostic. Replace any user-facing
   "Hermes" string in popup.html/popup.js with "Browserlink"/"hub".
2. service-worker.js: hub endpoint CONFIGURABLE - read chrome.storage.local
   key "endpoint" (default "http://127.0.0.1:8787"); POST <endpoint>/annotations;
   also handle {type:"hubStatus"} → GET <endpoint>/health → {ok:true} or
   {ok:false,error}. No hardcoded host elsewhere.
3. popup.html/popup.js: add "Hub endpoint" input (default http://127.0.0.1:8787)
   + Save (chrome.storage.local), status row "Hub: connected/offline" refreshed
   on open and on demand, keep context-label input + "Send test annotation"
   button (test payload sends 1 stroke, title "Browserlink test").
4. content.js: NO behavior changes (unless a user-facing "Hermes" string -
   replace with "Browserlink").
5. Verify: node --check content.js service-worker.js popup.js; manifest valid
   JSON; grep: popup has endpoint field wired to storage; SW default constant
   allowed exactly once.
CONSTRAINTS: only extension/ files. No git. No config commands. Report files +
verification output. Do not claim in-browser visual verification.

## Worker B (gpt-5.6-luna) - server/, mcp/, tests/ ONLY
1. server/hub.py (refactor of the moved file): keep REST contract + validation
   + atomic writes EXACTLY as-is; data dir via BROWSERLINK_DATA_DIR →
   HERMES_HOME/annotations → ~/.browserlink/annotations; --port default 8787;
   keep CORS *; add GET /status returning {ok,version:"1.0.0",dataDir,adapters:[names]}.
   Adapter interface: adapters/base.py with register(annotation: dict) -> None;
   adapters/hermes.py (env HERMES_API_URL, HERMES_API_KEY, HERMES_SESSION_ID:
   POST HERMES_API_URL/api/sessions/{sid}/chat, Bearer key, body
   {"message": "<url> - <label> - E1: tag#id 'text' - instruction: …"}; failure
   logged, never blocks inbox); adapters/webhook.py (env BROWSERLINK_WEBHOOK_URL:
   POST JSON; same failure policy). Adapters loaded at startup from env; hub
   keeps a module-level list for /status.
2. mcp/: pyproject.toml (name "browserlink-mcp", dependency "mcp"), entry point
   browserlink-mcp = "mcp_server:main"; mcp_server.py with tools (all stdio,
   read-only): hub_status, annotations_list (limit=20), annotations_latest,
   annotations_get (name), annotations_watch (seconds=10 → new files). Same
   data-dir resolution. python3.9-compatible.
3. tests/: test_hub.py (schema validation incl. traversal + atomic write +
   round trip via direct import), test_mcp.py (tools against temp data dir).
   pytest must run with the repo venv python.
4. Verify: python3 -m py_compile hub.py + mcp_server.py; pytest -q passes;
   live curl round trip on 127.0.0.1:8787 (POST/GET/health/status) with a temp
   BROWSERLINK_DATA_DIR; clean up.
CONSTRAINTS: only server/, mcp/, tests/ files. No git. No config commands.
Report files + full verification output.

## Do not touch (any worker)
docs/, README.md, LICENSE, .github/, extension/ vs server/ cross-edits.
