/* Browserlink — Browser Annotate & Connect — popup logic (MV3).
 *
 *   - Hub endpoint: input persisted via chrome.storage.local key "endpoint"
 *     (display default http://127.0.0.1:8787). The service worker resolves
 *     and uses the stored endpoint for all requests.
 *   - Hub status: asks the service worker ({type:"hubStatus"} → GET
 *     <endpoint>/health); refreshed on open and on demand (Check button /
 *     after saving an endpoint).
 *   - Context label: persisted via chrome.storage.local ("contextLabel"),
 *     merged into payload.label at send time by content.js.
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

/* hub health via the service worker (endpoint is resolved there) */
async function checkHub() {
  setHubStatus('Hub: checking…', '');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'hubStatus' });
    if (resp && resp.ok) setHubStatus('Hub: connected ✓', 'ok');
    else setHubStatus('Hub: offline', 'err');
  } catch (_) {
    setHubStatus('Hub: offline', 'err');
  }
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
$('saveEndpoint').addEventListener('click', saveEndpoint);
$('refreshStatus').addEventListener('click', checkHub);
$('contextLabel').addEventListener('input', saveLabel);
$('sendTest').addEventListener('click', sendTest);
checkHub();
loadEndpoint();
loadLabel();
