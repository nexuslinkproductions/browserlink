# browserlink

**Annotate in your browser. Deliver to any AI harness.**

browserlink is a harness-agnostic annotation link between your browser and
your AI coding tools. Draw on a page, pick elements DevTools-style, type your
instructions, then send the whole annotated context straight to the harness
you're working in. Your browser stays yours: logins, sessions, cookies,
untouched. Built for [Perplexity Comet](https://www.perplexity.ai/comet)
first, works in any Chromium browser (Chrome, Edge, Brave, Arc).

```
┌─────────────────────────┐   POST /annotations    ┌──────────────────────────┐
│  Your browser (Comet…)  │ ─────────────────────► │  browserlink hub (local) │
│  • draw annotations     │  schema v1 (docs)      │  REST inbox, CORS, safe  │
│  • element picker       │                        │  atomic writes           │
│  • instruction chat     │                        └────┬─────┬───────┬───────┘
└─────────────────────────┘                             │     │       │
                         ┌──────────────────────────────┘     │       └──────────────┐
                         ▼                                    ▼                      ▼
                  ┌──────────────┐                    ┌──────────────┐      ┌──────────────────┐
                  │  MCP server  │                    │  adapters    │      │   REST API       │
                  │  (stdio)     │                    │ hermes/webhook│     │   curl-friendly  │
                  └──────────────┘                    └──────────────┘      └──────────────────┘
                         │
          Claude Code · Hermes · Codex · Cursor · OpenCode · anything MCP
```

## Quickstart (3 steps)

```bash
# 1. Run the hub (localhost, port 8787)
python3 server/hub.py

# 2. Load the extension in your browser
#    chrome://extensions → Developer mode → Load unpacked → extension/
#    (Comet: same path; the extension works in any Chromium browser)

# 3. Connect a harness
#    Any MCP client:
pip install -e mcp/   # or: npx browserlink-mcp
#    then add to your harness's MCP config:
#    { "mcpServers": { "browserlink": { "command": "browserlink-mcp" } } }
```

Open any page → **Annotate** to draw, **Element** to pick elements (hover
highlight, click to select, type instructions in the chat card) → **Send**.
The annotation lands in the hub inbox (`~/.browserlink/annotations/`) and is
delivered to your connected harness.

## Features

- **Draw annotations** - circles, arrows, scribbles; normalized coordinates,
  theme-aware colors, undo/clear.
- **Element picker** - DevTools-style hover highlight with `tag#id.class`
  chips; click to select; numbered markers; real element descriptors
  (tag, id, classes, text, href, cssPath, rect).
- **Instruction chat** - a chat card per element: type your thoughts, edit on
  re-click, batch them all into one send.
- **Harness-neutral** - MCP server (works with every major harness), REST API,
  and pluggable adapters (Hermes chat injection, generic webhooks).
- **Your sessions stay yours** - the extension never touches page DOM beyond a
  closed ShadowRoot; the hub is localhost-only; annotations are JSON files
  with no tracking.

## Docs

- [Protocol (schema v1)](docs/protocol.md) - the public annotation contract
- [MCP tools](docs/mcp.md)
- [REST API](docs/rest.md)
- [Harness guides](docs/harnesses.md)
- [Security model](docs/security.md)

## Development

```bash
python3 -m py_compile server/hub.py mcp/mcp_server.py
pytest -q
node --check extension/content.js extension/service-worker.js extension/popup.js
```

## License

MIT - see [LICENSE](LICENSE).
