# Harness guides

browserlink delivers annotations to any MCP-capable AI harness. The extension
sends to the local hub; the hub stores the annotation and the Hermes adapter
delivers it to the session selected in the popup (or the fallback chat).

## Any MCP client (Claude Code, Codex, OpenCode, Cursor, ...)

1. Run the hub: `npx browserlink-hub` (or from this repo: `cd ts && npm run
   build && node dist/cli-hub.js`).
2. Register the MCP server in your client's MCP config:

```json
{ "mcpServers": { "browserlink": { "command": "browserlink-mcp" } } }
```

3. From any chat, call `browserlink_connect(sessionId="<this session>",
   label="my task")` to point the extension at that chat, annotate, and send.
   See [MCP tools](mcp.md) for the full tool list and Claude Code / Hermes
   setup examples.

## Hermes (desktop or CLI)

- Run the hub with `HERMES_API_URL` and `HERMES_API_KEY` set, then pick the
  delivery session in the extension popup. Sent annotations land in the
  selected chat's composer as attachment chips (screenshot + annotation
  JSON); the formatted message also posts as a fallback.
- In the Hermes desktop composer you can also paste an annotation brief
  directly: use the popup's **Copy AI Brief** button and paste the Markdown
  into your chat, then reference the local files listed in the brief.

## Copying an AI brief without a harness

`GET http://127.0.0.1:8787/annotations/latest/export.md` returns the newest
annotation as Markdown (see [REST API](rest.md)); `curl` it into any editor,
or use the popup button to copy it to the clipboard.

## Onboarding and session activation

The extension's **Always on for this browser session** toggle (popup) and
the one-time three-step intro tour change **activation only**: they decide
whether a newly loaded eligible page gets the annotation toolbar. They never
change delivery routing, hub availability, the `/target` session contract,
or which hub endpoint is used. When always-on is off (the default), a new
page stays inactive until the tool is activated for it (popup master switch
or a `browserlink_connect` activate). When it is on, newly loaded eligible
pages activate automatically for the rest of the session; pages where
Chrome blocks content scripts never activate. Delivery still happens
through the hub exactly as described above.
