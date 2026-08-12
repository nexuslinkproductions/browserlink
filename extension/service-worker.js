/* Browserlink - Browser Annotate & Connect - service worker (MV3).
 *
 * Relays {type:"annotate", payload} messages from content script or popup to
 * the configured hub: POST <endpoint>/annotations (CORS-enabled). Answers
 * {type:"hubStatus"} with a GET <endpoint>/health probe. Forwards
 * {type:"browserlinkToggle", enabled} and {type:"browserlinkExit"} messages
 * from the popup to the active tab's content script. Polls GET /target via
 * chrome.alarms ("browserlink-poll", every 0.5 min); when activate is true,
 * injects the overlay on the active tab and POSTs /activate {active:false}
 * as an ack (one inject per connect). The hub endpoint is read from
 * chrome.storage.local key "endpoint", falling back to DEFAULT_ENDPOINT.
 * Responds to the sender with {ok:true} or {ok:false,error}.
 */
'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
const HUB_STATUS_TIMEOUT_MS = 2000;
const POLL_ALARM = 'browserlink-poll';

/* Normalize a hub endpoint: trim, strip trailing slashes, and map
 * 'localhost' to '127.0.0.1' so IPv6 (::1) resolution cannot break the
 * connect flow against an IPv4-only hub. */
function normalizeEndpoint(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (/^https?:\/\/localhost(?=[:/]|$)/i.test(s)) {
    s = s.replace(/^https?:\/\/localhost(?=[:/]|$)/i, (m) => m.replace(/localhost/i, '127.0.0.1'));
  } else if (/^localhost(?=[:/]|$)/i.test(s)) {
    s = 'http://127.0.0.1' + s.slice('localhost'.length);
  }
  return s;
}

async function getEndpoint() {
  try {
    const got = await chrome.storage.local.get('endpoint');
    const v = got && got.endpoint ? normalizeEndpoint(got.endpoint) : '';
    return v || DEFAULT_ENDPOINT;
  } catch (_) {
    return DEFAULT_ENDPOINT;
  }
}

/* Resolve the hub endpoint with a stale-storage fallback: when the stored
 * endpoint fails a health probe, fall back to DEFAULT_ENDPOINT so a stale
 * 'endpoint' value cannot break the picker/connect flow. */
async function resolveEndpoint() {
  const endpoint = await getEndpoint();
  if (endpoint === DEFAULT_ENDPOINT) return endpoint;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HUB_STATUS_TIMEOUT_MS);
    const res = await fetch(endpoint + '/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return endpoint;
  } catch (_) { /* stale or unreachable */ }
  return DEFAULT_ENDPOINT;
}

function ensurePollAlarm() {
  try {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  } catch (_) { /* alarms unavailable */ }
}

/* F6 onboarding: the content script reads and writes chrome.storage.session
 * (per-tab view state plus the "browserlinkAlwaysOn" session flag), so the
 * session area must be reachable from content scripts. This is an access
 * level on the EXISTING storage area (no new permission) and is cleared
 * when the browser session ends. Best-effort and idempotent. */
function allowContentSessionStorage() {
  try {
    if (chrome.storage && chrome.storage.session
      && typeof chrome.storage.session.setAccessLevel === 'function') {
      chrome.storage.session
        .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
        .catch(() => { /* older Chrome or already granted */ });
    }
  } catch (_) { /* storage unavailable */ }
}

/* Schemes/hosts where Chrome blocks extension content scripts: the tool can
 * never run there. Used to fail closed when a harness asks to enable the
 * current tab. */
function isRestrictedTabUrl(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return true;
  if (/^(chrome|chrome-extension|edge|about|devtools|view-source|moz-extension|opera):/i.test(u)) {
    return true;
  }
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
      return true;
    }
    if (url.hostname === 'chrome.google.com' && /^\/webstore\//.test(url.pathname)) {
      return true;
    }
  } catch (_) { return true; }
  return false;
}

/* ---- Route opt-outs (F10): same canonicalization and matching the content
 * script and popup use. The service worker evaluates the ACTIVE tab's URL
 * so harnesses can enable/disable the current eligible tab programmatically
 * and so activation is refused on opted-out routes before any injection. */
const ROUTE_OPTOUTS_KEY = 'routeOptOuts'; // chrome.storage.local

// Canonicalize an opt-out entry: 'scheme://host[:port][/path]' with the
// default port removed, host lowercased (localhost mapped to 127.0.0.1),
// and trailing slashes stripped. Wildcards, query strings, fragments, and
// non-http(s) input are rejected (return null).
function normalizeRoutePattern(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.indexOf('*') !== -1) return null;
  if (s.indexOf('?') !== -1 || s.indexOf('#') !== -1) return null;
  let url = null;
  try { url = new URL(s); } catch (_) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  const port = url.port;
  const defaultPort =
    (url.protocol === 'http:' && port === '80') ||
    (url.protocol === 'https:' && port === '443');
  const hostPort = defaultPort ? host : (port ? host + ':' + port : host);
  let path = url.pathname || '';
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  return url.protocol + '//' + hostPort + path;
}

// Split a canonical entry into {origin, prefix}. prefix '' matches every
// path on the origin; a non-empty prefix is a pathname prefix.
function routeEntryParts(canonical) {
  const idx = canonical.indexOf('://');
  if (idx < 0) return { origin: canonical, prefix: '' };
  const rest = canonical.slice(idx + 3);
  const slash = rest.indexOf('/');
  if (slash < 0) return { origin: canonical, prefix: '' };
  return { origin: canonical.slice(0, idx + 3) + rest.slice(0, slash), prefix: rest.slice(slash) };
}

// Does the href sit on an opted-out route? Exact-origin entries match every
// path; origin + pathname-prefix entries match with a boundary check.
function routeMatchesHref(optOuts, href) {
  if (!Array.isArray(optOuts) || optOuts.length === 0) return false;
  let current = null;
  try { current = new URL(href); } catch (_) { return false; }
  let host = current.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  const port = current.port;
  const defaultPort =
    (current.protocol === 'http:' && port === '80') ||
    (current.protocol === 'https:' && port === '443');
  const hostPort = defaultPort ? host : (port ? host + ':' + port : host);
  const origin = current.protocol + '//' + hostPort;
  const pathname = current.pathname || '/';
  for (const entry of optOuts) {
    const canonical = normalizeRoutePattern(entry);
    if (!canonical) continue;
    const parts = routeEntryParts(canonical);
    if (parts.origin !== origin) continue;
    if (parts.prefix === '') return true;
    if (pathname === parts.prefix || pathname.startsWith(parts.prefix + '/')) return true;
  }
  return false;
}

async function storedRouteOptOuts() {
  try {
    const got = await chrome.storage.local.get(ROUTE_OPTOUTS_KEY);
    const list = got && got[ROUTE_OPTOUTS_KEY];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/* Route state for the active tab: {routeMatched, enabled, reason}. Restricted
 * pages fail closed (reason 'restricted'). When the tab URL is unavailable
 * the content script (if present) reports its own route match. */
async function activeTabRouteState() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    return { routeMatched: false, enabled: false, reason: 'no-tab', tab: null };
  }
  let tabUrl = null;
  try { tabUrl = typeof tab.url === 'string' && tab.url ? tab.url : null; } catch (_) { tabUrl = null; }
  if (tabUrl && isRestrictedTabUrl(tabUrl)) {
    return { routeMatched: false, enabled: false, reason: 'restricted', tab: tab };
  }
  let routeMatched = false;
  if (tabUrl) {
    routeMatched = routeMatchesHref(await storedRouteOptOuts(), tabUrl);
  } else {
    try {
      const routeResp = await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkGetRoute' });
      routeMatched = !!(routeResp && routeResp.routeMatched);
    } catch (_) { routeMatched = false; }
  }
  let enabled = false;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkGetState' });
    enabled = !!(resp && resp.enabled);
  } catch (_) { enabled = false; }
  return { routeMatched: routeMatched, enabled: enabled, reason: '', tab: tab };
}

chrome.runtime.onInstalled.addListener(() => {
  ensurePollAlarm();
  allowContentSessionStorage();
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollAlarm();
  allowContentSessionStorage();
});

ensurePollAlarm();
allowContentSessionStorage();

async function pollTargetAndMaybeActivate() {
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    return;
  }
  // Respect the popup master switch: a connect request must not override an
  // explicit user OFF. Without this gate, a stale activate:true target makes
  // the tool re-appear (and flips toolEnabled back to true) every 30s poll.
  try {
    const got = await chrome.storage.local.get('toolEnabled');
    if (got && got.toolEnabled === false) return;
  } catch (_) { /* storage unavailable: proceed */ }
  let target = null;
  try {
    const res = await fetch(endpoint + '/target');
    if (!res.ok) return;
    target = await res.json();
  } catch (_) {
    return;
  }
  if (!target || target.activate !== true) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && typeof tab.id === 'number') {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkToggle', enabled: true });
      } catch (_) { /* content script may be absent on this tab */ }
    }
  } catch (_) { /* tabs query failed */ }

  // activate ack: clear the one-shot flag so we only inject once per connect
  try {
    await fetch(endpoint + '/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
  } catch (_) { /* ack best-effort */ }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== POLL_ALARM) return;
  pollTargetAndMaybeActivate();
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Crop a captured tab screenshot to the element capture rect (CSS px * dpr).
// When a crop rect was requested but the crop fails or yields nothing, return
// null so the caller omits the screenshot entirely: the full uncropped bitmap
// would include the tool overlay and must never be stored. Screenshot failure
// is never fatal to the annotation POST.
async function cropDataUrl(dataUrl, rect) {
  try {
    if (!rect || typeof rect !== 'object') return dataUrl;
    const dpr = Number(rect.dpr) > 0 ? Number(rect.dpr) : 1;
    const sx = Math.max(0, Number(rect.x) || 0) * dpr;
    const sy = Math.max(0, Number(rect.y) || 0) * dpr;
    const sw = Math.max(1, Number(rect.w) || 0) * dpr;
    const sh = Math.max(1, Number(rect.h) || 0) * dpr;
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const cw = Math.min(sw, Math.max(0, bitmap.width - sx));
    const ch = Math.min(sh, Math.max(0, bitmap.height - sy));
    if (cw < 1 || ch < 1) {
      console.warn('[browserlink] crop rect outside captured bitmap; screenshot omitted', {
        rect: rect, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height,
      });
      return null;
    }
    const canvas = new OffscreenCanvas(Math.round(cw), Math.round(ch));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.warn('[browserlink] OffscreenCanvas 2d context unavailable; screenshot omitted');
      return null;
    }
    ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(outBlob);
  } catch (err) {
    console.warn('[browserlink] crop failed; screenshot omitted',
      err && err.message ? err.message : String(err));
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'annotate') {
    if (!msg.payload || typeof msg.payload !== 'object') return false;
    (async () => {
      const payload = Object.assign({}, msg.payload);
      // Capture visible tab when possible; never block annotation on failure.
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        if (typeof dataUrl === 'string' && dataUrl) {
          // v1.6.2: crop to the selected element(s) so the screenshot shows
          // only the element, not the whole page (or the tool overlay).
          // cropDataUrl returns null when a crop was requested but failed, so
          // a UI-polluted full-page image is never stored.
          const cropped = await cropDataUrl(dataUrl, payload.captureRect);
          if (typeof cropped === 'string' && cropped) {
            payload.screenshot = cropped;
          }
        }
      } catch (_) { /* proceed without screenshot */ }

      const endpoint = await getEndpoint();
      const res = await fetch(endpoint + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
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
    })().catch((err) => {
      sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
    });
    return true; // keep the message channel open for the async sendResponse
  }

  if (msg.type === 'hubStatus') {
    resolveEndpoint()
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

  if (msg.type === 'deliveryTarget') {
    getEndpoint()
      .then((endpoint) =>
        fetch(endpoint + '/target')
          .then(async (res) => {
            if (res.status === 404) {
              sendResponse({ ok: true, connected: false });
              return;
            }
            let body = null;
            try { body = await res.json(); } catch (_) { /* non-JSON */ }
            if (!res.ok) {
              sendResponse({
                ok: false,
                error: body && body.error ? String(body.error) : 'HTTP ' + res.status,
              });
              return;
            }
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
            const label = body && typeof body.label === 'string' ? body.label : '';
            if (!sessionId) {
              sendResponse({ ok: true, connected: false });
              return;
            }
            sendResponse({ ok: true, connected: true, sessionId: sessionId, label: label });
          })
          .catch((err) => {
            sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
          })
      )
      .catch((err) => {
        sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
      });
    return true;
  }

  if (msg.type === 'browserlinkGetTabId') {
    // The content script pings us to learn its own tab id (stable per-tab
    // storage key). Answer with the sender's tab id.
    try {
      sendResponse({ ok: true, tabId: sender && sender.tab ? sender.tab.id : null });
    } catch (_) { /* ok */ }
    return false;
  }

  if (msg.type === 'browserlinkGetState') {
    // Popup asks for the active tab's real tool state (enabled/closed).
    // When the content script is absent (fresh page, or after an extension
    // reload) fall back to the STORED toolEnabled (default true) so the
    // switch reflects the persisted state instead of a hardcoded OFF.
    const storedEnabled = () =>
      chrome.storage.local.get('toolEnabled')
        .then((got) => (got && typeof got.toolEnabled === 'boolean' ? got.toolEnabled : true))
        .catch(() => true);
    const respondMissing = () =>
      storedEnabled().then((enabled) =>
        sendResponse({ ok: true, enabled: enabled, injected: false }));
    chrome.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== 'number') return respondMissing();
        return chrome.tabs.sendMessage(tab.id, { type: 'browserlinkGetState' })
          .then((resp) => sendResponse({ ok: true, enabled: !!(resp && resp.enabled), injected: true }))
          .catch(() => respondMissing());
      })
      .catch(() => respondMissing());
    return true;
  }

  if (msg.type === 'browserlinkToggle' || msg.type === 'browserlinkExit'
    || msg.type === 'browserlinkShowTour') {
    // Route opt-outs (F10): activation is refused on opted-out routes and
    // restricted pages fail closed, before any injection. This guards the
    // popup toggle, the alarm-driven connect poll, and harness enables
    // alike; the content script repeats the check as defense in depth.
    const forward = (tab) => {
      const injectThenSend = () =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['gsap.min.js', 'CustomEase.min.js', 'content.js'],
        })
          .then(() => {
            // content.js init is async: try the message right away, and
            // retry once after ~150ms if the listener is not ready yet.
            const trySend = () =>
              chrome.tabs.sendMessage(tab.id, msg)
                .then(() => sendResponse({ ok: true }))
                .catch((err) => {
                  sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
                });
            return chrome.tabs.sendMessage(tab.id, msg)
              .then(() => sendResponse({ ok: true }))
              .catch(() => new Promise((resolve) => setTimeout(resolve, 150)).then(trySend));
          })
          .catch((err) => {
            sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
          });
      return chrome.tabs.sendMessage(tab.id, msg)
        .then(() => sendResponse({ ok: true }))
        .catch(() => {
          if (msg.type === 'browserlinkExit') {
            // Nothing to exit: the content script was never injected.
            sendResponse({ ok: true });
            return;
          }
          return injectThenSend();
        });
    };
    (async () => {
      let tab = null;
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs && tabs[0];
      } catch (_) { tab = null; }
      if (!tab || typeof tab.id !== 'number') {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      if (msg.type === 'browserlinkToggle' && msg.enabled === true) {
        let tabUrl = null;
        try { tabUrl = typeof tab.url === 'string' && tab.url ? tab.url : null; } catch (_) { tabUrl = null; }
        if (tabUrl && isRestrictedTabUrl(tabUrl)) {
          sendResponse({ ok: false, error: 'restricted page', routeMatched: false, enabled: false, reason: 'restricted' });
          return;
        }
        let routeMatched = false;
        if (tabUrl) {
          routeMatched = routeMatchesHref(await storedRouteOptOuts(), tabUrl);
        } else {
          try {
            const routeResp = await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkGetRoute' });
            routeMatched = !!(routeResp && routeResp.routeMatched);
          } catch (_) { routeMatched = false; }
        }
        if (routeMatched) {
          sendResponse({ ok: false, error: 'route opt-out', routeMatched: true, enabled: false, reason: 'route-opt-out' });
          return;
        }
      }
      return forward(tab);
    })();
    return true; // keep the message channel open for the async sendResponse
  }

  if (msg.type === 'browserlinkRouteControl') {
    // F10: programmatic per-tab control for harnesses. action 'state'
    // reports {routeMatched, enabled, reason}; 'enable' activates the
    // current eligible tab (refused on opted-out routes, restricted pages
    // fail closed); 'disable' exits it.
    const action = msg.action === 'enable' || msg.action === 'disable' ? msg.action : 'state';
    (async () => {
      try {
        const state = await activeTabRouteState();
        if (action === 'enable') {
          if (state.reason === 'restricted') {
            sendResponse({ ok: true, routeMatched: false, enabled: false, reason: 'restricted' });
            return;
          }
          if (state.routeMatched) {
            sendResponse({ ok: true, routeMatched: true, enabled: false, reason: 'route-opt-out' });
            return;
          }
          const tab = state.tab;
          if (!tab || typeof tab.id !== 'number') {
            sendResponse({ ok: false, error: 'no active tab', enabled: false, reason: 'no-tab' });
            return;
          }
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkToggle', enabled: true });
          } catch (_) {
            // Content script absent: inject it, then activate (mirrors the
            // popup toggle's injectThenSend fallback).
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['gsap.min.js', 'CustomEase.min.js', 'content.js'],
              });
              await new Promise((resolve) => setTimeout(resolve, 150));
              await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkToggle', enabled: true });
            } catch (err) {
              sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err), routeMatched: false, enabled: false, reason: 'error' });
              return;
            }
          }
          // reinject builds the host asynchronously; confirm within ~600ms.
          let enabled = false;
          for (let i = 0; i < 6; i++) {
            try {
              const resp = await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkGetState' });
              enabled = !!(resp && resp.enabled);
            } catch (_) { enabled = false; }
            if (enabled) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          sendResponse({ ok: true, routeMatched: false, enabled: enabled, reason: 'ok' });
          return;
        }
        if (action === 'disable') {
          const tab = state.tab;
          if (tab && typeof tab.id === 'number') {
            try {
              await chrome.tabs.sendMessage(tab.id, { type: 'browserlinkExit' });
            } catch (_) { /* nothing to exit */ }
          }
          sendResponse({ ok: true, routeMatched: state.routeMatched, enabled: false, reason: 'disabled' });
          return;
        }
        // state
        const reason = state.reason === 'restricted' ? 'restricted'
          : (state.routeMatched ? 'route-opt-out' : (state.enabled ? 'active' : 'inactive'));
        sendResponse({ ok: true, routeMatched: state.routeMatched, enabled: state.enabled, reason: reason });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err), enabled: false });
      }
    })();
    return true; // keep the message channel open for the async sendResponse
  }

  return false; // not for us
});
