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
- Permissions are `activeTab`, `storage`, `scripting`, `alarms`, plus
  `downloads` (added in 2.6 for the local save and backup feature: it is
  what lets the popup start a download with a chosen filename and observe
  its completion or cancellation). Nothing is uploaded; downloads go to the
  user's own machine through the browser's normal download dialog.
- Onboarding (2.6) adds **no permissions**: the three-step coach tour and
  the session always-on toggle use only the existing `storage` area. Local
  keys at a behavioral level: `chrome.storage.local` holds `toolEnabled`
  (master switch), `endpoint`, `contextLabel`, per-URL `draft:` records,
  and `browserlinkOnboarded` (one-time intro flag, set when the tour is
  completed or skipped and removed only by the popup's Replay intro).
  `chrome.storage.session` holds per-tab view state (`browserlink:<tabId>`)
  and `browserlinkAlwaysOn` (the session-scoped always-on flag, cleared at
  browser restart). The service worker calls
  `storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')` so the
  content script can read and write that session state; no new permission
  is involved and the data is session-scoped, non-secret UI state.
- Always-on activation is **session-scoped and off by default**: a newly
  loaded page with no per-tab state stays inactive unless the popup toggle
  is on, per-tab exit still wins, and pages where Chrome blocks content
  scripts (chrome://, the web store, ...) never receive injection attempts
  or permission prompts; the popup shows an honest unavailable state there.
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
- **Read-only share pages** - `GET /annotations/<name>/share` renders an
  annotation as a readable HTML page. Every annotation-derived value is
  HTML-escaped and the page is served with a restrictive
  Content-Security-Policy (`default-src 'none'`, same-origin images only),
  so stored content cannot execute script. The page is read-only: no edit,
  delete, reply, upload, account, or cloud controls, and no links. Because
  the hub binds `127.0.0.1` by default, share links are same-machine; other
  devices on your LAN can open them only if you deliberately start the hub
  bound beyond loopback. Nothing in the page or the hub implies public
  hosting.
- **Exports and backups are local downloads** - `GET /annotations/<name>/bundle`,
  `/annotations/latest/bundle`, and `/annotations/backup.zip` stream ZIP
  archives that the extension hands to `chrome.downloads.download`, so the
  destination is chosen through the browser's normal download dialog. No
  upload, no account, and no cloud target exists anywhere in the flow:
  bytes travel from the local hub to the local browser only. Archive path
  safety: every entry name must match `^[A-Za-z0-9._-]+$` (or be the fixed
  `manifest.json`), so archives contain only safe relative paths - never
  absolute filesystem paths, never `..` traversal, never slashes. An
  annotation without a screenshot exports JSON and Markdown and declares
  `manifest.screenshot: null` instead of fabricating an image; an empty
  corpus still produces a valid explicit empty backup. The added `downloads`
  permission is the minimum surface needed to start a download with a chosen
  filename and observe its completion or cancellation, so the popup can
  report success and failure honestly.

## Data you keep

Annotations are yours: JSON + PNG files on your machine. Deleting the data
dir removes everything; see [DATA-DELETION.md](DATA-DELETION.md) and
[PRIVACY.md](PRIVACY.md).
