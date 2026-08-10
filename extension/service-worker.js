/* Browserlink — Browser Annotate & Connect — service worker (MV3).
 *
 * Relays {type:"annotate", payload} messages from content script or popup to
 * the configured hub: POST <endpoint>/annotations (CORS-enabled). Answers
 * {type:"hubStatus"} with a GET <endpoint>/health probe. Forwards
 * {type:"browserlinkToggle", enabled} and {type:"browserlinkExit"} messages
 * from the popup to the active tab's content script. The hub endpoint is
 * read from chrome.storage.local key "endpoint", falling back to
 * DEFAULT_ENDPOINT. Responds to the sender with {ok:true} or
 * {ok:false,error}.
 */
'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

const HUB_STATUS_TIMEOUT_MS = 2000;

async function getEndpoint() {
  try {
    const got = await chrome.storage.local.get('endpoint');
    const v = got && got.endpoint ? String(got.endpoint).trim() : '';
    return v || DEFAULT_ENDPOINT;
  } catch (_) {
    return DEFAULT_ENDPOINT;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'annotate') {
    if (!msg.payload || typeof msg.payload !== 'object') return false;
    getEndpoint()
      .then((endpoint) =>
        fetch(endpoint + '/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.payload),
        })
          .then(async (res) => {
            let detail = '';
            try {
              const text = await res.text();
              if (text) {
                const body = JSON.parse(text);
                if (body && body.error) detail = String(body.error);
                else if (body && body.file) detail = String(body.file);
              }
            } catch (_) { /* non-JSON body */ }
            if (res.ok) {
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: detail || 'HTTP ' + res.status });
            }
          })
          .catch((err) => {
            sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
          })
      )
      .catch((err) => {
        sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
      });
    return true; // keep the message channel open for the async sendResponse
  }

  if (msg.type === 'hubStatus') {
    getEndpoint()
      .then((endpoint) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HUB_STATUS_TIMEOUT_MS);
        fetch(endpoint + '/health', { signal: ctrl.signal })
          .then(async (res) => {
            clearTimeout(timer);
            let body = null;
            try { body = await res.json(); } catch (_) { /* non-JSON */ }
            if (res.ok && body && body.ok) {
              sendResponse({ ok: true });
            } else {
              sendResponse({
                ok: false,
                error: body && body.error ? String(body.error) : 'HTTP ' + res.status,
              });
            }
          })
          .catch((err) => {
            clearTimeout(timer);
            sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
          });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
      });
    return true; // keep the message channel open for the async sendResponse
  }

  if (msg.type === 'browserlinkToggle' || msg.type === 'browserlinkExit') {
    // Forward activation/deactivation from the popup to the active tab.
    chrome.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== 'number') {
          sendResponse({ ok: false, error: 'no active tab' });
          return;
        }
        return chrome.tabs.sendMessage(tab.id, msg)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => {
            sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
          });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
      });
    return true; // keep the message channel open for the async sendResponse
  }

  return false; // not for us
});
