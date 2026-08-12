# Security model

## Local-first by design

- The hub binds to `127.0.0.1` only (default port 8787) and stores
  annotations as plain JSON files under `BROWSERLINK_DATA_DIR`, else
  `HERMES_HOME/annotations`, else `~/.browserlink/annotations`. Nothing is
  uploaded to a browserlink-owned server; delivery goes only to the Hermes
  endpoint you configure (`HERMES_API_URL`) or a webhook you set
  (`BROWSERLINK_WEBHOOK_URL`).
- No accounts, no cloud sync, no telemetry. Persistent drafts stay in
  `chrome.storage.local` per canonical URL and are cleared after a confirmed
  Send or Clear All.

## Extension

- MV3: background execution in a service worker only; no remote code.
- Permissions are exactly `activeTab`, `storage`, `scripting`, `alarms`.
- Page DOM is never mutated beyond a closed ShadowRoot overlay; screenshots
  are captured via `chrome.tabs.captureVisibleTab` and cropped locally to
  the annotated element rect.
- The capture state (freeze) style is removed on every exit path.

## Hub

- Annotation names are validated against `^[A-Za-z0-9._-]+$` before any file
  access; traversal attempts answer 404. Atomic temp+rename writes prevent
  partial files.
- Payload limits are enforced: screenshots at most 10 MB decoded, message
  text 20,000 characters (excluding `@image:`/`@file:` directive lines),
  element instructions 500 characters (extension-enforced), labels 200,
  note queue 20 entries.
- Request bodies are size-capped up front (413) so one bad send cannot
  exhaust the hub or the downstream API server.
- Adapter failures are isolated per delivery and logged to
  `browserlink-error.log` in the data dir; a failing adapter never blocks
  storage or other adapters.

## Data you keep

Annotations are yours: JSON + PNG files on your machine. Deleting the data
dir removes everything; see [DATA-DELETION.md](DATA-DELETION.md) and
[PRIVACY.md](PRIVACY.md).
