/* Browserlink - Browser Annotate & Connect - popup logic (MV3).
 *
 *   - Hub endpoint: input persisted via chrome.storage.local key "endpoint"
 *     (display default http://127.0.0.1:8787). The service worker resolves
 *     and uses the stored endpoint for all requests.
 *   - Hub status: asks the service worker ({type:"hubStatus"} → GET
 *     <endpoint>/health); refreshed on open and on demand (Check button /
 *     after saving an endpoint). Also GETs /target to show
 *     "Delivered to: <label|sessionId|not connected>".
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
  try {
    const endpoint = ($('endpointInput').value || '').trim() || DEFAULT_ENDPOINT;
    const res = await fetch(endpoint + '/target');
    if (res.ok) {
      const body = await res.json();
      delivered = deliveredText(body);
    } else if (res.status === 404) {
      delivered = 'Delivered to: not connected';
    }
  } catch (_) {
    delivered = 'Delivered to: not connected';
  }
  setHubStatus(hubLine + ' · ' + delivered, hubCls);
}

/* hub endpoint persistence */
async function loadEndpoint() {
  let v = DEFAULT_ENDPOINT;
  try {
    const got = await chrome.storage.local.get('endpoint');
    if (got && got.endpoint && String(got.endpoint).trim()) v = String(got.endpoint);
  } catch (_) { /* storage unavailable */ }
  $('endpointInput').value = v;
}

function saveEndpoint() {
  const v = $('endpointInput').value.trim();
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
  try {
    const got = await chrome.storage.local.get('toolEnabled');
    if (got && typeof got.toolEnabled === 'boolean') enabled = got.toolEnabled;
  } catch (_) { /* storage unavailable */ }
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

/* wiring */
$('toolToggle').addEventListener('change', onToolToggle);
$('saveEndpoint').addEventListener('click', saveEndpoint);
$('refreshStatus').addEventListener('click', checkHub);
$('contextLabel').addEventListener('input', saveLabel);
$('sendTest').addEventListener('click', sendTest);
checkHub();
loadEndpoint();
loadLabel();
loadToolEnabled();
