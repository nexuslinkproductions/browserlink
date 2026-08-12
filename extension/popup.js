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
 */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';
const HUB_STATUS_TIMEOUT_MS = 2000;

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
  chrome.storage.local.set({ endpoint: v }).catch(() => {});
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
  chrome.storage.local.set({ contextLabel: v }).catch(() => {});
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
  chrome.storage.local.set({ toolEnabled: enabled }).catch(() => {});
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

/* wiring */
$('toolToggle').addEventListener('change', onToolToggle);
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
checkHub();
loadEndpoint();
loadLabel();
loadToolEnabled();
