/* Browserlink - Browser Annotate & Connect - popup logic (MV3).
 *
 *   - Hub endpoint: input persisted via chrome.storage.local key "endpoint"
 *     (display default http://127.0.0.1:8787). The service worker resolves
 *     and uses the stored endpoint for all requests.
 *   - Hub status: asks the service worker ({type:"hubStatus"} → GET
 *     <endpoint>/health); refreshed on open and on demand (Check button /
 *     after saving an endpoint). Also GETs /target to show
 *     "Delivered to: <label|sessionId|not connected>".
 *   - Session picker: GETs /sessions, lists options (title|preview|id),
 *     preselects the current /target sessionId; on change POSTs /target
 *     {sessionId, label, activate:true} so the service worker poll auto-
 *     connects the tool to the active tab. Refresh reloads the list.
 *   - Context label: persisted via chrome.storage.local ("contextLabel"),
 *     merged into payload.label at send time by content.js.
 *   - Master switch ("Tool active"): persisted via chrome.storage.local
 *     ("toolEnabled", default ON). Switching OFF asks the service worker to
 *     deactivate the tool on the active tab ({type:"browserlinkExit"});
 *     switching ON re-activates it ({type:"browserlinkToggle", enabled:true}).
 *   - "Send test annotation": sends a 1-stroke test payload through the
 *     service worker to verify the whole popup -> SW -> hub chain.
 *   - "Copy share link": copies the newest annotation's local read-only
 *     share URL (<endpoint>/annotations/<name>/share); the success state
 *     names the annotation.
 *   - "Save newest capture as PNG/JPEG": downloads the newest annotation's
 *     stored screenshot through the browser's normal download dialog
 *     (chrome.downloads, saveAs), converting PNG to JPEG locally with
 *     OffscreenCanvas when JPEG is selected. All downloads are local:
 *     no upload, no account.
 *   - "Download newest bundle": downloads <endpoint>/annotations/latest/bundle
 *     as a deterministic ZIP (manifest.json + annotation JSON + AI brief
 *     Markdown + PNG when present), saved via the browser download dialog.
 *   - "Backup all annotations": downloads <endpoint>/annotations/backup.zip,
 *     one consistent snapshot of the whole corpus (valid even when empty).
 *   - Onboarding (F6): "Always on for this browser session" is a
 *     session-scoped toggle (chrome.storage.session "browserlinkAlwaysOn",
 *     cleared at browser restart). Off (default): the tool activates per
 *     page (master switch). On: newly loaded eligible pages activate
 *     automatically for the rest of the session; browser-internal pages
 *     never activate, and the popup shows an honest unavailable state
 *     there. "Replay intro" clears the one-time tour flag
 *     (chrome.storage.local "browserlinkOnboarded") and asks the active
 *     tab to show the three-step coach tour again (pick an element, add an
 *     instruction, send).
 *   - Every button reports the outcome honestly: format and file name on
 *     success, absent screenshot, empty corpus, hub offline, or a
 *     cancelled/failed download on failure. Copy AI Brief is unchanged.
 *   - Search (F7): a debounced full-text query against
 *     <endpoint>/annotations?q=<term> recalls stored annotations by their
 *     label, URL, title, notes, and element text or instruction. Each result
 *     shows the page, a matching excerpt, and screenshot availability; the
 *     status line distinguishes an empty corpus, no match, a malformed
 *     response, and a hub that is offline, and reports how many corrupt
 *     records the hub skipped.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
const HUB_STATUS_TIMEOUT_MS = 2000;
const ONBOARDED_KEY = 'browserlinkOnboarded'; // chrome.storage.local
const ALWAYS_ON_KEY = 'browserlinkAlwaysOn';  // chrome.storage.session

/* Schemes/hosts where Chrome blocks extension content scripts: the tool can
 * never run there, so the popup states it honestly instead of trying. */
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

/* Normalize a hub endpoint: trim, strip trailing slashes, and map
 * 'localhost' to '127.0.0.1' so IPv6 (::1) resolution cannot break the
 * picker against an IPv4-only hub. */
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

/* Resolve the popup-side hub endpoint: normalize the input value, and when
 * the stored/input endpoint is stale (fails a health probe), fall back to
 * DEFAULT_ENDPOINT so a dead endpoint cannot break the picker. */
async function resolveEndpoint() {
  const v = normalizeEndpoint($('endpointInput').value) || DEFAULT_ENDPOINT;
  if (v === DEFAULT_ENDPOINT) return v;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HUB_STATUS_TIMEOUT_MS);
    const res = await fetch(v + '/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) return v;
  } catch (_) { /* stale or unreachable */ }
  return DEFAULT_ENDPOINT;
}

function setHubStatus(text, cls) {
  const el = $('hubStatus');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function deliveredText(target) {
  if (!target || typeof target !== 'object') return 'Delivered to: not connected';
  const label = target.label ? String(target.label).trim() : '';
  const sessionId = target.sessionId ? String(target.sessionId).trim() : '';
  if (label) return 'Delivered to: ' + label;
  if (sessionId) return 'Delivered to: ' + sessionId;
  return 'Delivered to: not connected';
}

function setSessionStatus(text, isErr) {
  const el = $('sessionStatus');
  el.textContent = text || '';
  el.className = isErr ? 'hint err' : 'hint';
}

function sessionOptionLabel(session) {
  if (!session || typeof session !== 'object') return '';
  const title = session.title ? String(session.title).trim() : '';
  if (title) return title;
  const preview = session.preview ? String(session.preview).trim() : '';
  if (preview) return preview;
  return session.id ? String(session.id) : '';
}

function updateDeliveredLine(hubLine, hubCls, target) {
  const delivered = deliveredText(target);
  setHubStatus(hubLine + ' · ' + delivered, hubCls);
}

/* Populate session <select> from GET /sessions; preselect currentTargetId. */
async function loadSessions(currentTargetId) {
  const select = $('sessionSelect');
  const endpoint = await resolveEndpoint();
  setSessionStatus('Loading sessions...', false);

  // Reset to placeholder while loading.
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select session...';
  select.appendChild(placeholder);

  try {
    const res = await fetch(endpoint + '/sessions');
    if (res.status === 404) {
      setSessionStatus('Sessions endpoint not found (404).', true);
      return;
    }
    if (res.status === 503) {
      setSessionStatus('Hub unavailable (503).', true);
      return;
    }
    if (!res.ok) {
      setSessionStatus('Failed to load sessions (' + res.status + ').', true);
      return;
    }

    const body = await res.json();
    const sessions = (body && Array.isArray(body.sessions)) ? body.sessions : [];
    if (sessions.length === 0) {
      setSessionStatus('No sessions available.', false);
      return;
    }

    let matched = false;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (!s || !s.id) continue;
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = sessionOptionLabel(s) || String(s.id);
      opt.dataset.label = sessionOptionLabel(s) || String(s.id);
      if (currentTargetId && String(s.id) === String(currentTargetId)) {
        opt.selected = true;
        matched = true;
      }
      select.appendChild(opt);
    }

    if (currentTargetId && !matched) {
      // Target session not in list: keep placeholder selected.
      select.value = '';
      setSessionStatus('Current target not in session list.', false);
    } else {
      setSessionStatus('', false);
    }
  } catch (_) {
    setSessionStatus('Could not reach hub /sessions.', true);
  }
}

/* On select change: POST /target and refresh delivered line. */
async function onSessionChange() {
  const select = $('sessionSelect');
  const sessionId = (select.value || '').trim();
  if (!sessionId) return;

  const selected = select.options[select.selectedIndex];
  const label = (selected && selected.dataset.label)
    ? selected.dataset.label
    : (selected ? selected.textContent : sessionId);
  const endpoint = await resolveEndpoint();

  setSessionStatus('Setting target...', false);
  try {
    const res = await fetch(endpoint + '/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, label: label, activate: true }),
    });
    if (!res.ok) {
      setSessionStatus('Failed to set target (' + res.status + ').', true);
      return;
    }
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    // The hub answers {ok:true} without echoing the record, so build the
    // confirmation from the selection unless the body carries the target.
    const target = (body && (body.sessionId || body.label))
      ? body
      : { sessionId: sessionId, label: label };
    // Preserve current hub status class/prefix from the status element.
    const hubEl = $('hubStatus');
    const hubCls = hubEl.classList.contains('ok') ? 'ok'
      : (hubEl.classList.contains('err') ? 'err' : '');
    const hubLine = hubEl.classList.contains('ok') ? 'Hub: connected ✓' : 'Hub: offline';
    updateDeliveredLine(hubLine, hubCls, target);
    setSessionStatus('', false);
    // Reload the list so the pick shows the new target selected.
    await loadSessions(sessionId);
  } catch (_) {
    setSessionStatus('Could not set target.', true);
  }
}

/* hub health via the service worker (endpoint is resolved there) */
async function checkHub() {
  setHubStatus('Hub: checking…', '');
  let hubLine = 'Hub: offline';
  let hubCls = 'err';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'hubStatus' });
    if (resp && resp.ok) {
      hubLine = 'Hub: connected ✓';
      hubCls = 'ok';
    }
  } catch (_) { /* offline */ }

  let delivered = 'Delivered to: not connected';
  let targetBody = null;
  try {
    const endpoint = await resolveEndpoint();
    // Reflect the fallback in the field so the UI shows the endpoint in use.
    const shown = normalizeEndpoint($('endpointInput').value);
    if (shown && shown !== endpoint) $('endpointInput').value = endpoint;
    const res = await fetch(endpoint + '/target');
    if (res.ok) {
      targetBody = await res.json();
      delivered = deliveredText(targetBody);
    } else if (res.status === 404) {
      delivered = 'Delivered to: not connected';
    }
  } catch (_) {
    delivered = 'Delivered to: not connected';
  }
  setHubStatus(hubLine + ' · ' + delivered, hubCls);

  // After a successful /target fetch, load sessions and preselect.
  if (targetBody) {
    const currentId = targetBody.sessionId
      ? String(targetBody.sessionId).trim()
      : '';
    await loadSessions(currentId);
  } else if (hubCls === 'ok') {
    // Hub is up but no target yet; still list sessions.
    await loadSessions('');
  } else {
    setSessionStatus('Hub offline; sessions unavailable.', true);
  }
}

/* hub endpoint persistence */
async function loadEndpoint() {
  let v = DEFAULT_ENDPOINT;
  try {
    const got = await chrome.storage.local.get('endpoint');
    if (got && got.endpoint && String(got.endpoint).trim()) v = normalizeEndpoint(got.endpoint);
  } catch (_) { /* storage unavailable */ }
  $('endpointInput').value = v;
}

function saveEndpoint() {
  const v = normalizeEndpoint($('endpointInput').value);
  $('endpointInput').value = v;
  chrome.storage.local.set({ endpoint: v }).catch((err) => {
    // H7: surface the failure (typically the storage.local quota) instead of
    // silently losing the config; the status line is the visible hint.
    console.error('[browserlink] endpoint save failed: '
      + ((err && err.message) ? err.message : String(err)));
    setHubStatus('Endpoint save failed (storage error); check the console.', 'err');
  });
  checkHub(); // re-check against the saved endpoint
}

/* context label persistence */
async function loadLabel() {
  try {
    const got = await chrome.storage.local.get('contextLabel');
    $('contextLabel').value = (got && got.contextLabel) ? String(got.contextLabel) : '';
  } catch (_) { /* storage unavailable */ }
}

function saveLabel() {
  const v = $('contextLabel').value;
  chrome.storage.local.set({ contextLabel: v }).catch((err) => {
    // H7: surface the failure instead of silently losing the label.
    console.error('[browserlink] context label save failed: '
      + ((err && err.message) ? err.message : String(err)));
  });
}

/* master switch ("Tool active"): default ON, persisted as "toolEnabled" */
async function loadToolEnabled() {
  let enabled = true; // default ON
  let stored = null;
  try {
    const got = await chrome.storage.local.get('toolEnabled');
    if (got && typeof got.toolEnabled === 'boolean') {
      enabled = got.toolEnabled;
      stored = got.toolEnabled;
    }
  } catch (_) { /* storage unavailable */ }
  // Reflect the ACTIVE TAB's real state (the tool may have been closed via
  // the toolbar's exit button, which does not touch toolEnabled).
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'browserlinkGetState' });
    if (resp && resp.ok && typeof resp.enabled === 'boolean') {
      enabled = resp.enabled;
      // Belt-and-braces: when the content script is missing the SW reports
      // the STORED toolEnabled; if it still reads false there, keep the
      // persisted value instead of bouncing the switch OFF on a fresh page.
      // (injected:false means no content script answered, so the stored
      // value is the honest state; a real toolbar exit reports injected:true.)
      if (resp.enabled === false && resp.injected === false && stored !== null) {
        enabled = stored;
      }
    }
  } catch (_) { /* no receiver: keep the stored default */ }
  $('toolToggle').checked = enabled;
}

function onToolToggle() {
  const enabled = $('toolToggle').checked;
  chrome.storage.local.set({ toolEnabled: enabled }).catch((err) => {
    // H7: surface the failure instead of silently losing the switch state.
    console.error('[browserlink] tool toggle save failed: '
      + ((err && err.message) ? err.message : String(err)));
  });
  const msg = enabled
    ? { type: 'browserlinkToggle', enabled: true }
    : { type: 'browserlinkExit' };
  // The service worker forwards this to the active tab's content script.
  chrome.runtime.sendMessage(msg).catch(() => { /* no receiver */ });
  // Re-query the real state shortly after (the content script may be
  // mid-exit-animation); keep the switch honest.
  setTimeout(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'browserlinkGetState' });
      if (resp && resp.ok && typeof resp.enabled === 'boolean') {
        $('toolToggle').checked = resp.enabled;
      }
    } catch (_) { /* no receiver */ }
  }, 250);
}

/* ---- Onboarding (F6): session always-on, restricted-page state, tour ---- */

/* Session-scoped always-on toggle: reflected from chrome.storage.session. */
async function loadAlwaysOn() {
  let on = false;
  try {
    const got = await chrome.storage.session.get(ALWAYS_ON_KEY);
    on = !!(got && got[ALWAYS_ON_KEY]);
  } catch (_) { /* storage unavailable */ }
  $('alwaysOnToggle').checked = on;
}

function onAlwaysOnToggle() {
  const on = $('alwaysOnToggle').checked;
  try {
    chrome.storage.session.set({ [ALWAYS_ON_KEY]: on }).catch(() => {});
  } catch (_) { /* storage unavailable */ }
  // Honest hint: the toggle applies to newly loaded eligible pages.
  const hint = $('alwaysOnHint');
  if (hint) {
    hint.textContent = on
      ? 'On: newly loaded eligible pages activate automatically for the rest of this session. Existing tabs keep their current state.'
      : 'Off: the tool activates per page. On: newly loaded eligible pages activate automatically for this session.';
  }
}

/* Restricted/unsupported active tab: show an honest unavailable state and
 * disable the activation toggles instead of attempting injection. */
async function loadPageState() {
  const el = $('pageState');
  let restricted = false;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    restricted = !tab || typeof tab.id !== 'number' || isRestrictedTabUrl(tab.url);
  } catch (_) { restricted = true; }
  if (!el) return;
  if (restricted) {
    el.textContent = 'Browserlink is not available on this page (Chrome blocks extensions on browser-internal pages).';
    el.classList.add('err');
    el.hidden = false;
    $('toolToggle').disabled = true;
    // The session always-on toggle stays usable here: it configures newly
    // loaded eligible pages for the rest of the session and is not a
    // per-page activation.
  } else {
    el.hidden = true;
    el.classList.remove('err');
    $('toolToggle').disabled = false;
    $('alwaysOnToggle').disabled = false;
  }
}

/* Replay intro: clear the one-time tour flag and show the three-step tour
 * on the active tab (the service worker injects the content script first
 * when the page has none). */
async function replayIntro() {
  const out = $('introResult');
  out.textContent = 'resetting…';
  out.className = 'result';
  try {
    await chrome.storage.local.remove(ONBOARDED_KEY);
  } catch (_) { /* storage unavailable */ }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'browserlinkShowTour' });
    if (resp && resp.ok) {
      out.textContent = 'Intro ready on this page ✓';
      out.className = 'result ok';
    } else {
      out.textContent = 'No eligible page to show the intro on.';
      out.className = 'result err';
    }
  } catch (_) {
    out.textContent = 'No eligible page to show the intro on.';
    out.className = 'result err';
  }
}

/* send test annotation */
async function sendTest() {
  const label = $('contextLabel').value.trim().slice(0, 200);
  let url = 'popup://test';
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) url = tabs[0].url;
  } catch (_) { /* activeTab unavailable */ }

  const payload = {
    source: 'comet-extension',
    url: url,
    title: 'Browserlink test',
    viewport: {
      w: Math.max(1, window.screen.availWidth || 1280),
      h: Math.max(1, window.screen.availHeight || 800),
    },
    label: label,
    strokes: [
      { color: '#4a9eff', width: 4, points: [[0.1, 0.15], [0.3, 0.4], [0.55, 0.3]] },
    ],
    elements: [],
  };

  const out = $('testResult');
  out.textContent = 'sending…';
  out.className = 'result';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'annotate', payload });
    if (resp && resp.ok) {
      out.textContent = 'test sent ✓';
      out.className = 'result ok';
    } else {
      out.textContent = 'failed: hub offline';
      out.className = 'result err';
    }
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* Copy AI Brief: fetch the newest annotation's export.md and copy it.
 * Direct hub fetches only (never routed through the content script).
 * navigator.clipboard.writeText runs at the end of this click-gesture
 * handler while the popup document stays focused. */
async function copyLatestBrief() {
  const out = $('briefResult');
  out.textContent = 'copying…';
  out.className = 'result';
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    out.textContent = 'failed: hub offline';
    out.className = 'result err';
    return;
  }
  try {
    const listRes = await fetch(endpoint + '/annotations');
    if (!listRes.ok) throw new Error('annotations list ' + listRes.status);
    const body = await listRes.json();
    const files = (body && Array.isArray(body.files)) ? body.files : [];
    const newest = files[0]; // hub lists newest first (mtime desc)
    if (!newest || !newest.name) {
      out.textContent = 'no annotations yet';
      out.className = 'result err';
      return;
    }
    const mdRes = await fetch(
      endpoint + '/annotations/' + encodeURIComponent(newest.name) + '/export.md',
    );
    if (!mdRes.ok) throw new Error('export ' + mdRes.status);
    const markdown = await mdRes.text();
    await navigator.clipboard.writeText(markdown);
    out.textContent = 'copied ' + newest.name + ' ✓';
    out.className = 'result ok';
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* Copy Share Link: copy the newest annotation's read-only share URL.
 * Direct hub fetches only, same pattern as Copy AI Brief. The URL points
 * at <endpoint>/annotations/<name>/share, a local read-only HTML page
 * served by the hub (same-machine by default; LAN only when the hub was
 * deliberately exposed). navigator.clipboard.writeText runs at the end of
 * this click-gesture handler while the popup document stays focused. */
async function copyShareLink() {
  const out = $('shareResult');
  out.textContent = 'copying…';
  out.className = 'result';
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    out.textContent = 'failed: hub offline';
    out.className = 'result err';
    return;
  }
  try {
    const listRes = await fetch(endpoint + '/annotations');
    if (!listRes.ok) throw new Error('annotations list ' + listRes.status);
    const body = await listRes.json();
    const files = (body && Array.isArray(body.files)) ? body.files : [];
    const newest = files[0]; // hub lists newest first (mtime desc)
    if (!newest || !newest.name) {
      out.textContent = 'no annotations yet';
      out.className = 'result err';
      return;
    }
    const shareUrl =
      endpoint + '/annotations/' + encodeURIComponent(newest.name) + '/share';
    await navigator.clipboard.writeText(shareUrl);
    out.textContent = 'copied ' + newest.name + ' ✓';
    out.className = 'result ok';
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* ---- Local save and backup (F3) ---- */

/* Newest stored annotation name, or null when the corpus is empty.
 * Shared by the save/backup buttons; hub lists newest first. */
async function getNewestName(endpoint) {
  const listRes = await fetch(endpoint + '/annotations');
  if (!listRes.ok) throw new Error('annotations list ' + listRes.status);
  const body = await listRes.json();
  const files = (body && Array.isArray(body.files)) ? body.files : [];
  return (files[0] && files[0].name) ? String(files[0].name) : null;
}

/* Start a browser-native download of a blob with the given filename, then
 * report the terminal state honestly: complete, or cancelled/failed via the
 * download item's interrupt error. Uses saveAs so the user picks the
 * destination through the browser's normal download dialog. */
function downloadBlob(blob, filename) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url: url, filename: filename, saveAs: true }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        URL.revokeObjectURL(url);
        resolve({ ok: false, error: String(err.message || 'download not started') });
        return;
      }
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(url);
          resolve({ ok: true });
        } else if (delta.state && delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(url);
          const error = (delta.error && delta.error.current)
            ? String(delta.error.current)
            : 'unknown';
          resolve({ ok: false, error: error });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

/* Convert a PNG blob to JPEG locally (OffscreenCanvas). Returns null when
 * conversion is impossible, so the caller reports failure honestly. */
async function pngToJpeg(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch (_) {
    return null;
  }
}

/* One status line for a completed/failed download. */
function reportDownload(out, filename, result) {
  if (result.ok) {
    out.textContent = 'saved ' + filename + ' ✓';
    out.className = 'result ok';
  } else if (/cancel/i.test(result.error)) {
    out.textContent = 'download cancelled';
    out.className = 'result err';
  } else {
    out.textContent = 'failed: ' + (result.error || 'download failed');
    out.className = 'result err';
  }
}

/* Save newest capture: fetch the newest annotation's stored screenshot and
 * download it as PNG (as stored) or JPEG (converted locally). Honest states
 * for empty corpus, absent screenshot, hub offline, and download failures. */
async function saveCapture() {
  const out = $('captureResult');
  out.textContent = 'saving…';
  out.className = 'result';
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    out.textContent = 'failed: hub offline';
    out.className = 'result err';
    return;
  }
  try {
    const name = await getNewestName(endpoint);
    if (!name) {
      out.textContent = 'no annotations yet';
      out.className = 'result err';
      return;
    }
    const stem = name.replace(/\.json$/, '');
    const annRes = await fetch(endpoint + '/annotations/' + encodeURIComponent(name));
    if (!annRes.ok) throw new Error('annotation ' + annRes.status);
    const ann = await annRes.json();
    if (!ann || typeof ann.screenshotFile !== 'string' || !ann.screenshotFile) {
      out.textContent = 'no screenshot stored for ' + name;
      out.className = 'result err';
      return;
    }
    const pngRes = await fetch(
      endpoint + '/annotations/' + encodeURIComponent(name) + '/share.png',
    );
    if (!pngRes.ok) {
      out.textContent = 'screenshot missing on disk for ' + name;
      out.className = 'result err';
      return;
    }
    let blob = await pngRes.blob();
    let ext = 'png';
    if ($('captureFormat').value === 'jpeg') {
      const jpeg = await pngToJpeg(blob);
      if (!jpeg) {
        out.textContent = 'failed: could not convert capture to JPEG';
        out.className = 'result err';
        return;
      }
      blob = jpeg;
      ext = 'jpeg';
    }
    const filename = stem + '.' + ext;
    reportDownload(out, filename, await downloadBlob(blob, filename));
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* Download newest bundle: deterministic ZIP of the newest annotation
 * (manifest + JSON + AI brief + PNG when present). */
async function downloadBundle() {
  const out = $('bundleResult');
  out.textContent = 'saving…';
  out.className = 'result';
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    out.textContent = 'failed: hub offline';
    out.className = 'result err';
    return;
  }
  try {
    const name = await getNewestName(endpoint);
    if (!name) {
      out.textContent = 'no annotations yet';
      out.className = 'result err';
      return;
    }
    const res = await fetch(endpoint + '/annotations/latest/bundle');
    if (!res.ok) throw new Error('bundle ' + res.status);
    const blob = await res.blob();
    const filename = name.replace(/\.json$/, '') + '-bundle.zip';
    reportDownload(out, filename, await downloadBlob(blob, filename));
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* Backup all annotations: one consistent snapshot ZIP of the whole corpus
 * (valid even when empty; the report shows the annotation count). */
async function downloadBackup() {
  const out = $('backupResult');
  out.textContent = 'saving…';
  out.className = 'result';
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    out.textContent = 'failed: hub offline';
    out.className = 'result err';
    return;
  }
  try {
    let count = 0;
    try {
      const listRes = await fetch(endpoint + '/annotations');
      if (listRes.ok) {
        const body = await listRes.json();
        if (body && Array.isArray(body.files)) count = body.files.length;
      }
    } catch (_) { /* count is cosmetic only */ }
    const res = await fetch(endpoint + '/annotations/backup.zip');
    if (!res.ok) throw new Error('backup ' + res.status);
    const blob = await res.blob();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    const filename = 'browserlink-backup-' + stamp + '.zip';
    const result = await downloadBlob(blob, filename);
    if (result.ok) {
      out.textContent = 'saved ' + filename + ' (' + count + ' annotation' +
        (count === 1 ? '' : 's') + ') ✓';
      out.className = 'result ok';
    } else if (/cancel/i.test(result.error)) {
      out.textContent = 'download cancelled';
      out.className = 'result err';
    } else {
      out.textContent = 'failed: ' + (result.error || 'download failed');
      out.className = 'result err';
    }
  } catch (err) {
    out.textContent = 'failed: ' + ((err && err.message) ? err.message : 'hub offline');
    out.className = 'result err';
  }
}

/* ---- Search annotations (F7): debounced local full-text recall ---- */

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULT_CAP = 8;
let searchTimer = null;

/* NFC-normalized lowercase text, mirroring the hub search normalization. */
function searchFold(value) {
  return String(value == null ? '' : value).normalize('NFC').toLowerCase();
}

/* The same searchable fields the hub indexes: label, URL, title, notes,
 * the legacy joined note, and per-element text and instruction. */
function annotationSearchBlob(ann) {
  const parts = [];
  if (ann && typeof ann === 'object') {
    for (const key of ['label', 'url', 'title']) {
      if (typeof ann[key] === 'string') parts.push(ann[key]);
    }
    if (Array.isArray(ann.notes)) {
      for (const note of ann.notes) {
        if (typeof note === 'string') parts.push(note);
      }
    }
    if (typeof ann.note === 'string') parts.push(ann.note);
    if (Array.isArray(ann.elements)) {
      for (const el of ann.elements) {
        if (!el || typeof el !== 'object') continue;
        for (const key of ['text', 'instruction']) {
          if (typeof el[key] === 'string') parts.push(el[key]);
        }
      }
    }
  }
  return parts.join('\n');
}

/* A short window around the first q hit. Matching runs on the NFC-folded
 * text so indices align with the normalized blob being sliced. */
function makeExcerpt(blob, qLower) {
  const normalized = blob.normalize('NFC');
  const idx = normalized.toLowerCase().indexOf(qLower);
  if (idx < 0) return '';
  const from = Math.max(0, idx - 45);
  const to = Math.min(normalized.length, idx + qLower.length + 70);
  let excerpt = normalized.slice(from, to).replace(/\s+/g, ' ');
  if (from > 0) excerpt = '… ' + excerpt;
  if (to < normalized.length) excerpt = excerpt + ' …';
  return excerpt;
}

async function runSearch() {
  const input = $('searchInput');
  const status = $('searchStatus');
  const results = $('searchResults');
  const q = (input.value || '').trim();
  if (!q) {
    status.textContent = '';
    status.className = 'hint';
    results.hidden = true;
    results.textContent = '';
    return;
  }
  status.textContent = 'searching…';
  status.className = 'hint';
  results.hidden = true;
  let endpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (_) {
    status.textContent = 'Search unavailable: hub offline.';
    status.className = 'hint err';
    return;
  }
  try {
    const res = await fetch(endpoint + '/annotations?q=' + encodeURIComponent(q));
    if (!res.ok) {
      status.textContent = 'Search failed: hub answered ' + res.status + '.';
      status.className = 'hint err';
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) { body = null; }
    if (!body || !Array.isArray(body.files)) {
      status.textContent = 'Search failed: malformed response from hub.';
      status.className = 'hint err';
      return;
    }
    const files = body.files;
    if (files.length === 0) {
      // Distinguish an empty corpus from a no-match query.
      let corpusCount = 0;
      try {
        const plain = await fetch(endpoint + '/annotations');
        const plainBody = await plain.json();
        if (plainBody && Array.isArray(plainBody.files)) corpusCount = plainBody.files.length;
      } catch (_) { /* corpus probe is best-effort */ }
      status.className = 'hint';
      status.textContent = corpusCount === 0
        ? 'No annotations stored yet.'
        : 'No matches for "' + q + '".';
      return;
    }
    const qLower = searchFold(q);
    const items = [];
    const cap = Math.min(files.length, SEARCH_RESULT_CAP);
    for (let i = 0; i < cap; i++) {
      const file = files[i];
      if (!file || !file.name) continue;
      let ann = null;
      try {
        const detail = await fetch(
          endpoint + '/annotations/' + encodeURIComponent(String(file.name)),
        );
        if (detail.ok) ann = await detail.json();
      } catch (_) { ann = null; }
      if (!ann || typeof ann !== 'object') continue;
      const blob = annotationSearchBlob(ann);
      const page = String(ann.title || ann.url || file.name);
      const excerpt = makeExcerpt(blob, qLower);
      const hasShot = typeof ann.screenshotFile === 'string' && ann.screenshotFile.length > 0;
      items.push({ name: String(file.name), page: page, excerpt: excerpt, hasShot: hasShot });
    }
    // Render with textContent only: stored annotations are untrusted.
    results.textContent = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'search-item';
      const page = document.createElement('p');
      page.className = 'page';
      page.textContent = item.page;
      row.appendChild(page);
      if (item.excerpt) {
        const excerpt = document.createElement('p');
        excerpt.className = 'excerpt';
        excerpt.textContent = item.excerpt;
        row.appendChild(excerpt);
      }
      const meta = document.createElement('p');
      meta.className = item.hasShot ? 'meta shot' : 'meta';
      meta.textContent = item.name + ' · ' + (item.hasShot ? 'screenshot' : 'no screenshot');
      row.appendChild(meta);
      results.appendChild(row);
    }
    status.className = 'hint';
    status.textContent = files.length > cap
      ? cap + ' of ' + files.length + ' matches shown.'
      : files.length + ' match' + (files.length === 1 ? '' : 'es');
    if (typeof body.skippedCorrupt === 'number' && body.skippedCorrupt > 0) {
      status.textContent += ' · ' + body.skippedCorrupt + ' corrupt record' +
        (body.skippedCorrupt === 1 ? '' : 's') + ' skipped';
    }
    results.hidden = false;
  } catch (_) {
    status.textContent = 'Search unavailable: hub offline.';
    status.className = 'hint err';
  }
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

/* ---- Route opt-outs (F10): origin + pathname-prefix exclusion list ----
 * The popup manages a local list of exact-origin plus pathname-prefix
 * opt-outs in chrome.storage.local ("routeOptOuts"). Entries are
 * canonicalized (default port removed, localhost mapped to 127.0.0.1,
 * trailing slashes stripped); wildcards, query strings, fragments, and
 * invalid URLs are rejected and never stored. The content script keeps
 * opted-out routes dormant and exits an active host once when the SPA
 * navigates into one; the service worker refuses programmatic enable on
 * them. Matching functions are pure and identical to the content script's,
 * so the mechanism gate can extract and drive them from either file. */
const ROUTE_OPTOUTS_KEY = 'routeOptOuts'; // chrome.storage.local

// Canonicalize an opt-out entry (see the content script for the exact
// contract): 'scheme://host[:port][/path]', default port removed, host
// lowercased, trailing slash stripped, query/fragment/wildcards rejected.
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

function addRouteOptOut() {
  const input = $('routeInput');
  const status = $('routeStatus');
  const raw = (input.value || '').trim();
  if (!raw) {
    status.textContent = 'Enter an origin, optionally with a path prefix.';
    status.className = 'hint err';
    return;
  }
  if (raw.indexOf('*') !== -1) {
    status.textContent = 'Wildcards are not supported; use an exact origin plus an optional path prefix.';
    status.className = 'hint err';
    return;
  }
  if (raw.indexOf('?') !== -1 || raw.indexOf('#') !== -1) {
    status.textContent = 'Query strings and fragments are not stored; use origin + path only.';
    status.className = 'hint err';
    return;
  }
  const canonical = normalizeRoutePattern(raw);
  if (!canonical) {
    status.textContent = 'Not a valid http(s) URL.';
    status.className = 'hint err';
    return;
  }
  chrome.storage.local.get(ROUTE_OPTOUTS_KEY).then((got) => {
    const list = (got && Array.isArray(got[ROUTE_OPTOUTS_KEY]))
      ? got[ROUTE_OPTOUTS_KEY].slice()
      : [];
    if (list.indexOf(canonical) !== -1) {
      status.textContent = 'Already on the list.';
      status.className = 'hint err';
      return;
    }
    list.push(canonical);
    return chrome.storage.local.set({ [ROUTE_OPTOUTS_KEY]: list }).then(() => {
      input.value = '';
      status.textContent = 'Added ' + canonical;
      status.className = 'hint';
      renderRouteOptOuts();
      refreshRouteState();
    });
  }).catch(() => {
    status.textContent = 'Could not save the opt-out.';
    status.className = 'hint err';
  });
}

function removeRouteOptOut(canonical) {
  chrome.storage.local.get(ROUTE_OPTOUTS_KEY).then((got) => {
    const list = (got && Array.isArray(got[ROUTE_OPTOUTS_KEY]))
      ? got[ROUTE_OPTOUTS_KEY].slice()
      : [];
    const next = list.filter((entry) => entry !== canonical);
    if (next.length === list.length) return;
    return chrome.storage.local.set({ [ROUTE_OPTOUTS_KEY]: next }).then(() => {
      renderRouteOptOuts();
      refreshRouteState();
    });
  }).catch(() => { /* storage unavailable */ });
}

function renderRouteOptOuts() {
  const listEl = $('routeList');
  listEl.textContent = '';
  chrome.storage.local.get(ROUTE_OPTOUTS_KEY).then((got) => {
    const list = (got && Array.isArray(got[ROUTE_OPTOUTS_KEY]))
      ? got[ROUTE_OPTOUTS_KEY]
      : [];
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'No route opt-outs: the tool may activate on every eligible page.';
      listEl.appendChild(empty);
      return;
    }
    // textContent only: stored entries are treated as untrusted text.
    for (const canonical of list) {
      const row = document.createElement('div');
      row.className = 'route-item';
      const pat = document.createElement('span');
      pat.className = 'pat';
      pat.textContent = String(canonical);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.title = 'Allow the tool on ' + String(canonical);
      rm.addEventListener('click', () => removeRouteOptOut(String(canonical)));
      row.appendChild(pat);
      row.appendChild(rm);
      listEl.appendChild(row);
    }
  }).catch(() => { /* storage unavailable */ });
}

/* Current-tab route state via the service worker. Harnesses use the same
 * browserlinkRouteControl message with action enable/disable; restricted
 * pages fail closed. */
async function refreshRouteState() {
  const el = $('routeState');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'browserlinkRouteControl', action: 'state' });
    if (resp && resp.ok) {
      const reasonText = {
        'restricted': 'restricted page',
        'route-opt-out': 'route opt-out',
      }[resp.reason] || '';
      const act = resp.enabled ? 'active' : 'dormant';
      el.textContent = 'Current tab: ' + (resp.routeMatched ? 'opted out' : 'allowed')
        + ' (' + act + ')' + (reasonText ? ' - ' + reasonText : '');
      el.className = resp.routeMatched || resp.reason === 'restricted' ? 'hint err' : 'hint';
    } else {
      el.textContent = 'Current tab state unavailable.';
      el.className = 'hint err';
    }
  } catch (_) {
    el.textContent = 'Current tab state unavailable.';
    el.className = 'hint err';
  }
}

/* wiring */
$('toolToggle').addEventListener('change', onToolToggle);
$('alwaysOnToggle').addEventListener('change', onAlwaysOnToggle);
$('replayIntro').addEventListener('click', replayIntro);
$('saveEndpoint').addEventListener('click', saveEndpoint);
$('refreshStatus').addEventListener('click', checkHub);
$('refreshSessions').addEventListener('click', () => {
  // Re-run full hub check so /target preselect stays in sync.
  checkHub();
});
$('sessionSelect').addEventListener('change', onSessionChange);
$('contextLabel').addEventListener('input', saveLabel);
$('sendTest').addEventListener('click', sendTest);
$('copyBrief').addEventListener('click', copyLatestBrief);
$('copyShare').addEventListener('click', copyShareLink);
$('saveCapture').addEventListener('click', saveCapture);
$('downloadBundle').addEventListener('click', downloadBundle);
$('downloadBackup').addEventListener('click', downloadBackup);
$('searchInput').addEventListener('input', onSearchInput);
$('searchInput').addEventListener('keydown', (event) => {
  // Keyboard reachable: Enter runs the query immediately, Escape clears it.
  if (event.key === 'Enter') {
    if (searchTimer) clearTimeout(searchTimer);
    runSearch();
  } else if (event.key === 'Escape') {
    $('searchInput').value = '';
    if (searchTimer) clearTimeout(searchTimer);
    $('searchStatus').textContent = '';
    $('searchStatus').className = 'hint';
    $('searchResults').hidden = true;
    $('searchResults').textContent = '';
  }
});
$('routeAdd').addEventListener('click', addRouteOptOut);
$('routeInput').addEventListener('keydown', (event) => {
  // Keyboard reachable: Enter adds the opt-out, Escape clears the input.
  if (event.key === 'Enter') {
    addRouteOptOut();
  } else if (event.key === 'Escape') {
    $('routeInput').value = '';
    $('routeStatus').textContent = '';
    $('routeStatus').className = 'hint';
  }
});
$('routeRefresh').addEventListener('click', refreshRouteState);
checkHub();
loadEndpoint();
loadLabel();
renderRouteOptOuts();
refreshRouteState();
loadToolEnabled();
loadAlwaysOn();
loadPageState();
