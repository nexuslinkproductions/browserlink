/* Browserlink — Browser Annotate & Connect — content script (MV3). SPEC v1.2.
 *
 * Attaches ONE closed ShadowRoot to document.documentElement containing:
 *   - a floating top-right toolbar [⏻ power | − collapse | ⋮⋮ drag handle |
 *     Annotate | Element | color swatch | width 2/4/8 | N elements | Undo |
 *     Clear | Send | status | ✕ exit]. Power (⏻) and Exit (✕) fully
 *     deactivate the tool: the shadow host is removed from the DOM, the
 *     instruction chat card and inspector close, any pending pointer capture
 *     is cancelled and per-tab {enabled:false} is persisted in
 *     chrome.storage.session. Collapse (−) minimizes to a 48px floating chip
 *     (click restores; state persisted per tab). The ⋮⋮ handle drags the
 *     toolbar (and the collapsed chip identically) with live position
 *     updates persisted per tab in chrome.storage.session (default top-right
 *     12px, clamped to the viewport). Reactivation: the popup master switch
 *     sends {type:"browserlinkToggle", enabled:true}, which re-injects
 *     idempotently; {type:"browserlinkToggle", enabled:false} and
 *     {type:"browserlinkExit"} both run the full exit path.
 *   - an overlay <canvas> (position fixed, inset 0, z-index 2147483646)
 *   - an element-picker layer (fixed inset 0, pointer-events none) holding
 *     the hover highlight + "tag#id.class" chip and the persistent selection
 *     outlines + numbered badges
 *   - an instruction chat card (bottom-right of the viewport)
 *   - an element inspector panel (attached below the toolbar, Element mode):
 *     one row per property with live manipulators (sliders/selects/color/
 *     text) that write element.style (or textContent/href) immediately.
 *     Original computed/inline values are tracked for per-row Reset and
 *     panel "Reset all". Hover/focus on a row draws a property hint on the
 *     overlay canvas. Edited rows get an accent marker; the footer shows
 *     "N edits" + Reset all + the instruction textarea + Send. Send payload
 *     elements gain "edits": {property: desiredValue} (non-empty edits only).
 *     The panel closes on deselection, mode switch to Annotate, and exit/power.
 *
 * Modes:
 *   Annotate -> canvas pointer-events: all; pointerdown/move/up with
 *               setPointerCapture draws strokes. Coordinates are stored
 *               NORMALIZED (x/innerWidth, y/innerHeight) so resizes just
 *               re-render from data. pointercancel handled. UNCHANGED (v2).
 *   Element  -> DevTools-style picker (v2.1): canvas pointer-events: none so
 *               the page receives the mouse. A rAF-throttled mousemove runs
 *               document.elementFromPoint(x, y), resolves the nearest
 *               meaningful element (has id/class/role/name/href; walk up max
 *               5 parents; never html/body; never our own shadow subtree) and
 *               draws a hover highlight (2px #4a9eff outline, translucent
 *               fill, "tag#id.class" chip truncated to 40 chars) positioned
 *               from getBoundingClientRect(). A rAF loop plus scroll/resize
 *               listeners keep the highlight (and selection outlines) glued to
 *               the element. Click selects: persistent 2px dashed #ff5252
 *               outline + numbered badge (1..N), opens the instruction chat
 *               card and the element inspector. Add appends {index, tag, id,
 *               className, text, href, ariaLabel, cssPath, rect, instruction}
 *               (instruction trimmed, cap 500) and keeps the card open for
 *               the next element; Enter adds, Esc cancels/closes; re-click on
 *               an already-selected element (cssPath match) pre-fills the
 *               card (edit mode). Toolbar chip "N elements" + Clear clears
 *               all selections. While the picker is active, page clicks are
 *               swallowed (preventDefault + stopPropagation) so links/buttons
 *               don't fire.
 *
 * Send -> chrome.runtime.sendMessage({type:"annotate", payload}) with the
 * spec payload {source, url, title, viewport, label, strokes, elements};
 * elements[] entries carry "edits": {property: desiredValue} when edited.
 * status shows "sent ✓" or "bridge offline"; strokes, elements and all
 * markers are cleared only after a successful send.
 *
 * The page DOM is NEVER touched beyond appending the shadow host.
 */
'use strict';

(() => {
  if (window.__hermesAnnotateInjected) return; // guard duplicate injection
  window.__hermesAnnotateInjected = true;
  window.__browserlinkInjected = true;

  /* ---------------- spec constants ---------------- */
  const COLORS = ['#ff5252', '#4a9eff', '#ffd166', '#35c759']; // red blue yellow green
  const WIDTHS = [2, 4, 8];
  const BRIDGE_OK = 'sent ✓';
  const BRIDGE_OFFLINE = 'bridge offline';
  const MAX_TEXT = 200;
  const MAX_INSTR = 500;
  const MAX_CSS_PATH = 8;
  const MAX_PARENT_WALK = 5;
  const HL_COLOR = '#4a9eff';
  const SEL_COLOR = '#ff5252';
  const CHIP_MAX = 40;
  const POS_PAD = 12;              // viewport inset for toolbar/chip/inspector
  const DRAG_PERSIST_MS = 120;     // throttle for live position persistence

  /* ---------------- state ---------------- */
  const state = {
    annotateOn: false,   // draw mode
    elementMode: false,  // element pick mode (mutually exclusive with annotate)
    color: COLORS[0],
    width: WIDTHS[1],
    strokes: [],         // [{color, width, points:[[nx,ny],...]}]
    elements: [],        // [{descriptor, el, outlineEl}]
    currentStroke: null, // in-progress stroke
    nextIndex: 1,        // selection numbering (1-based)
    capturedPointerId: null, // active canvas pointer capture (released on exit)
    collapsed: false,    // toolbar minimized to the 48px chip
    position: null,      // {x, y} top-left of toolbar/chip (viewport px)
    activeIndex: -1,     // index in elements currently bound to the inspector
    collapsedCats: {},   // { Text: true, Layout: false, ... } inspector category collapse
  };

  // Element inspector: {el, descriptor} — descriptor is the object that
  // receives "edits" so committed elements keep their edits.
  const inspector = { el: null, descriptor: null };
  // Per-property originals for Reset: Map<prop, {value, wasInline, kind}>
  let inspectorOriginals = new Map();
  // Persist originals per descriptor so reopen/reset survive live preview.
  const originalsByDesc = new WeakMap();
  // Active property-hint row (hover/focus) drawn on the overlay canvas.
  let hintProp = null;
  let hintRaf = 0;
  let fontFamilyCache = null; // Promise<string[]> of available families
  let inspResetAllBtn = null;

  // Selection awaiting Add/Cancel: {descriptor, el, isEdit, editIndex, outlineEl}
  let pending = null;
  let hoveredEl = null;      // meaningful element currently under the cursor
  let mouse = null;          // last clientX/clientY
  let mouseDirty = false;
  let hoverLoopRaf = 0;

  let host = null;
  let shadow = null;
  let toolbar = null;
  let canvas = null;
  let ctx = null;
  let statusEl = null;
  let countEl = null;
  let selLayer = null;       // fixed inset-0 layer holding highlight + outlines
  let hlEl = null;
  let hlChip = null;
  let hoverBoxEl = null;     // stronger element-mode hover box (v1.6; coexists with hlEl)
  let hoverBoxRaf = 0;       // rAF throttle for scroll/resize box recompute
  let chatCard = null;
  let chatHead = null;
  let chatInput = null;
  let chipEl = null;         // 48px collapsed chip
  let dragHandle = null;     // ⋮⋮ toolbar handle
  let inspPanel = null;      // element inspector panel
  let inspRows = null;
  let inspCountEl = null;
  let inspInput = null;
  let inspSend = null;
  let inspSelectionCountEl = null;
  let inspSelectionList = null;
  let modeToggle = null;
  let modePill = null;
  let toastEl = null;
  let toastTimer = 0;
  const rafPending = { v: false };

  // Motion is deliberately centralized so reduced-motion also disables the
  // JavaScript loops (not only the CSS transitions in overlay.css).
  let reducedMotion = false;
  let motionMedia = null;
  let collapseTimer = 0;
  let exitTimer = 0;
  let hoverTargetRect = null;
  let hoverVisualRect = null;
  let hoverLerpRaf = 0;
  let selectionPulseRaf = 0;
  let selectionPulseStarted = 0;
  let lastSelectionCount = -1;

  /* ---------------- drag + per-tab persistence ---------------- */
  let drag = null;             // {target, pointerId, startX, startY, baseX, baseY, moved}
  let suppressChipClick = false; // chip click right after a drag = restore, not drag
  let lastDragPersist = 0;
  let messagesBound = false;   // chrome.runtime.onMessage registered once

  // Per-tab chrome.storage.session state (key "browserlink:<tabId>").
  // tabId is learned from message senders (popup/SW forwards carry
  // sender.tab) and from a {type:"browserlinkGetTabId"} ping; when the
  // background does not answer, we fall back to a shared key.
  let knownTabId = null;

  function rememberTabId(id) {
    if (id) knownTabId = id;
  }

  function tabStorageKey() {
    return 'browserlink:' + (knownTabId || 'unknown');
  }

  function saveTabState(patch) {
    const key = tabStorageKey();
    try {
      chrome.storage.session.get(key).then((got) => {
        const cur = (got && got[key]) || {};
        const obj = {};
        obj[key] = Object.assign({}, cur, patch);
        chrome.storage.session.set(obj);
      }).catch(() => { /* storage unavailable */ });
    } catch (_) { /* storage unavailable */ }
  }

  function pingTabId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'browserlinkGetTabId' }, (resp) => {
          if (chrome.runtime.lastError) { resolve(); return; }
          if (resp && resp.ok && resp.tabId) rememberTabId(resp.tabId);
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  /* ---------------- toolbar position / collapse ---------------- */
  // Size of the currently visible control surface (toolbar or collapsed chip).
  function currentSurfaceSize() {
    const el = state.collapsed ? chipEl : toolbar;
    return el
      ? { w: el.offsetWidth || 0, h: el.offsetHeight || 0 }
      : { w: 0, h: 0 };
  }

  function clampPos(x, y, w, h) {
    const maxX = Math.max(POS_PAD, window.innerWidth - w - POS_PAD);
    const maxY = Math.max(POS_PAD, window.innerHeight - h - POS_PAD);
    return {
      x: Math.min(Math.max(x, POS_PAD), maxX),
      y: Math.min(Math.max(y, POS_PAD), maxY),
    };
  }

  function defaultPosition() {
    const s = currentSurfaceSize();
    return clampPos(window.innerWidth - s.w - POS_PAD, POS_PAD, s.w, s.h);
  }

  function applyPosition(x, y) {
    if (!toolbar) return;
    const s = currentSurfaceSize();
    const p = clampPos(x, y, s.w, s.h);
    state.position = p;
    const l = p.x + 'px';
    const t = p.y + 'px';
    toolbar.style.left = l;
    toolbar.style.top = t;
    toolbar.style.right = 'auto'; // left/top win over the CSS right:12px default
    if (chipEl) {
      chipEl.style.left = l;
      chipEl.style.top = t;
      chipEl.style.right = 'auto';
    }
    positionInspector(); // inspector hangs below the toolbar
  }

  function setCollapsed(on) {
    if (on === state.collapsed && !collapseTimer) return;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = 0;
    }
    state.collapsed = on;
    if (on) {
      closeInspector();
      if (isReducedMotion()) {
        toolbar.style.display = 'none';
        if (chipEl) chipEl.style.display = '';
      } else {
        toolbar.classList.add('is-collapsing');
        toolbar.style.pointerEvents = 'none';
        if (chipEl) {
          chipEl.style.display = '';
          chipEl.classList.remove('is-chip-enter');
          void chipEl.offsetWidth;
          chipEl.classList.add('is-chip-enter');
        }
        collapseTimer = setTimeout(() => {
          toolbar.style.display = 'none';
          toolbar.style.pointerEvents = '';
          toolbar.classList.remove('is-collapsing');
          if (chipEl) chipEl.classList.remove('is-chip-enter');
          collapseTimer = 0;
          if (state.position) applyPosition(state.position.x, state.position.y);
        }, 200);
      }
    } else {
      if (isReducedMotion()) {
        toolbar.style.display = '';
        if (chipEl) chipEl.style.display = 'none';
      } else {
        toolbar.style.display = '';
        toolbar.classList.remove('is-restoring');
        void toolbar.offsetWidth;
        toolbar.classList.add('is-restoring');
        if (chipEl) chipEl.style.display = 'none';
        collapseTimer = setTimeout(() => {
          toolbar.classList.remove('is-restoring');
          collapseTimer = 0;
        }, 200);
      }
    }
    if (state.position) applyPosition(state.position.x, state.position.y);
    else { const d = defaultPosition(); applyPosition(d.x, d.y); }
    saveTabState({ collapsed: on });
  }

  // Inspector panel hangs below the toolbar, clamped to the viewport.
  function positionInspector() {
    if (!inspPanel || inspPanel.hidden || !toolbar) return;
    const r = toolbar.getBoundingClientRect();
    const iw = inspPanel.offsetWidth || 320;
    const ih = inspPanel.offsetHeight || 0;
    const left = Math.min(Math.max(POS_PAD, r.left), Math.max(POS_PAD, window.innerWidth - iw - POS_PAD));
    let top = r.bottom + 8;
    if (top + ih > window.innerHeight - POS_PAD) {
      top = Math.max(POS_PAD, window.innerHeight - ih - POS_PAD);
    }
    inspPanel.style.left = left + 'px';
    inspPanel.style.top = top + 'px';
    inspPanel.style.right = 'auto';
  }

  /* ---------------- helpers ---------------- */
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const normX = (x) => clamp01(x / window.innerWidth);
  const normY = (y) => clamp01(y / window.innerHeight);

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function updateMotionPreference() {
    let next = false;
    try {
      motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      next = !!(motionMedia && motionMedia.matches);
      if (motionMedia && typeof motionMedia.addEventListener === 'function' && !motionMedia.__blBound) {
        motionMedia.__blBound = true;
        motionMedia.addEventListener('change', (e) => {
          reducedMotion = !!(e && e.matches);
          if (reducedMotion) {
            stopHoverLoop();
            stopSelectionPulse();
            cancelHoverLerp();
          } else if (state.elementMode) {
            startHoverLoop();
            updateSelectionPulse();
          }
        });
      }
    } catch (_) { /* matchMedia unavailable */ }
    reducedMotion = next;
    return reducedMotion;
  }

  function isReducedMotion() {
    return reducedMotion;
  }

  // Restart a transform/opacity-only CSS effect without forcing layout
  // changes. Reduced motion intentionally skips the class entirely.
  function playMotion(el, className, duration) {
    if (!el) return;
    el.classList.remove(className);
    if (isReducedMotion()) return;
    void el.offsetWidth;
    el.classList.add(className);
    if (duration) {
      setTimeout(() => el.classList.remove(className), duration + 40);
    }
  }

  function showToast(text) {
    if (!toastEl) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = text || 'Sent';
    toastEl.hidden = false;
    toastEl.classList.remove('visible', 'leaving');
    if (isReducedMotion()) {
      toastEl.classList.add('visible');
    } else {
      void toastEl.offsetWidth;
      toastEl.classList.add('visible');
    }
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('visible');
      if (!isReducedMotion()) toastEl.classList.add('leaving');
      setTimeout(() => {
        if (!toastEl) return;
        toastEl.hidden = true;
        toastEl.classList.remove('leaving');
      }, isReducedMotion() ? 0 : 150);
      toastTimer = 0;
    }, 1800);
  }

  function sendFeedback(button, ok) {
    const buttons = button
      ? [button]
      : (toolbar && toolbar.querySelectorAll ? Array.from(toolbar.querySelectorAll('.comet-send')) : []);
    for (const b of buttons) {
      playMotion(b, ok ? 'send-success' : 'send-error', ok ? 400 : 300);
      if (ok) {
        const old = b.textContent;
        b.textContent = '✓';
        setTimeout(() => { if (b) b.textContent = old || 'Send'; }, isReducedMotion() ? 0 : 400);
      }
    }
    if (ok) showToast('Sent');
  }

  function updateCount() {
    if (!countEl) return;
    const n = state.elements.length;
    countEl.textContent = n === 1 ? '1 element' : n + ' elements';
    updateSelectionUI();
  }

  /* ---------------- canvas ---------------- */
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw(); // data is normalized -> nothing to rescale, just re-render
  }

  function scheduleRedraw() {
    if (rafPending.v) return;
    rafPending.v = true;
    requestAnimationFrame(() => {
      rafPending.v = false;
      redraw();
    });
  }

  function redraw() {
    if (!ctx) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const all = state.currentStroke
      ? state.strokes.concat([state.currentStroke])
      : state.strokes;
    for (const s of all) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      s.points.forEach(([nx, ny], i) => {
        const x = nx * W;
        const y = ny * H;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // Element selections are rendered as DOM outlines in the shadow root
    // (positioned from getBoundingClientRect). The soft selection pulse is
    // the one selection effect drawn on this canvas.
    drawSelectionPulse();
    // v1.2: property-affect hint overlays the strokes while a row is active.
    drawPropertyHint();
  }

  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch (_) { /* fall back */ }
    return Date.now();
  }

  function drawSelectionPulse() {
    if (!ctx || isReducedMotion() || !state.elementMode || !state.elements.length) return;
    const elapsed = Math.max(0, nowMs() - selectionPulseStarted);
    const alpha = 0.4 + 0.4 * (0.5 + 0.5 * Math.sin((elapsed / 2000) * Math.PI * 2));
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 82, 82, ' + alpha.toFixed(3) + ')';
    ctx.lineWidth = 3;
    for (const en of state.elements) {
      let r = null;
      try { r = en.el.getBoundingClientRect(); } catch (_) { r = null; }
      if (!r || r.width < 1 || r.height < 1) continue;
      ctx.strokeRect(r.left - 3, r.top - 3, r.width + 6, r.height + 6);
    }
    ctx.restore();
  }

  function stopSelectionPulse() {
    if (selectionPulseRaf) {
      cancelAnimationFrame(selectionPulseRaf);
      selectionPulseRaf = 0;
    }
  }

  function startSelectionPulse() {
    if (isReducedMotion() || !state.elementMode || !state.elements.length || selectionPulseRaf) return;
    selectionPulseStarted = nowMs();
    const tick = () => {
      selectionPulseRaf = 0;
      if (isReducedMotion() || !state.elementMode || !state.elements.length) return;
      redraw();
      selectionPulseRaf = requestAnimationFrame(tick);
    };
    selectionPulseRaf = requestAnimationFrame(tick);
  }

  function updateSelectionPulse() {
    if (state.elementMode && state.elements.length && !isReducedMotion()) startSelectionPulse();
    else stopSelectionPulse();
    redraw();
  }

  /* ---------------- drawing (Annotate mode, v2, untouched) ---------------- */
  function pointerDown(e) {
    if (!state.annotateOn || state.elementMode) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    state.capturedPointerId = e.pointerId;
    state.currentStroke = {
      color: state.color,
      width: state.width,
      points: [[normX(e.clientX), normY(e.clientY)]],
    };
    redraw();
  }

  function pointerMove(e) {
    if (!state.currentStroke) return;
    const p = [normX(e.clientX), normY(e.clientY)];
    const pts = state.currentStroke.points;
    const last = pts[pts.length - 1];
    if (last[0] === p[0] && last[1] === p[1]) return; // no-op point
    pts.push(p);
    scheduleRedraw();
  }

  function endStroke() {
    if (!state.currentStroke) return;
    const s = state.currentStroke;
    state.currentStroke = null;
    state.capturedPointerId = null;
    if (s.points.length >= 2) state.strokes.push(s); // spec: min 2 points
    redraw();
  }

  /* ---------------- element mode: hit resolution ---------------- */
  function hasMeaning(el) {
    try { if (el.id) return true; } catch (_) { /* ok */ }
    let cls = '';
    try { cls = el.getAttribute('class') || ''; } catch (_) {
      try { cls = el.className || ''; } catch (__) { cls = ''; }
    }
    if (typeof cls === 'string' && cls.trim()) return true;
    try { if (el.getAttribute('role')) return true; } catch (_) { /* ok */ }
    try { if (el.getAttribute('name')) return true; } catch (_) { /* ok */ }
    try {
      if ((el.tagName === 'A' || el.tagName === 'AREA') && el.getAttribute('href')) return true;
    } catch (_) { /* ok */ }
    return false;
  }

  // Nearest meaningful element under the cursor: skip elements without
  // id/class/role/name/href (walk up max MAX_PARENT_WALK parents), never
  // html/body, never the extension's own shadow host or anything inside it.
  function resolveMeaningful(hit) {
    if (!hit || hit.nodeType !== 1) return null;
    if (host && host.contains(hit)) return null; // our own shadow subtree
    let el = hit;
    for (let i = 0; i <= MAX_PARENT_WALK; i++) {
      if (!el || el.nodeType !== 1) return null;
      if (el === document.documentElement || el === document.body) return null;
      if (hasMeaning(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function cssPath(el) {
    const steps = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && steps.length < MAX_CSS_PATH) {
      const tag = cur.tagName.toLowerCase();
      let nth = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) nth++;
      }
      steps.unshift(tag + ':nth-of-type(' + nth + ')');
      cur = cur.parentElement;
    }
    return steps.join(' > ');
  }

  // "tag#id.class" chip label, first class token, truncated to CHIP_MAX.
  function chipFromEl(el) {
    const tag = el.tagName.toLowerCase();
    let s = tag;
    try { if (el.id) s += '#' + el.id; } catch (_) { /* ok */ }
    let cls = '';
    try { cls = el.getAttribute('class') || ''; } catch (_) {
      try { cls = el.className || ''; } catch (__) { cls = ''; }
    }
    const first = typeof cls === 'string' ? cls.trim().split(/\s+/)[0] : '';
    if (first) s += '.' + first;
    return s.length > CHIP_MAX ? s.slice(0, CHIP_MAX) + '…' : s;
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    let cls = '';
    try { cls = el.getAttribute('class') || ''; } catch (_) { /* svg etc. */ }
    if (typeof cls !== 'string' && typeof el.className === 'string') cls = el.className;
    let text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    let href = '';
    try {
      if ((el.tagName === 'A' || el.tagName === 'AREA') && el.href) href = String(el.href);
    } catch (_) { /* ok */ }
    let ariaLabel = '';
    try { ariaLabel = el.getAttribute('aria-label') || ''; } catch (_) { /* ok */ }
    const n = (v) => Math.round(clamp01(v) * 1e6) / 1e6;
    return {
      index: state.nextIndex,
      tag,
      id: el.id || '',
      className: typeof cls === 'string' ? cls.slice(0, 300) : '',
      text,
      href,
      ariaLabel,
      cssPath: cssPath(el),
      rect: {
        x: n(r.x / window.innerWidth),
        y: n(r.y / window.innerHeight),
        w: n(r.width / window.innerWidth),
        h: n(r.height / window.innerHeight),
      },
      instruction: '', // filled on Add (trimmed, cap 500)
    };
  }

  /* ---------------- element mode: overlay positioning ---------------- */
  // Position an absolutely-positioned picker element from a live rect
  // (getBoundingClientRect); hide zero-size/off-screen boxes.
  function placeRect(o, r) {
    if (!o) return;
    if (!r || r.width < 1 || r.height < 1) {
      o.style.display = 'none';
      return;
    }
    o.style.display = '';
    o.style.left = r.left + 'px';
    o.style.top = r.top + 'px';
    o.style.width = r.width + 'px';
    o.style.height = r.height + 'px';
  }

  function rectBox(r) {
    if (!r || r.width < 1 || r.height < 1) return null;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function applyHoverBox(box) {
    if (!hlEl || !box) return;
    hlEl.style.display = '';
    hlEl.style.left = box.left + 'px';
    hlEl.style.top = box.top + 'px';
    hlEl.style.width = box.width + 'px';
    hlEl.style.height = box.height + 'px';
  }

  // Stronger, unambiguous hover box (element mode only). Coexists with the
  // lerped hlEl; recomputed from live rect, invalidated on scroll/resize.
  function applyHoverOutlineBox(box) {
    if (!hoverBoxEl || !box) return;
    hoverBoxEl.style.display = '';
    hoverBoxEl.style.left = box.left + 'px';
    hoverBoxEl.style.top = box.top + 'px';
    hoverBoxEl.style.width = box.width + 'px';
    hoverBoxEl.style.height = box.height + 'px';
  }

  function hideHoverOutlineBox() {
    if (hoverBoxEl) hoverBoxEl.style.display = 'none';
  }

  function positionHoverOutlineBox() {
    if (!hoverBoxEl) return;
    if (!state.elementMode || !hoveredEl) {
      hideHoverOutlineBox();
      return;
    }
    let r = null;
    try { r = hoveredEl.getBoundingClientRect(); } catch (_) { r = null; }
    const box = rectBox(r);
    if (!box) {
      hideHoverOutlineBox();
      return;
    }
    applyHoverOutlineBox(box);
  }

  function scheduleHoverOutlineBox() {
    if (hoverBoxRaf) return;
    hoverBoxRaf = requestAnimationFrame(() => {
      hoverBoxRaf = 0;
      positionHoverOutlineBox();
    });
  }

  function cancelHoverLerp() {
    if (hoverLerpRaf) {
      cancelAnimationFrame(hoverLerpRaf);
      hoverLerpRaf = 0;
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // The highlight is an overlay, so its visual box can ease without causing
  // page layout. This is the one rAF-driven DOM effect requested by the spec.
  function startHoverLerp() {
    if (isReducedMotion() || hoverLerpRaf || !hoverTargetRect) return;
    const from = hoverVisualRect || hoverTargetRect;
    const started = nowMs();
    const tick = () => {
      hoverLerpRaf = 0;
      if (isReducedMotion() || !state.elementMode || !hoverTargetRect) return;
      const t = clamp01((nowMs() - started) / 100);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out
      hoverVisualRect = {
        left: lerp(from.left, hoverTargetRect.left, eased),
        top: lerp(from.top, hoverTargetRect.top, eased),
        width: lerp(from.width, hoverTargetRect.width, eased),
        height: lerp(from.height, hoverTargetRect.height, eased),
      };
      applyHoverBox(hoverVisualRect);
      if (t < 1) hoverLerpRaf = requestAnimationFrame(tick);
      else if (hoverVisualRect !== hoverTargetRect) {
        hoverVisualRect = Object.assign({}, hoverTargetRect);
      }
    };
    hoverLerpRaf = requestAnimationFrame(tick);
  }

  function positionHover() {
    if (!hlEl) return;
    if (!state.elementMode || !hoveredEl) {
      cancelHoverLerp();
      hoverTargetRect = null;
      hoverVisualRect = null;
      hlEl.style.display = 'none';
      hideHoverOutlineBox();
      return;
    }
    let r = null;
    try { r = hoveredEl.getBoundingClientRect(); } catch (_) { r = null; }
    const target = rectBox(r);
    if (!target) {
      cancelHoverLerp();
      hoverTargetRect = null;
      hoverVisualRect = null;
      hlEl.style.display = 'none';
      hideHoverOutlineBox();
      return;
    }
    hoverTargetRect = target;
    if (isReducedMotion()) {
      cancelHoverLerp();
      hoverVisualRect = Object.assign({}, target);
      applyHoverBox(hoverVisualRect);
    } else {
      if (!hoverVisualRect) {
        hoverVisualRect = Object.assign({}, target);
        applyHoverBox(hoverVisualRect);
      }
      startHoverLerp();
    }
    if (hlEl.style.display !== 'none') hlChip.textContent = chipFromEl(hoveredEl);
    // Stronger unambiguous box (element mode only); tracks live rect.
    applyHoverOutlineBox(target);
  }

  function positionSelections() {
    if (!selLayer) return;
    for (const en of state.elements) {
      if (!en.outlineEl) continue;
      let r = null;
      try { r = en.el.getBoundingClientRect(); } catch (_) { r = null; }
      placeRect(en.outlineEl, r);
    }
    if (pending && pending.outlineEl) {
      let r = null;
      try { r = pending.el.getBoundingClientRect(); } catch (_) { r = null; }
      placeRect(pending.outlineEl, r);
    }
  }

  function repositionAll() {
    positionHover();
    positionSelections();
    // rAF-throttled hover-box recompute on scroll/resize (element mode only).
    scheduleHoverOutlineBox();
    if (hintProp) scheduleRedraw();
  }

  // rAF loop while element mode is active: re-resolve the hovered element
  // only when the mouse actually moved (elementFromPoint is rAF-throttled),
  // then keep highlight + selection outlines glued to their elements.
  function hoverTick() {
    if (!state.elementMode) {
      stopHoverLoop();
      return;
    }
    if (isReducedMotion()) {
      if (mouseDirty && mouse) {
        mouseDirty = false;
        let hit = null;
        try { hit = document.elementFromPoint(mouse.x, mouse.y); } catch (_) { hit = null; }
        hoveredEl = resolveMeaningful(hit);
      }
      positionHover();
      positionSelections();
      return;
    }
    if (mouseDirty && mouse) {
      mouseDirty = false;
      let hit = null;
      try { hit = document.elementFromPoint(mouse.x, mouse.y); } catch (_) { hit = null; }
      hoveredEl = resolveMeaningful(hit);
    }
    positionHover();
    positionSelections();
    hoverLoopRaf = requestAnimationFrame(hoverTick);
  }

  function startHoverLoop() {
    if (hoverLoopRaf) return;
    if (isReducedMotion()) {
      hoverTick();
      return;
    }
    hoverLoopRaf = requestAnimationFrame(hoverTick);
  }

  function stopHoverLoop() {
    if (hoverLoopRaf) {
      cancelAnimationFrame(hoverLoopRaf);
      hoverLoopRaf = 0;
    }
    if (hoverBoxRaf) {
      cancelAnimationFrame(hoverBoxRaf);
      hoverBoxRaf = 0;
    }
    cancelHoverLerp();
    hoverTargetRect = null;
    hoverVisualRect = null;
    if (hlEl) hlEl.style.display = 'none';
    hideHoverOutlineBox();
  }

  /* ---------------- element mode: selection + instruction chat ---------------- */
  function createOutline(index) {
    const o = document.createElement('div');
    o.className = 'comet-el';
    const b = document.createElement('span');
    b.className = 'comet-el-badge';
    b.textContent = String(index);
    o.appendChild(b);
    selLayer.appendChild(o);
    playMotion(b, 'marker-pop', 150);
    return o;
  }

  function selectionLabel(en) {
    const d = en && en.descriptor ? en.descriptor : {};
    let target = d.tag || 'element';
    if (d.id) target += '#' + d.id;
    let text = String(d.text || '').replace(/\s+/g, ' ').trim();
    if (text.length > 42) text = text.slice(0, 42) + '…';
    return 'E' + String(d.index || '') + ': ' + target + (text ? " '" + text + "'" : '');
  }

  function updateSelectionUI() {
    if (!inspSelectionList || !inspSelectionCountEl) return;
    const n = state.elements.length;
    inspSelectionCountEl.textContent = n + ' selected';
    if (lastSelectionCount !== -1 && lastSelectionCount !== n) {
      playMotion(inspSelectionCountEl, 'selection-pop', 150);
    }
    lastSelectionCount = n;
    inspSelectionList.innerHTML = '';
    state.elements.forEach((en, i) => {
      const row = document.createElement('div');
      row.className = 'comet-selection-row' + (i === state.activeIndex ? ' active' : '');
      row.dataset.selectionIndex = String(i);
      row.style.setProperty('--row-delay', Math.min(i * 30, 200) + 'ms');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'comet-selection-main';
      main.dataset.selectionAction = 'activate';
      main.textContent = selectionLabel(en);
      main.title = 'Edit ' + selectionLabel(en);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comet-selection-remove';
      remove.dataset.selectionAction = 'remove';
      remove.textContent = '×';
      remove.title = 'Remove ' + selectionLabel(en);
      row.appendChild(main);
      row.appendChild(remove);
      inspSelectionList.appendChild(row);
    });
  }

  function removeOutlineWithFade(outline) {
    if (!outline || !outline.parentNode) return;
    if (isReducedMotion()) {
      outline.parentNode.removeChild(outline);
      return;
    }
    outline.classList.add('is-removing');
    setTimeout(() => {
      if (outline && outline.parentNode) outline.parentNode.removeChild(outline);
    }, 120);
  }

  function activateSelection(index) {
    if (index < 0 || index >= state.elements.length) return;
    state.activeIndex = index;
    const en = state.elements[index];
    openChat(en.descriptor, en.el, true, index);
    updateSelectionUI();
  }

  function removeSelectionAt(index) {
    if (index < 0 || index >= state.elements.length) return;
    const removed = state.elements[index];
    const wasActive = state.activeIndex === index || inspector.descriptor === removed.descriptor;
    if (pending && pending.el === removed.el) pending = null;
    state.elements.splice(index, 1);
    removeOutlineWithFade(removed.outlineEl);
    if (!state.elements.length) {
      state.activeIndex = -1;
      if (chatCard) chatCard.hidden = true;
      closeInspector();
    } else if (wasActive) {
      state.activeIndex = Math.min(index, state.elements.length - 1);
      activateSelection(state.activeIndex);
    } else if (state.activeIndex > index) {
      state.activeIndex -= 1;
    }
    updateCount();
    updateSelectionPulse();
  }

  function clearCommittedSelections() {
    const old = state.elements.slice();
    state.elements = [];
    state.activeIndex = -1;
    old.forEach((en) => removeOutlineWithFade(en.outlineEl));
    if (pending && !pending.isEdit) {
      removeOutlineWithFade(pending.outlineEl);
      pending = null;
    }
    if (chatCard) chatCard.hidden = true;
    closeInspector();
    updateCount();
    updateSelectionPulse();
  }

  function selectOnly(index) {
    if (index < 0 || index >= state.elements.length) return;
    const keep = state.elements[index];
    state.elements.forEach((en, i) => { if (i !== index) removeOutlineWithFade(en.outlineEl); });
    state.elements = [keep];
    state.activeIndex = 0;
    updateCount();
    updateSelectionPulse();
  }

  // Open the instruction card for a clicked element. New selection -> fresh
  // outline; already-selected (cssPath match) -> edit mode, pre-filled.
  // The element inspector opens alongside the card.
  function openChat(descriptor, el, isEdit, editIndex) {
    // Drop any previous NEW (not-yet-added) pending outline; edit pendings
    // share the entry's outline and must stay.
    if (pending && pending.outlineEl && !pending.isEdit && pending.outlineEl.parentNode) {
      pending.outlineEl.parentNode.removeChild(pending.outlineEl);
    }
    let outlineEl;
    if (isEdit) {
      outlineEl = state.elements[editIndex].outlineEl;
      state.activeIndex = editIndex;
    } else {
      outlineEl = createOutline(descriptor.index);
      state.activeIndex = -1;
    }
    pending = { descriptor, el, isEdit, editIndex, outlineEl };
    chatHead.textContent = chipFromEl(el) + (isEdit ? ' — edit instruction' : '');
    chatInput.value = isEdit ? (state.elements[editIndex].descriptor.instruction || '') : '';
    chatCard.hidden = false;
    chatInput.focus();
    positionSelections();
    // v1.1: inspector is bound to the committed descriptor, so edits remain
    // per element when a different selection becomes active.
    const inspDesc = isEdit ? state.elements[editIndex].descriptor : descriptor;
    openInspector(el, inspDesc);
    if (inspInput) inspInput.value = inspDesc.instruction || '';
    updateSelectionUI();
  }

  function addChat() {
    if (!pending) return;
    const instr = chatInput.value.trim().slice(0, MAX_INSTR);
    let committedIndex = pending.editIndex;
    if (pending.isEdit) {
      state.elements[pending.editIndex].descriptor.instruction = instr;
      state.activeIndex = pending.editIndex;
    } else {
      pending.descriptor.instruction = instr;
      state.elements.push({
        descriptor: pending.descriptor,
        el: pending.el,
        outlineEl: pending.outlineEl,
      });
      committedIndex = state.elements.length - 1;
      state.activeIndex = committedIndex;
    }
    pending = null;
    chatInput.value = '';
    if (inspInput) inspInput.value = state.elements[committedIndex].descriptor.instruction || '';
    chatInput.focus(); // stays open for the next element
    updateCount();
    updateSelectionPulse();
  }

  function cancelChat() {
    if (!pending) return;
    if (!pending.isEdit && pending.outlineEl && pending.outlineEl.parentNode) {
      pending.outlineEl.parentNode.removeChild(pending.outlineEl);
    }
    pending = null;
    chatCard.hidden = true;
    chatInput.value = '';
    closeInspector(); // deselection closes the inspector
  }

  function onMouseMove(e) {
    if (!state.elementMode) return;
    mouse = { x: e.clientX, y: e.clientY };
    mouseDirty = true;
    if (isReducedMotion()) hoverTick();
  }

  function onPageClick(e) {
    if (!state.elementMode) return;
    if (e.composedPath().indexOf(host) !== -1) return; // click inside our UI
    // Picker semantics: the page must not react to selection clicks.
    e.preventDefault();
    e.stopPropagation();
    let hit = null;
    try { hit = document.elementFromPoint(e.clientX, e.clientY); } catch (_) { hit = null; }
    const el = resolveMeaningful(hit);
    if (!el) return;
    const d = describeElement(el);
    const existingIdx = state.elements.findIndex((en) => en.descriptor.cssPath === d.cssPath);

    // Shift+click is the additive toggle. Additions commit immediately so a
    // second shift-click can toggle them out without a chat-card round trip.
    if (e.shiftKey) {
      if (existingIdx !== -1) {
        removeSelectionAt(existingIdx);
        return;
      }
      if (pending && !pending.isEdit) cancelChat();
      d.index = state.nextIndex++;
      const outlineEl = createOutline(d.index);
      state.elements.push({ descriptor: d, el, outlineEl });
      state.activeIndex = state.elements.length - 1;
      updateCount();
      updateSelectionPulse();
      openChat(d, el, true, state.activeIndex);
      return;
    }

    // Plain click always makes this the single active element. Clicking a
    // selected element keeps its descriptor and enters edit mode.
    if (existingIdx !== -1) {
      if (state.elements.length > 1) selectOnly(existingIdx);
      const idx = state.elements.findIndex((en) => en.descriptor.cssPath === d.cssPath);
      openChat(d, el, true, idx);
      return;
    }
    if (pending && pending.descriptor.cssPath === d.cssPath) {
      chatInput.focus(); // same pending element -> just refocus
      return;
    }
    if (state.elements.length) clearCommittedSelections();
    d.index = state.nextIndex++;
    openChat(d, el, false, -1);
  }

  function onSelectionListClick(e) {
    const target = e.target && e.target.closest ? e.target.closest('[data-selection-action]') : null;
    if (!target || !inspSelectionList.contains(target)) return;
    const row = target.closest('.comet-selection-row');
    const index = row ? parseInt(row.dataset.selectionIndex, 10) : -1;
    if (!Number.isFinite(index)) return;
    e.preventDefault();
    e.stopPropagation();
    if (target.dataset.selectionAction === 'remove') removeSelectionAt(index);
    else activateSelection(index);
  }

  function onKeyDown(e) {
    if (!state.elementMode) return;
    if (chatCard && !chatCard.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelChat();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && e.target === chatInput) {
        e.preventDefault();
        addChat();
      }
    }
  }

  /* ---------------- element inspector (v1.2) ---------------- */
  const SYSTEM_FONTS = [
    'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial',
    'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma',
    'Trebuchet MS', 'Impact', 'Comic Sans MS', 'monospace', 'serif', 'sans-serif',
  ];
  const FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];
  const DISPLAY_VALUES = ['block', 'inline', 'inline-block', 'flex', 'grid', 'none'];
  const TEXT_HINT_PROPS = new Set(['fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'color']);
  const UNDERLINE_HINT_PROPS = new Set(['text', 'href']);
  const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'];
  const TEXT_TRANSFORM_CYCLE = ['uppercase', 'lowercase', 'capitalize', 'none'];
  const INLINE_TAGS = new Set([
    'SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'U', 'LABEL', 'CODE', 'SMALL', 'BIG',
    'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR', 'MARK', 'TIME', 'Q', 'SUB', 'SUP',
    'BUTTON', 'S', 'STRIKE', 'DEL', 'INS',
  ]);
  // Inspector category grouping (v1.6). Each property maps to exactly one bucket.
  const CAT_ORDER = ['Text', 'Layout', 'Appearance', 'Other'];
  const CAT_TEXT = new Set([
    'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'color', 'textAlign',
    'textTransform', 'letterSpacing', 'wordSpacing', 'whiteSpace', 'textDecoration',
    'fontStyle', 'textShadow', 'verticalAlign',
  ]);
  const CAT_LAYOUT = new Set([
    'display', 'position', 'width', 'height', 'margin', 'padding', 'flex',
    'flexDirection', 'justifyContent', 'alignItems', 'gap', 'grid', 'zIndex',
    'overflow', 'float', 'clear',
  ]);
  const CAT_APPEARANCE = new Set([
    'background', 'backgroundColor', 'border', 'borderRadius', 'borderWidth',
    'borderColor', 'boxShadow', 'opacity', 'transform', 'transition', 'cursor',
  ]);

  function propCategory(prop) {
    if (CAT_TEXT.has(prop)) return 'Text';
    if (CAT_LAYOUT.has(prop)) return 'Layout';
    if (CAT_APPEARANCE.has(prop)) return 'Appearance';
    return 'Other';
  }

  function isCatCollapsed(cat) {
    return !!(state.collapsedCats && state.collapsedCats[cat]);
  }

  function toggleCatCollapse(cat) {
    if (!state.collapsedCats) state.collapsedCats = {};
    state.collapsedCats[cat] = !state.collapsedCats[cat];
    saveTabState({ collapsedCats: Object.assign({}, state.collapsedCats) });
    if (inspRows) {
      const body = inspRows.querySelector('.comet-insp-cat-body[data-cat="' + cat + '"]');
      const header = inspRows.querySelector('.comet-insp-cat-header[data-cat="' + cat + '"]');
      const collapsed = isCatCollapsed(cat);
      if (body) body.hidden = collapsed;
      if (header) {
        header.classList.toggle('is-collapsed', collapsed);
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
    }
  }

  function parsePx(v) {
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  }

  function parseLineHeight(v, fontSizePx) {
    const s = String(v || '').trim();
    if (!s || s === 'normal') return 1.2;
    if (s.endsWith('px')) {
      const px = parseFloat(s);
      const fs = fontSizePx || 16;
      return Number.isFinite(px) && fs > 0 ? Math.round((px / fs) * 100) / 100 : 1.2;
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 1.2;
  }

  function rgbToHex(color) {
    if (!color) return '#000000';
    const s = String(color).trim();
    if (s[0] === '#') {
      if (s.length === 4) {
        return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
      }
      return s.slice(0, 7).toLowerCase();
    }
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return '#000000';
    const hex = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  }

  function firstFontFamily(v) {
    if (!v) return 'sans-serif';
    const part = String(v).split(',')[0].trim().replace(/^["']|["']$/g, '');
    return part || 'sans-serif';
  }

  function mapFontWeight(v) {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'normal') return '400';
    if (s === 'bold') return '700';
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return '400';
    const nearest = FONT_WEIGHTS.reduce((best, w) =>
      Math.abs(parseInt(w, 10) - n) < Math.abs(parseInt(best, 10) - n) ? w : best
    , '400');
    return nearest;
  }

  function isInlineElement(el) {
    if (!el) return false;
    try {
      if (INLINE_TAGS.has(String(el.tagName || '').toUpperCase())) return true;
      const cs = getComputedStyle(el);
      const d = cs && cs.display ? String(cs.display) : '';
      return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid';
    } catch (_) {
      return INLINE_TAGS.has(String(el.tagName || '').toUpperCase());
    }
  }

  // Preserve newlines for the multiline editor (unlike chip/label collapsing).
  function readEditableText(el) {
    if (!el) return '';
    try {
      // Prefer textContent; if the live DOM used <br> for newlines, serialize them.
      let out = '';
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) { // TEXT_NODE
          out += node.nodeValue || '';
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'BR') {
          out += '\n';
          return;
        }
        const kids = node.childNodes || [];
        for (let i = 0; i < kids.length; i++) walk(kids[i]);
      };
      walk(el);
      return out;
    } catch (_) {
      return el.textContent || '';
    }
  }

  // Live text apply: Enter/newlines render via <br> for inline elements, or
  // textContent + white-space:pre-line for block-level elements.
  function applyLiveText(el, value) {
    if (!el) return;
    const text = value == null ? '' : String(value);
    if (isInlineElement(el)) {
      // Replace contents with text nodes + <br> for newlines.
      while (el.firstChild) el.removeChild(el.firstChild);
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          try { el.appendChild(document.createElement('br')); } catch (_) { /* ok */ }
        }
        if (parts[i]) {
          try { el.appendChild(document.createTextNode(parts[i])); } catch (_) { /* ok */ }
        }
      }
      return;
    }
    el.textContent = text;
    try {
      // Ensure \n is visible without forcing pre (which can break wrapping).
      if (text.indexOf('\n') !== -1) el.style.whiteSpace = 'pre-line';
      else if (el.style.whiteSpace === 'pre-line') el.style.whiteSpace = '';
    } catch (_) { /* ok */ }
  }

  function mapTextAlign(v) {
    const s = String(v || '').trim().toLowerCase();
    if (TEXT_ALIGN_VALUES.indexOf(s) !== -1) return s;
    if (s === 'start') return 'left';
    if (s === 'end') return 'right';
    return 'left';
  }

  function mapTextTransform(v) {
    const s = String(v || '').trim().toLowerCase();
    if (TEXT_TRANSFORM_CYCLE.indexOf(s) !== -1) return s;
    return 'none';
  }

  function mapFontStyle(v) {
    const s = String(v || '').trim().toLowerCase();
    return s === 'italic' || s === 'oblique' ? 'italic' : 'normal';
  }

  function mapTextDecoration(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'none') return 'none';
    return s.indexOf('underline') !== -1 ? 'underline' : 'none';
  }

  function nextTextTransform(v) {
    const cur = mapTextTransform(v);
    const i = TEXT_TRANSFORM_CYCLE.indexOf(cur);
    return TEXT_TRANSFORM_CYCLE[(i + 1) % TEXT_TRANSFORM_CYCLE.length];
  }

  function stylePropName(prop) {
    return prop; // camelCase matches CSSStyleDeclaration
  }

  function readInlineStyle(el, prop) {
    try {
      if (prop === 'text') return readEditableText(el);
      if (prop === 'href') return el.getAttribute('href') || '';
      return el.style.getPropertyValue(
        prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
      ) || el.style[prop] || '';
    } catch (_) {
      return '';
    }
  }

  // CURRENT values + manipulator metadata for the selected element.
  function inspectorProps(el) {
    const out = [];
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
    let cs = null;
    try { cs = getComputedStyle(el); } catch (_) { cs = null; }
    const fontSizePx = cs ? parsePx(cs.fontSize) : 16;

    if (r) {
      out.push({
        prop: 'width', kind: 'slider', min: 0, max: 2000, step: 1, unit: 'px',
        numeric: Math.round(r.width), current: Math.round(r.width) + 'px',
      });
      out.push({
        prop: 'height', kind: 'slider', min: 0, max: 2000, step: 1, unit: 'px',
        numeric: Math.round(r.height), current: Math.round(r.height) + 'px',
      });
    }
    if (cs) {
      out.push({
        prop: 'fontFamily', kind: 'fontFamily',
        current: cs.fontFamily, value: firstFontFamily(cs.fontFamily),
      });
      out.push({
        prop: 'fontSize', kind: 'slider', min: 6, max: 96, step: 1, unit: 'px',
        numeric: Math.round(fontSizePx) || 16, current: cs.fontSize,
      });
      out.push({
        prop: 'fontWeight', kind: 'select', options: FONT_WEIGHTS,
        current: cs.fontWeight, value: mapFontWeight(cs.fontWeight),
      });
      const lh = parseLineHeight(cs.lineHeight, fontSizePx);
      out.push({
        prop: 'lineHeight', kind: 'slider', min: 0.8, max: 3.0, step: 0.05, unit: '',
        numeric: lh, current: String(cs.lineHeight),
      });
      out.push({
        prop: 'color', kind: 'color', current: cs.color, value: rgbToHex(cs.color),
      });
      out.push({
        prop: 'backgroundColor', kind: 'color',
        current: cs.backgroundColor, value: rgbToHex(cs.backgroundColor),
      });
      out.push({
        prop: 'display', kind: 'select', options: DISPLAY_VALUES,
        current: cs.display,
        value: DISPLAY_VALUES.indexOf(cs.display) !== -1 ? cs.display : 'block',
      });
      out.push({
        prop: 'margin', kind: 'slider', min: 0, max: 200, step: 1, unit: 'px',
        numeric: Math.round(parsePx(cs.marginTop)), current: cs.margin,
      });
      out.push({
        prop: 'padding', kind: 'slider', min: 0, max: 200, step: 1, unit: 'px',
        numeric: Math.round(parsePx(cs.paddingTop)), current: cs.padding,
      });
      out.push({
        prop: 'borderRadius', kind: 'slider', min: 0, max: 100, step: 1, unit: 'px',
        numeric: Math.round(parsePx(cs.borderTopLeftRadius)), current: cs.borderRadius,
      });
    }
    let text = readEditableText(el);
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    out.push({ prop: 'text', kind: 'textarea', current: text, value: text, max: MAX_TEXT });
    try {
      if (el.tagName === 'A' || el.tagName === 'AREA') {
        const href = el.getAttribute('href') || el.href || '';
        out.push({ prop: 'href', kind: 'text', current: String(href), value: String(href) });
      }
    } catch (_) { /* ok */ }
    return out;
  }

  function currentEdits() {
    return inspector.descriptor && inspector.descriptor.edits
      ? inspector.descriptor.edits
      : {};
  }

  function formatManipValue(prop, numeric, unit) {
    if (prop === 'lineHeight') {
      const n = Math.round(Number(numeric) * 100) / 100;
      return String(n);
    }
    return Math.round(Number(numeric)) + (unit || 'px');
  }

  function captureOriginals(el) {
    if (inspector.descriptor && originalsByDesc.has(inspector.descriptor)) {
      inspectorOriginals = originalsByDesc.get(inspector.descriptor);
      return;
    }
    inspectorOriginals = new Map();
    const edits = currentEdits();
    for (const p of inspectorProps(el)) {
      const inline = readInlineStyle(el, p.prop);
      const editVal = edits[p.prop];
      // If the current inline value is our live edit, treat it as not original.
      const inlineIsEdit = editVal != null
        && String(inline).trim() !== ''
        && String(inline).trim() === String(editVal).trim();
      const wasInline = !!(inline && String(inline).trim() !== '' && !inlineIsEdit);
      let value;
      if (p.prop === 'text') {
        value = (editVal != null) ? String(p.value || '') : readEditableText(el);
      } else if (p.prop === 'href') {
        value = (editVal != null) ? String(p.value || '') : (el.getAttribute('href') || '');
      } else if (wasInline) {
        value = inline;
      } else if (p.kind === 'slider') {
        value = formatManipValue(p.prop, p.numeric, p.unit);
      } else if (p.kind === 'color') {
        value = p.value;
      } else {
        value = p.value != null ? p.value : p.current;
      }
      // Prefer manipulator baseline over a live-edited current when edits exist.
      if (editVal != null && !wasInline) {
        if (p.kind === 'slider') value = formatManipValue(p.prop, p.numeric, p.unit);
        else if (p.kind === 'color') value = p.value;
        else if (p.kind === 'select' || p.kind === 'fontFamily') value = p.value;
        else if (p.prop === 'text' || p.prop === 'href') value = p.value || '';
      }
      inspectorOriginals.set(p.prop, { value, wasInline, kind: p.kind, unit: p.unit || '' });
    }
    // Also capture formatting baselines used by the text toolbar so Reset all
    // can restore fontStyle / textDecoration / textAlign / textTransform.
    const fmtProps = ['fontStyle', 'textDecoration', 'textAlign', 'textTransform'];
    for (const prop of fmtProps) {
      if (inspectorOriginals.has(prop)) continue;
      const inline = readInlineStyle(el, prop);
      const editVal = edits[prop];
      const inlineIsEdit = editVal != null
        && String(inline).trim() !== ''
        && String(inline).trim() === String(editVal).trim();
      const wasInline = !!(inline && String(inline).trim() !== '' && !inlineIsEdit);
      let value = wasInline ? inline : readFormatBaseline(prop);
      if (prop === 'fontStyle') value = mapFontStyle(value);
      else if (prop === 'textDecoration') value = mapTextDecoration(value);
      else if (prop === 'textAlign') value = mapTextAlign(value);
      else if (prop === 'textTransform') value = mapTextTransform(value);
      inspectorOriginals.set(prop, { value, wasInline, kind: 'fmt', unit: '' });
    }
    if (inspector.descriptor) originalsByDesc.set(inspector.descriptor, inspectorOriginals);
  }

  function applyLive(prop, value) {
    const el = inspector.el;
    if (!el) return;
    if (prop === 'text') {
      applyLiveText(el, value);
      return;
    }
    if (prop === 'href') {
      try { el.setAttribute('href', value); } catch (_) { /* ok */ }
      try { el.href = value; } catch (_) { /* ok */ }
      return;
    }
    try {
      el.style[stylePropName(prop)] = value;
    } catch (_) { /* ok */ }
  }

  function recordEdit(prop, value) {
    if (!inspector.descriptor) return;
    if (!inspector.descriptor.edits) inspector.descriptor.edits = {};
    if (value === undefined || value === null || String(value).trim() === '') {
      delete inspector.descriptor.edits[prop];
    } else {
      inspector.descriptor.edits[prop] = String(value);
    }
    updateInspectorState();
  }

  function restoreProp(prop) {
    const el = inspector.el;
    const orig = inspectorOriginals.get(prop);
    if (!el || !orig) return;
    if (prop === 'text') {
      applyLiveText(el, orig.value);
    } else if (prop === 'href') {
      try { el.setAttribute('href', orig.value); } catch (_) { /* ok */ }
    } else if (orig.wasInline) {
      try { el.style[stylePropName(prop)] = orig.value; } catch (_) { /* ok */ }
    } else {
      try { el.style[stylePropName(prop)] = ''; } catch (_) { /* ok */ }
      try {
        el.style.removeProperty(prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
      } catch (_) { /* ok */ }
    }
    if (inspector.descriptor && inspector.descriptor.edits) {
      delete inspector.descriptor.edits[prop];
    }
  }

  function syncRowControl(row, prop) {
    const orig = inspectorOriginals.get(prop);
    if (!row || !orig) return;
    const control = row.querySelector('[data-insp-control]');
    const valEl = row.querySelector('.comet-insp-val');
    if (!control) return;
    const display = orig.value || '';
    if (prop === 'text' || prop === 'href') {
      control.value = display;
      if (prop === 'text') autoGrowTextarea(control);
    } else if (control.type === 'range') {
      let n;
      if (prop === 'lineHeight') n = parseFloat(String(display));
      else n = parsePx(display);
      control.value = String(Number.isFinite(n) ? n : control.min);
      if (valEl) valEl.textContent = formatManipValue(prop, control.value, control.dataset.unit || '');
    } else if (control.type === 'color') {
      control.value = rgbToHex(display);
    } else if (prop === 'fontWeight') {
      control.value = mapFontWeight(display);
    } else if (prop === 'fontFamily') {
      control.value = firstFontFamily(display);
    } else {
      control.value = display;
    }
    if (prop === 'text') {
      const bar = row.querySelector('.comet-insp-fmt');
      if (bar) syncFormatToolbar(bar);
    }
  }

  async function getFontFamilies() {
    if (fontFamilyCache) return fontFamilyCache;
    fontFamilyCache = (async () => {
      const set = new Set(SYSTEM_FONTS);
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.queryLocalFonts === 'function') {
          const fonts = await navigator.queryLocalFonts();
          for (const f of fonts || []) {
            const fam = f && (f.family || f.fullName);
            if (fam) set.add(String(fam));
          }
        }
      } catch (_) { /* permission denied / unavailable */ }
      try {
        if (document.fonts && typeof document.fonts.forEach === 'function') {
          document.fonts.forEach((face) => {
            if (face && face.family) set.add(String(face.family).replace(/^["']|["']$/g, ''));
          });
        }
      } catch (_) { /* ok */ }
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    })();
    return fontFamilyCache;
  }

  function buildControl(p, edits) {
    const wrap = document.createElement('div');
    wrap.className = 'comet-insp-control';
    const edited = edits[p.prop] !== undefined && edits[p.prop] !== null
      ? String(edits[p.prop])
      : null;

    if (p.kind === 'slider') {
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.className = 'comet-insp-slider';
      inp.min = String(p.min);
      inp.max = String(p.max);
      inp.step = String(p.step);
      inp.dataset.unit = p.unit || '';
      inp.dataset.inspControl = '1';
      inp.setAttribute('aria-label', p.prop);
      const start = edited != null ? parseFloat(edited) : p.numeric;
      inp.value = String(Number.isFinite(start) ? start : p.min);
      const val = document.createElement('span');
      val.className = 'comet-insp-val';
      val.textContent = formatManipValue(p.prop, inp.value, p.unit);
      wrap.appendChild(inp);
      wrap.appendChild(val);
      return wrap;
    }

    if (p.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = 'comet-insp-select';
      sel.dataset.inspControl = '1';
      sel.setAttribute('aria-label', p.prop);
      for (const opt of p.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
      }
      sel.value = edited != null ? edited : p.value;
      wrap.appendChild(sel);
      return wrap;
    }

    if (p.kind === 'fontFamily') {
      const sel = document.createElement('select');
      sel.className = 'comet-insp-select';
      sel.dataset.inspControl = '1';
      sel.setAttribute('aria-label', 'fontFamily');
      const cur = edited != null ? firstFontFamily(edited) : p.value;
      const seed = new Set(SYSTEM_FONTS);
      seed.add(cur);
      Array.from(seed).sort((a, b) => a.localeCompare(b)).forEach((fam) => {
        const o = document.createElement('option');
        o.value = fam;
        o.textContent = fam;
        sel.appendChild(o);
      });
      sel.value = cur;
      wrap.appendChild(sel);
      getFontFamilies().then((fams) => {
        if (!sel.isConnected) return;
        const keep = sel.value;
        sel.innerHTML = '';
        fams.forEach((fam) => {
          const o = document.createElement('option');
          o.value = fam;
          o.textContent = fam;
          sel.appendChild(o);
        });
        if (fams.indexOf(keep) === -1) {
          const o = document.createElement('option');
          o.value = keep;
          o.textContent = keep;
          sel.insertBefore(o, sel.firstChild);
        }
        sel.value = keep;
      }).catch(() => { /* ok */ });
      return wrap;
    }

    if (p.kind === 'color') {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.className = 'comet-insp-color';
      inp.dataset.inspControl = '1';
      inp.setAttribute('aria-label', p.prop);
      inp.value = edited != null ? rgbToHex(edited) : p.value;
      wrap.appendChild(inp);
      return wrap;
    }

    if (p.prop === 'href') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'comet-insp-input';
      inp.dataset.inspControl = '1';
      inp.setAttribute('aria-label', p.prop);
      if (p.max) inp.maxLength = p.max;
      inp.value = edited != null ? edited : (p.value || '');
      wrap.appendChild(inp);
      return wrap;
    }

    // Multiline text editor (v1.5): formatting toolbar + auto-grow textarea.
    // Enter inserts newlines (default textarea behavior); applyLiveText renders
    // them via <br> for inline elements or textContent + white-space:pre-line.
    wrap.className = 'comet-insp-control comet-insp-text-editor';
    const toolbar = buildTextFormatToolbar(edits);
    wrap.appendChild(toolbar);

    const ta = document.createElement('textarea');
    ta.className = 'comet-insp-textarea';
    ta.dataset.inspControl = '1';
    ta.setAttribute('aria-label', 'text');
    ta.rows = 3;
    if (p.max) ta.maxLength = p.max;
    ta.value = edited != null ? edited : (p.value || '');
    ta.addEventListener('keydown', (e) => {
      // Enter newline handling: allow default insert; stop bubbling so the
      // Element-mode chat Enter shortcut never swallows editor newlines.
      if (e.key === 'Enter') e.stopPropagation();
    });
    wrap.appendChild(ta);
    // Auto-grow after attach (and once connected) within min/max height.
    queueMicrotask(() => autoGrowTextarea(ta));
    return wrap;
  }

  function autoGrowTextarea(ta) {
    if (!ta) return;
    try {
      ta.style.height = 'auto';
      const next = Math.max(64, Math.min(200, ta.scrollHeight || 64));
      ta.style.height = next + 'px';
    } catch (_) { /* ok */ }
  }

  function fmtActive(edits, prop, onValue, offValue, computedFallback) {
    const edited = edits && edits[prop] != null ? String(edits[prop]) : null;
    if (edited != null && String(edited).trim() !== '') {
      return String(edited).trim().toLowerCase() === String(onValue).toLowerCase();
    }
    return String(computedFallback || offValue).toLowerCase() === String(onValue).toLowerCase();
  }

  function readFormatBaseline(prop) {
    const el = inspector.el;
    if (!el) return '';
    try {
      const inline = readInlineStyle(el, prop);
      if (inline && String(inline).trim() !== '') return inline;
      const cs = getComputedStyle(el);
      if (!cs) return '';
      return cs[prop] || '';
    } catch (_) {
      return '';
    }
  }

  // Formatting toolbar above the textarea: Bold / Italic / Underline,
  // alignment segmented control, and textTransform cycle. All buttons write
  // element.style live and record into the edits payload.
  function buildTextFormatToolbar(edits) {
    const bar = document.createElement('div');
    bar.className = 'comet-insp-fmt';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');

    const fwBase = mapFontWeight(edits.fontWeight != null ? edits.fontWeight : readFormatBaseline('fontWeight'));
    const fsBase = mapFontStyle(edits.fontStyle != null ? edits.fontStyle : readFormatBaseline('fontStyle'));
    const tdBase = mapTextDecoration(edits.textDecoration != null ? edits.textDecoration : readFormatBaseline('textDecoration'));
    const taBase = mapTextAlign(edits.textAlign != null ? edits.textAlign : readFormatBaseline('textAlign'));
    const ttBase = mapTextTransform(edits.textTransform != null ? edits.textTransform : readFormatBaseline('textTransform'));

    function mkToggle(label, title, prop, onValue, offValue, isOn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'comet-insp-fmt-btn' + (isOn ? ' active' : '');
      b.dataset.inspFmt = prop;
      b.dataset.onValue = onValue;
      b.dataset.offValue = offValue;
      b.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      b.title = title;
      b.textContent = label;
      return b;
    }

    bar.appendChild(mkToggle('B', 'Bold (fontWeight 700/400)', 'fontWeight', '700', '400',
      fmtActive(edits, 'fontWeight', '700', '400', fwBase === '700' ? '700' : '400')));
    bar.appendChild(mkToggle('I', 'Italic (fontStyle italic/normal)', 'fontStyle', 'italic', 'normal',
      fmtActive(edits, 'fontStyle', 'italic', 'normal', fsBase)));
    bar.appendChild(mkToggle('U', 'Underline (textDecoration underline/none)', 'textDecoration', 'underline', 'none',
      fmtActive(edits, 'textDecoration', 'underline', 'none', tdBase)));

    const align = document.createElement('div');
    align.className = 'comet-insp-fmt-align';
    align.setAttribute('role', 'group');
    align.setAttribute('aria-label', 'Text alignment');
    const alignLabels = { left: 'L', center: 'C', right: 'R', justify: 'J' };
    const alignTitles = {
      left: 'Align left',
      center: 'Align center',
      right: 'Align right',
      justify: 'Justify',
    };
    TEXT_ALIGN_VALUES.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'comet-insp-fmt-btn comet-insp-fmt-align-btn' + (taBase === v ? ' active' : '');
      b.dataset.inspFmt = 'textAlign';
      b.dataset.alignValue = v;
      b.setAttribute('aria-pressed', taBase === v ? 'true' : 'false');
      b.title = alignTitles[v];
      b.textContent = alignLabels[v];
      align.appendChild(b);
    });
    bar.appendChild(align);

    const cycle = document.createElement('button');
    cycle.type = 'button';
    cycle.className = 'comet-insp-fmt-btn comet-insp-fmt-transform';
    cycle.dataset.inspFmt = 'textTransform';
    cycle.dataset.transformValue = ttBase;
    cycle.title = 'Cycle textTransform (uppercase / lowercase / capitalize / none)';
    cycle.textContent = ttBase === 'uppercase' ? 'AA'
      : ttBase === 'lowercase' ? 'aa'
        : ttBase === 'capitalize' ? 'Aa'
          : 'off';
    bar.appendChild(cycle);
    return bar;
  }

  function syncFormatToolbar(bar) {
    if (!bar) return;
    const edits = currentEdits();
    const fw = mapFontWeight(edits.fontWeight != null ? edits.fontWeight : readFormatBaseline('fontWeight'));
    const fs = mapFontStyle(edits.fontStyle != null ? edits.fontStyle : readFormatBaseline('fontStyle'));
    const td = mapTextDecoration(edits.textDecoration != null ? edits.textDecoration : readFormatBaseline('textDecoration'));
    const ta = mapTextAlign(edits.textAlign != null ? edits.textAlign : readFormatBaseline('textAlign'));
    const tt = mapTextTransform(edits.textTransform != null ? edits.textTransform : readFormatBaseline('textTransform'));

    bar.querySelectorAll('[data-insp-fmt="fontWeight"]').forEach((b) => {
      const on = fw === '700' || parseInt(fw, 10) >= 600;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="fontStyle"]').forEach((b) => {
      const on = fs === 'italic';
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textDecoration"]').forEach((b) => {
      const on = td === 'underline';
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textAlign"]').forEach((b) => {
      const on = b.dataset.alignValue === ta;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textTransform"]').forEach((b) => {
      b.dataset.transformValue = tt;
      b.textContent = tt === 'uppercase' ? 'AA'
        : tt === 'lowercase' ? 'aa'
          : tt === 'capitalize' ? 'Aa'
            : 'off';
    });
  }

  function onInspectorFormatClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-insp-fmt]') : null;
    if (!btn || !inspector.descriptor || !inspector.el) return;
    // Don't treat format clicks as Reset.
    e.preventDefault();
    e.stopPropagation();
    const prop = btn.dataset.inspFmt;
    let value = '';
    if (prop === 'fontWeight' || prop === 'fontStyle' || prop === 'textDecoration') {
      const onValue = btn.dataset.onValue;
      const offValue = btn.dataset.offValue;
      const isOn = btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true';
      value = isOn ? offValue : onValue;
    } else if (prop === 'textAlign') {
      value = btn.dataset.alignValue || 'left';
    } else if (prop === 'textTransform') {
      const cur = btn.dataset.transformValue || readFormatBaseline('textTransform') || 'none';
      value = nextTextTransform(cur);
    } else {
      return;
    }
    // Live style writes + edits payload (existing schema keys).
    applyLive(prop, value);
    recordEdit(prop, value);
    // Keep the existing fontWeight select (if present) in sync when Bold toggles.
    if (prop === 'fontWeight') {
      const fwRow = inspRows && inspRows.querySelector('.comet-insp-row[data-prop="fontWeight"]');
      const sel = fwRow && fwRow.querySelector('[data-insp-control]');
      if (sel) sel.value = mapFontWeight(value);
    }
    const bar = btn.closest('.comet-insp-fmt');
    syncFormatToolbar(bar);
    if (hintProp === prop) scheduleRedraw();
  }

  function renderInspector() {
    if (!inspPanel) return;
    const el = inspector.el;
    if (!el) {
      inspPanel.hidden = true;
      return;
    }
    clearPropertyHint();
    inspRows.innerHTML = '';
    const edits = currentEdits();
    const props = inspectorProps(el);
    const buckets = { Text: [], Layout: [], Appearance: [], Other: [] };
    props.forEach((p) => {
      const cat = propCategory(p.prop);
      buckets[cat].push(p);
    });
    let rowIndex = 0;
    CAT_ORDER.forEach((cat) => {
      const items = buckets[cat];
      if (!items.length) return;
      const collapsed = isCatCollapsed(cat);
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'comet-insp-cat-header' + (collapsed ? ' is-collapsed' : '');
      header.dataset.cat = cat;
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      header.title = (collapsed ? 'Expand ' : 'Collapse ') + cat;
      const chev = document.createElement('span');
      chev.className = 'comet-insp-cat-chevron';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '▸';
      const lab = document.createElement('span');
      lab.className = 'comet-insp-cat-label';
      lab.textContent = cat;
      header.appendChild(chev);
      header.appendChild(lab);
      header.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleCatCollapse(cat);
      });

      const body = document.createElement('div');
      body.className = 'comet-insp-cat-body';
      body.dataset.cat = cat;
      body.hidden = collapsed;

      items.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'comet-insp-row' + (p.prop === 'text' ? ' comet-insp-row-text' : '');
        row.dataset.prop = p.prop;
        row.tabIndex = -1;
        row.style.setProperty('--row-delay', Math.min(rowIndex * 30, 200) + 'ms');
        rowIndex++;

        const propLab = document.createElement('span');
        propLab.className = 'comet-insp-label';
        propLab.textContent = p.prop;
        propLab.title = p.prop;

        const control = buildControl(p, edits);

        // Re-apply stored edits live when reopening the inspector.
        if (edits[p.prop] !== undefined && edits[p.prop] !== null && String(edits[p.prop]).trim() !== '') {
          applyLive(p.prop, String(edits[p.prop]));
        }

        const rst = document.createElement('button');
        rst.type = 'button';
        rst.className = 'comet-insp-reset';
        rst.textContent = 'Reset';
        rst.title = 'Reset ' + p.prop + ' to original';
        rst.dataset.inspReset = '1';

        row.appendChild(propLab);
        row.appendChild(control);
        row.appendChild(rst);
        body.appendChild(row);
      });

      inspRows.appendChild(header);
      inspRows.appendChild(body);
    });
    // Re-apply formatting toolbar edits (fontStyle/textDecoration/textAlign/
    // textTransform) that are not independent inspector rows.
    ['fontStyle', 'textDecoration', 'textAlign', 'textTransform', 'fontWeight'].forEach((prop) => {
      if (edits[prop] !== undefined && edits[prop] !== null && String(edits[prop]).trim() !== '') {
        applyLive(prop, String(edits[prop]));
      }
    });
    const textRow = inspRows.querySelector('.comet-insp-row[data-prop="text"]');
    const bar = textRow && textRow.querySelector('.comet-insp-fmt');
    if (bar) syncFormatToolbar(bar);
    updateInspectorState();
    updateSelectionUI();
  }

  // Accent-marks edited rows and refreshes the "N edits" footer count.
  function updateInspectorState() {
    if (!inspPanel) return;
    const edits = currentEdits();
    let n = 0;
    const counted = new Set();
    inspRows.querySelectorAll('.comet-insp-row').forEach((row) => {
      const prop = row.dataset.prop;
      const v = edits[prop];
      const nonEmpty = v !== undefined && v !== null && String(v).trim() !== '';
      const wasEdited = row.classList.contains('edited');
      row.classList.toggle('edited', nonEmpty);
      if (nonEmpty && !wasEdited) playMotion(row, 'edited-pulse', 400);
      if (nonEmpty) {
        n++;
        counted.add(prop);
      }
    });
    // Formatting toolbar props (textAlign etc.) may lack their own row.
    Object.keys(edits || {}).forEach((prop) => {
      if (counted.has(prop)) return;
      const v = edits[prop];
      if (v !== undefined && v !== null && String(v).trim() !== '') n++;
    });
    // Mark the text row edited when any format toolbar prop is live-edited.
    const textRow = inspRows.querySelector('.comet-insp-row[data-prop="text"]');
    if (textRow) {
      const fmtEdited = ['fontStyle', 'textDecoration', 'textAlign', 'textTransform']
        .some((p) => edits[p] != null && String(edits[p]).trim() !== '');
      if (fmtEdited) textRow.classList.add('edited');
    }
    inspCountEl.textContent = n === 1 ? '1 edit' : n + ' edits';
  }

  function openInspector(el, descriptor) {
    clearPropertyHint();
    inspector.el = el;
    inspector.descriptor = descriptor;
    const selectedIndex = state.elements.findIndex((en) => en.descriptor === descriptor);
    if (selectedIndex !== -1) state.activeIndex = selectedIndex;
    captureOriginals(el);
    renderInspector();
    inspPanel.hidden = false;
    inspPanel.classList.remove('is-open');
    if (!isReducedMotion()) {
      void inspPanel.offsetWidth;
      inspPanel.classList.add('is-open');
    }
    positionInspector();
    updateSelectionUI();
  }

  function closeInspector() {
    clearPropertyHint();
    inspector.el = null;
    inspector.descriptor = null;
    inspectorOriginals = new Map();
    if (inspPanel) {
      inspPanel.classList.remove('is-open');
      inspPanel.hidden = true;
    }
  }

  function valueFromControl(control, prop) {
    if (!control) return '';
    if (control.type === 'range') {
      return formatManipValue(prop, control.value, control.dataset.unit || '');
    }
    return control.value;
  }

  // Live manipulators write element.style / textContent immediately and
  // store the live value as the edits payload entry.
  function onInspectorInput(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const row = t.closest('.comet-insp-row');
    if (!row || !inspector.descriptor) return;
    const prop = row.dataset.prop;
    const control = t.matches('[data-insp-control]') ? t : row.querySelector('[data-insp-control]');
    if (!control) return;
    const v = valueFromControl(control, prop);
    if (control.type === 'range') {
      const valEl = row.querySelector('.comet-insp-val');
      if (valEl) {
        valEl.textContent = v;
        playMotion(valEl, 'value-tick', 100);
      }
    }
    if (prop === 'text' && control.tagName === 'TEXTAREA') autoGrowTextarea(control);
    applyLive(prop, v);
    recordEdit(prop, v);
    // Keep Bold toolbar in sync when the fontWeight select changes.
    if (prop === 'fontWeight') {
      const textRow = inspRows && inspRows.querySelector('.comet-insp-row[data-prop="text"]');
      const bar = textRow && textRow.querySelector('.comet-insp-fmt');
      if (bar) syncFormatToolbar(bar);
    }
    if (hintProp === prop) scheduleRedraw();
  }

  // Per-row Reset: restore original style/text and drop the stored edit.
  function onInspectorReset(e) {
    if (e.target && e.target.closest && e.target.closest('[data-insp-fmt]')) return;
    const btn = e.target && e.target.closest ? e.target.closest('[data-insp-reset]') : null;
    if (!btn) return;
    const row = btn.closest('.comet-insp-row');
    if (!row) return;
    const prop = row.dataset.prop;
    restoreProp(prop);
    syncRowControl(row, prop);
    playMotion(row, 'reset-flash', 200);
    updateInspectorState();
    if (hintProp === prop) scheduleRedraw();
  }

  function onInspectorResetAll() {
    if (!inspector.el) return;
    const props = Array.from(inspectorOriginals.keys());
    for (const prop of props) restoreProp(prop);
    inspRows.querySelectorAll('.comet-insp-row').forEach((row) => {
      syncRowControl(row, row.dataset.prop);
      playMotion(row, 'reset-flash', 200);
    });
    const textRow = inspRows.querySelector('.comet-insp-row[data-prop="text"]');
    const bar = textRow && textRow.querySelector('.comet-insp-fmt');
    if (bar) syncFormatToolbar(bar);
    updateInspectorState();
    if (hintProp) scheduleRedraw();
  }

  function setPropertyHint(prop) {
    if (hintProp === prop) return;
    hintProp = prop;
    if (inspRows) {
      inspRows.querySelectorAll('.comet-insp-row').forEach((row) => {
        row.classList.toggle('hint-active', row.dataset.prop === prop);
      });
    }
    startHintLoop();
    scheduleRedraw();
  }

  function clearPropertyHint() {
    if (!hintProp && !hintRaf) {
      if (inspRows) {
        inspRows.querySelectorAll('.comet-insp-row.hint-active').forEach((row) => {
          row.classList.remove('hint-active');
        });
      }
      return;
    }
    hintProp = null;
    stopHintLoop();
    if (inspRows) {
      inspRows.querySelectorAll('.comet-insp-row.hint-active').forEach((row) => {
        row.classList.remove('hint-active');
      });
    }
    scheduleRedraw();
  }

  function startHintLoop() {
    if (hintRaf) return;
    const tick = () => {
      hintRaf = 0;
      if (!hintProp) return;
      scheduleRedraw();
      hintRaf = requestAnimationFrame(tick);
    };
    hintRaf = requestAnimationFrame(tick);
  }

  function stopHintLoop() {
    if (hintRaf) {
      cancelAnimationFrame(hintRaf);
      hintRaf = 0;
    }
  }

  function textAreaRect(el) {
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeValue && node.nodeValue.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          if (rects && rects.length) {
            const r = rects[0];
            return { left: r.left, top: r.top, width: r.width, height: r.height };
          }
        }
        node = walker.nextNode();
      }
    } catch (_) { /* fall through */ }
    try {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    } catch (_) {
      return null;
    }
  }

  // True when a property-hint target is editor/extension UI (must never highlight).
  function isEditorInternalTarget(el) {
    if (!el || el.nodeType !== 1) return true;
    if (host && (el === host || (host.contains && host.contains(el)))) return true;
    // Shadow-root descendants may not report as contained by the host in all stubs.
    try {
      if (shadow && typeof shadow.contains === 'function' && shadow.contains(el)) return true;
    } catch (_) { /* ok */ }
    let cur = el;
    for (let i = 0; i < 24 && cur && cur.nodeType === 1; i++) {
      let cls = '';
      try { cls = typeof cur.className === 'string' ? cur.className : (cur.getAttribute && cur.getAttribute('class')) || ''; } catch (_) { cls = ''; }
      if (typeof cls === 'string' && cls) {
        if (/\bcomet-insp-/.test(cls) || /\bcomet-toolbar\b/.test(cls) || /\bcomet-chat-/.test(cls) || /\bcomet-chip\b/.test(cls) || /\bcomet-inspector\b/.test(cls)) {
          return true;
        }
      }
      try { if (cur.id === 'hermes-annotate-host') return true; } catch (_) { /* ok */ }
      cur = cur.parentElement || cur.parentNode;
    }
    // Belt-and-braces: rect fully inside the inspector panel.
    if (inspPanel) {
      try {
        const pr = inspPanel.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (pr && er && er.width > 0 && er.height > 0
          && er.left >= pr.left && er.top >= pr.top
          && er.right <= pr.right && er.bottom <= pr.bottom) {
          return true;
        }
      } catch (_) { /* ok */ }
    }
    return false;
  }

  function drawPropertyHint() {
    if (!ctx || !hintProp || !inspector.el) return;
    const el = inspector.el;
    if (isEditorInternalTarget(el)) return;
    let box = null;
    try { box = el.getBoundingClientRect(); } catch (_) { box = null; }
    if (!box) return;
    let cs = null;
    try { cs = getComputedStyle(el); } catch (_) { cs = null; }

    ctx.save();
    ctx.strokeStyle = '#ffd166';
    ctx.fillStyle = 'rgba(255, 209, 102, 0.18)';
    ctx.lineWidth = 1.5;

    if (hintProp === 'width') {
      ctx.beginPath();
      ctx.moveTo(box.left, box.top);
      ctx.lineTo(box.left, box.bottom);
      ctx.moveTo(box.right, box.top);
      ctx.lineTo(box.right, box.bottom);
      ctx.stroke();
    } else if (hintProp === 'height') {
      ctx.beginPath();
      ctx.moveTo(box.left, box.top);
      ctx.lineTo(box.right, box.top);
      ctx.moveTo(box.left, box.bottom);
      ctx.lineTo(box.right, box.bottom);
      ctx.stroke();
    } else if (hintProp === 'margin' && cs) {
      const mt = parsePx(cs.marginTop);
      const mr = parsePx(cs.marginRight);
      const mb = parsePx(cs.marginBottom);
      const ml = parsePx(cs.marginLeft);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(box.left - ml, box.top - mt, box.width + ml + mr, box.height + mt + mb);
    } else if (hintProp === 'padding' && cs) {
      const pt = parsePx(cs.paddingTop);
      const pr = parsePx(cs.paddingRight);
      const pb = parsePx(cs.paddingBottom);
      const pl = parsePx(cs.paddingLeft);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(box.left + pl, box.top + pt,
        Math.max(0, box.width - pl - pr), Math.max(0, box.height - pt - pb));
    } else if (hintProp === 'borderRadius') {
      const rad = cs ? Math.max(4, Math.min(16, parsePx(cs.borderTopLeftRadius) || 8)) : 8;
      const corners = [
        [box.left, box.top],
        [box.right, box.top],
        [box.right, box.bottom],
        [box.left, box.bottom],
      ];
      for (const [x, y] of corners) {
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (TEXT_HINT_PROPS.has(hintProp)) {
      const tr = textAreaRect(el) || box;
      ctx.fillRect(tr.left, tr.top, tr.width, tr.height);
      ctx.strokeRect(tr.left, tr.top, tr.width, tr.height);
    } else if (UNDERLINE_HINT_PROPS.has(hintProp)) {
      const tr = textAreaRect(el) || box;
      ctx.beginPath();
      ctx.moveTo(tr.left, tr.top + tr.height - 1);
      ctx.lineTo(tr.left + tr.width, tr.top + tr.height - 1);
      ctx.stroke();
    }

    ctx.restore();
  }

  function onInspectorPointerOver(e) {
    const row = e.target && e.target.closest ? e.target.closest('.comet-insp-row') : null;
    if (!row) return;
    setPropertyHint(row.dataset.prop);
  }

  function onInspectorFocusIn(e) {
    const row = e.target && e.target.closest ? e.target.closest('.comet-insp-row') : null;
    if (!row) return;
    setPropertyHint(row.dataset.prop);
  }

  function onInspectorPointerLeave(e) {
    // Keep hint while focus remains inside a control of the active row.
    const active = shadow && shadow.activeElement;
    if (active && active.closest && active.closest('.comet-insp-row')) return;
    const related = e.relatedTarget;
    if (related && related.closest && related.closest('.comet-insp-row')) return;
    clearPropertyHint();
  }

  function onInspectorFocusOut(e) {
    const next = e.relatedTarget;
    if (next && next.closest && next.closest('.comet-insp-row')) return;
    // Defer so a focus move within the panel does not flash-clear the hint.
    setTimeout(() => {
      const active = shadow && shadow.activeElement;
      if (active && active.closest && active.closest('.comet-insp-row')) return;
      clearPropertyHint();
    }, 0);
  }

  // Footer instruction textarea: same instruction field as the chat card.
  function onInspectorInstr(e) {
    if (!inspector.descriptor) return;
    const value = String(e.target.value || '').slice(0, MAX_INSTR);
    inspector.descriptor.instruction = value;
    e.target.value = value;
    if (chatInput) chatInput.value = value;
  }

  /* ---------------- toolbar ---------------- */
  function applyMode() {
    canvas.style.pointerEvents = state.annotateOn ? 'all' : 'none';
    canvas.classList.toggle('active', state.annotateOn || state.elementMode);
    toolbar.querySelector('[data-act="annotate"]').classList.toggle('active', state.annotateOn);
    toolbar.querySelector('[data-act="element"]').classList.toggle('active', state.elementMode);
    if (modePill) modePill.style.transform = state.elementMode ? 'translateX(100%)' : 'translateX(0)';
    updateSelectionPulse();
  }

  function setAnnotate(on) {
    if (on) setElementMode(false);
    state.annotateOn = on;
    applyMode();
  }

  function setElementMode(on) {
    if (!on && state.elementMode) {
      // Leaving picker mode: drop the pending selection + close the card
      // and the inspector (mode switch to Annotate closes the panel too).
      if (pending && !pending.isEdit && pending.outlineEl && pending.outlineEl.parentNode) {
        pending.outlineEl.parentNode.removeChild(pending.outlineEl);
      }
      pending = null;
      if (chatCard) chatCard.hidden = true;
      closeInspector();
      stopHoverLoop();
      mouse = null;
      mouseDirty = false;
      hoveredEl = null;
    }
    state.elementMode = on;
    if (on) {
      state.annotateOn = false;
      startHoverLoop();
    }
    applyMode();
    updateSelectionPulse();
  }

  function toggleAnnotate() {
    setAnnotate(!state.annotateOn);
  }

  function toggleElement() {
    setElementMode(!state.elementMode);
  }

  function cycleColor() {
    const i = COLORS.indexOf(state.color);
    state.color = COLORS[(i + 1) % COLORS.length];
    const dots = toolbar.querySelectorAll('.comet-swatch .dot');
    dots.forEach((d, j) => d.classList.toggle('active', COLORS[j] === state.color));
    redraw(); // stroke color only; selection outlines stay spec-red
  }

  function undo() {
    state.strokes.pop();
    redraw();
  }

  function clearAll() {
    state.strokes = [];
    const old = state.elements.slice();
    state.elements = [];
    state.activeIndex = -1;
    state.nextIndex = 1;
    old.forEach((en) => removeOutlineWithFade(en.outlineEl));
    if (pending && !pending.isEdit) removeOutlineWithFade(pending.outlineEl);
    pending = null;
    if (chatCard) chatCard.hidden = true;
    closeInspector();
    updateCount();
    updateSelectionPulse();
    redraw();
  }

  // Return the visible union in CSS pixels. The service worker applies dpr
  // when it crops the captured bitmap, so this function never scales x/y/w/h.
  function computeCaptureRect(entries) {
    const selected = Array.isArray(entries) ? entries : [];
    if (!selected.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const en of selected) {
      let r = null;
      try { r = en && en.el && en.el.getBoundingClientRect(); } catch (_) { r = null; }
      if (!r) continue;
      const l = Number(r.left);
      const t = Number(r.top);
      const rr = Number(r.right != null ? r.right : r.left + r.width);
      const b = Number(r.bottom != null ? r.bottom : r.top + r.height);
      if (![l, t, rr, b].every(Number.isFinite) || rr <= l || b <= t) continue;
      left = Math.min(left, l);
      top = Math.min(top, t);
      right = Math.max(right, rr);
      bottom = Math.max(bottom, b);
    }
    const vw = Math.max(0, Number(window.innerWidth) || 0);
    const vh = Math.max(0, Number(window.innerHeight) || 0);
    if (![left, top, right, bottom].every(Number.isFinite) || !vw || !vh) return null;
    const x = Math.max(0, Math.min(vw, left - 8));
    const y = Math.max(0, Math.min(vh, top - 8));
    const maxX = Math.max(x, Math.min(vw, right + 8));
    const maxY = Math.max(y, Math.min(vh, bottom + 8));
    const round = (n) => Math.round(n * 1000) / 1000;
    return {
      x: round(x),
      y: round(y),
      w: round(Math.max(0, maxX - x)),
      h: round(Math.max(0, maxY - y)),
      dpr: Number(window.devicePixelRatio) > 0 ? Number(window.devicePixelRatio) : 1,
    };
  }

  function descriptorForPayload(en) {
    const d = Object.assign({}, en.descriptor);
    d.instruction = String(d.instruction || '').trim().slice(0, MAX_INSTR);
    if (d.edits) {
      const edits = {};
      for (const k of Object.keys(d.edits)) {
        const v = d.edits[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          edits[k] = String(v).trim();
        }
      }
      if (Object.keys(edits).length) d.edits = edits;
      else delete d.edits;
    }
    return d;
  }

  async function send(button) {
    if (button) playMotion(button, 'send-press', 100);
    let label = '';
    try {
      const got = await chrome.storage.local.get('contextLabel');
      label = got && got.contextLabel ? String(got.contextLabel) : '';
    } catch (_) { /* storage unavailable */ }
    const payload = {
      source: 'comet-extension',
      url: location.href,
      title: document.title || '',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      label: label.slice(0, MAX_TEXT),
      strokes: state.strokes.map((s) => ({ color: s.color, width: s.width, points: s.points })),
      // v1.4: every selected descriptor carries its own instruction + edits.
      elements: state.elements.map(descriptorForPayload),
    };
    const captureRect = computeCaptureRect(state.elements);
    if (captureRect) payload.captureRect = captureRect;
    setStatus('sending…', '');
    let ok = false;
    // Hide the tool overlay (toolbar, inspector, canvas, markers) so the
    // captured screenshot shows only the page element, never the tool UI.
    // The SW captures before it responds, so restoring after the round-trip
    // is safe.
    let overlayHidden = false;
    try {
      if (host && host.parentNode) {
        host.style.visibility = 'hidden';
        overlayHidden = true;
      }
    } catch (_) { /* overlay stays visible */ }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'annotate', payload });
      ok = !!(resp && resp.ok);
    } catch (_) { ok = false; }
    try {
      if (overlayHidden && host) host.style.visibility = '';
    } catch (_) { /* ok */ }
    if (ok) {
      setStatus(BRIDGE_OK, 'ok');
      sendFeedback(button, true);
      state.strokes = [];
      const old = state.elements.slice();
      state.elements = [];
      state.activeIndex = -1;
      state.nextIndex = 1;
      old.forEach((en) => removeOutlineWithFade(en.outlineEl));
      pending = null;
      if (chatCard) chatCard.hidden = true;
      closeInspector();
      updateCount();
      updateSelectionPulse();
      redraw();
    } else {
      setStatus(BRIDGE_OFFLINE, 'err');
      sendFeedback(button, false);
    }
  }

  function onToolbarClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'annotate': toggleAnnotate(); break;
      case 'element': toggleElement(); break;
      case 'color': cycleColor(); break;
      case 'undo': undo(); break;
      case 'clear': clearAll(); break;
      case 'send': send(btn); break;
      case 'power': fullExit(); break;
      case 'exit': fullExit(); break;
      case 'collapse':
        setCollapsed(!state.collapsed);
        break;
      default: break;
    }
  }

  function onToolbarChange(e) {
    if (e.target && e.target.dataset && e.target.dataset.act === 'width') {
      const v = parseInt(e.target.value, 10);
      if (WIDTHS.indexOf(v) !== -1) state.width = v;
    }
  }

  /* ---------------- drag (toolbar handle + collapsed chip) ---------------- */
  function startDrag(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left button only
    e.preventDefault();
    const target = e.currentTarget; // ⋮⋮ handle or the chip itself
    try { target.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    const base = state.position || defaultPosition();
    drag = {
      target,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: base.x,
      baseY: base.y,
      moved: false,
    };
    lastDragPersist = 0;
    target.classList.add('dragging');
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    applyPosition(drag.baseX + dx, drag.baseY + dy); // live position update
    const now = Date.now();
    if (now - lastDragPersist >= DRAG_PERSIST_MS) {
      lastDragPersist = now;
      saveTabState({ position: state.position }); // throttled per-tab persist
    }
  }

  function endDrag(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    try {
      if (drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.releasePointerCapture(drag.pointerId);
      }
    } catch (_) { /* ok */ }
    drag.target.classList.remove('dragging');
    if (drag.moved && drag.target === chipEl) suppressChipClick = true;
    drag = null;
    saveTabState({ position: state.position }); // final persist
  }

  function onChipClick() {
    if (suppressChipClick) {
      suppressChipClick = false; // this click finished a drag, not a restore
      return;
    }
    setCollapsed(false); // click restores the full toolbar
  }

  function teardownHost() {
    if (host && host.parentNode) {
      try { host.parentNode.removeChild(host); } catch (_) { /* ok */ }
    }
    host = null;
    shadow = null;
    toolbar = null;
    canvas = null;
    ctx = null;
    statusEl = null;
    countEl = null;
    selLayer = null;
    hlEl = null;
    hlChip = null;
    hoverBoxEl = null;
    if (hoverBoxRaf) {
      cancelAnimationFrame(hoverBoxRaf);
      hoverBoxRaf = 0;
    }
    chatCard = null;
    chatHead = null;
    chatInput = null;
    chipEl = null;
    dragHandle = null;
    inspPanel = null;
    inspRows = null;
    inspCountEl = null;
    inspSelectionCountEl = null;
    inspSelectionList = null;
    inspResetAllBtn = null;
    inspInput = null;
    inspSend = null;
    modeToggle = null;
    modePill = null;
    toastEl = null;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = 0;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = 0;
    exitTimer = 0;
    inspectorOriginals = new Map();
    hintProp = null;
    stopHintLoop();
    stopSelectionPulse();
    cancelHoverLerp();
    state.strokes = [];
    state.elements = [];
    state.activeIndex = -1;
    state.nextIndex = 1;
    // UI state is gone with the DOM; rebuild from chrome.storage.session on
    // reinject (setCollapsed early-returns when the value is unchanged, so
    // the collapsed/position state must be reset here).
    state.collapsed = false;
    state.position = null;
    state.collapsedCats = {};
    window.__hermesAnnotateInjected = false;
    window.__browserlinkInjected = false;
  }

  // Full exit: animate the host out, then remove it and all listeners.
  function fullExit() {
    if (exitTimer) return;
    // Cancel any pending pointer capture (draw strokes + drag handles).
    if (state.capturedPointerId != null && canvas) {
      try {
        if (canvas.hasPointerCapture(state.capturedPointerId)) {
          canvas.releasePointerCapture(state.capturedPointerId);
        }
      } catch (_) { /* ok */ }
      state.capturedPointerId = null;
    }
    if (drag) {
      try {
        if (drag.target.hasPointerCapture(drag.pointerId)) {
          drag.target.releasePointerCapture(drag.pointerId);
        }
      } catch (_) { /* ok */ }
      drag.target.classList.remove('dragging');
    }
    drag = null;
    suppressChipClick = false;

    state.annotateOn = false;
    state.elementMode = false;
    state.currentStroke = null;
    if (pending && !pending.isEdit) removeOutlineWithFade(pending.outlineEl);
    pending = null;
    state.elements.forEach((en) => removeOutlineWithFade(en.outlineEl));
    state.elements = [];
    state.activeIndex = -1;
    closeInspector();
    stopHoverLoop();
    stopSelectionPulse();
    mouse = null;
    mouseDirty = false;
    hoveredEl = null;

    // Unbind page-level listeners so nothing of ours remains active.
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('click', onPageClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', repositionAll, true);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('orientationchange', onWindowResize);
    saveTabState({ enabled: false }); // deactivation persists per tab
    try {
      chrome.storage.local.set({ toolEnabled: false }); // master switch stays off across refreshes
    } catch (_) { /* storage unavailable */ }

    if (host && host.parentNode && !isReducedMotion()) {
      host.classList.add('is-exiting');
      exitTimer = setTimeout(() => {
        exitTimer = 0;
        teardownHost();
      }, 120);
    } else {
      teardownHost();
    }
  }

  // Idempotent re-injection (popup master switch ON / browserlinkToggle true).
  function reinject() {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = 0;
      teardownHost();
    }
    if (host && host.parentNode) return; // already active
    try {
      updateMotionPreference();
      buildUI();
      bindEvents();
      injectShadowStyles();
      window.__hermesAnnotateInjected = true;
      window.__browserlinkInjected = true;
      chrome.storage.session.get(tabStorageKey()).then((got) => {
        const st = got && got[tabStorageKey()] ? got[tabStorageKey()] : null;
        restoreTabState(st);
      }).catch(() => {
        restoreTabState(null);
      });
      saveTabState({ enabled: true });
      try {
        chrome.storage.local.set({ toolEnabled: true }); // master switch reflects active tool
      } catch (_) { /* storage unavailable */ }
      pingTabId();
    } catch (err) {
      try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (_) { /* ok */ }
      window.__hermesAnnotateInjected = false;
      window.__browserlinkInjected = false;
      console.error('Browserlink reinject failed:', err);
    }
  }

  function restoreTabState(st) {
    if (st && st.position && typeof st.position.x === 'number' && typeof st.position.y === 'number') {
      applyPosition(st.position.x, st.position.y);
    } else {
      const d = defaultPosition();
      applyPosition(d.x, d.y);
    }
    setCollapsed(!!(st && st.collapsed));
    // Inspector category collapse is per-tab view state (default: all expanded).
    state.collapsedCats = (st && st.collapsedCats && typeof st.collapsedCats === 'object')
      ? Object.assign({}, st.collapsedCats)
      : {};
  }

  // Messages from the popup (forwarded by the service worker) / background.
  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (sender && sender.tab && sender.tab.id) rememberTabId(sender.tab.id);
    if (msg.type === 'browserlinkGetTabId') {
      try {
        sendResponse({ ok: true, tabId: sender && sender.tab ? sender.tab.id : null });
      } catch (_) { /* ok */ }
      return false;
    }
    if (msg.type === 'browserlinkGetState') {
      // Popup asks whether the tool is currently active on this tab.
      try {
        sendResponse({ ok: true, enabled: !!(host && host.parentNode) });
      } catch (_) { /* ok */ }
      return false;
    }
    if (msg.type === 'browserlinkToggle') {
      if (msg.enabled === true) reinject();
      else fullExit(); // off == exit
      return false;
    }
    if (msg.type === 'browserlinkExit') {
      fullExit();
      return false;
    }
    return false;
  }

  /* ---------------- UI construction ---------------- */
  function animateEntrance() {
    if (!host) return;
    host.classList.add('is-entering');
    if (isReducedMotion()) {
      host.classList.add('is-entered');
      return;
    }
    setTimeout(() => {
      if (host) {
        host.classList.remove('is-entering');
        host.classList.add('is-entered');
      }
    }, 0);
  }

  function buildUI() {
    host = document.createElement('div');
    host.id = 'hermes-annotate-host';
    // Critical layout inline (fallback if stylesheet injection ever fails).
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'closed' });

    toolbar = document.createElement('div');
    toolbar.className = 'comet-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Browserlink — Browser Annotate & Connect');
    toolbar.innerHTML =
      '<button type="button" data-act="power" class="comet-btn comet-power" title="Deactivate Browserlink (removes everything from this page)">⏻</button>' +
      '<button type="button" data-act="collapse" class="comet-btn comet-collapse" title="Collapse to a floating chip">−</button>' +
      '<span class="comet-drag" data-act="drag" title="Drag to move">⋮⋮</span>' +
      '<span class="comet-mode-toggle" role="group" aria-label="Mode">' +
      '  <span class="comet-mode-pill" aria-hidden="true"></span>' +
      '  <button type="button" data-act="annotate" class="comet-btn comet-mode-btn" title="Toggle drawing">Annotate</button>' +
      '  <button type="button" data-act="element" class="comet-btn comet-mode-btn" title="Element picker: hover to highlight, click to select + instruct">Element</button>' +
      '</span>' +
      '<button type="button" data-act="color" class="comet-swatch" title="Cycle color">' +
      '  <span class="dot" style="background:#ff5252"></span>' +
      '  <span class="dot" style="background:#4a9eff"></span>' +
      '  <span class="dot" style="background:#ffd166"></span>' +
      '  <span class="dot" style="background:#35c759"></span>' +
      '</button>' +
      '<select class="comet-width" data-act="width" title="Stroke width">' +
      '  <option value="2">2</option>' +
      '  <option value="4" selected>4</option>' +
      '  <option value="8">8</option>' +
      '</select>' +
      '<span class="comet-count" data-act="count" title="Selected elements">0 elements</span>' +
      '<button type="button" data-act="undo" class="comet-btn">Undo</button>' +
      '<button type="button" data-act="clear" class="comet-btn">Clear</button>' +
      '<button type="button" data-act="send" class="comet-btn comet-send">Send</button>' +
      '<span class="status"></span>' +
      '<button type="button" data-act="exit" class="comet-btn comet-exit" title="Exit Browserlink (removes everything from this page)">✕</button>';
    dragHandle = toolbar.querySelector('.comet-drag');
    modeToggle = toolbar.querySelector('.comet-mode-toggle');
    modePill = toolbar.querySelector('.comet-mode-pill');

    // Collapsed 48px floating chip (same fixed position as the toolbar).
    chipEl = document.createElement('div');
    chipEl.className = 'comet-chip';
    chipEl.setAttribute('role', 'button');
    chipEl.setAttribute('aria-label', 'Restore Browserlink toolbar');
    chipEl.title = 'Restore Browserlink toolbar';
    chipEl.style.display = 'none';
    const chipDot = document.createElement('span');
    chipDot.className = 'comet-chip-dot';
    chipEl.appendChild(chipDot);

    canvas = document.createElement('canvas');
    canvas.className = 'comet-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    // Element-picker layer: fixed inset-0, pointer-events none. Children are
    // absolutely positioned from getBoundingClientRect() in viewport space.
    selLayer = document.createElement('div');
    selLayer.className = 'comet-sel-layer';
    selLayer.setAttribute('aria-hidden', 'true');

    hlEl = document.createElement('div');
    hlEl.className = 'comet-hl';
    hlEl.style.display = 'none';
    hlChip = document.createElement('div');
    hlChip.className = 'comet-hl-chip';
    hlEl.appendChild(hlChip);

    // Stronger element-mode hover box (v1.6); coexists with the lerped hlEl.
    hoverBoxEl = document.createElement('div');
    hoverBoxEl.className = 'comet-hover-box';
    hoverBoxEl.style.display = 'none';

    // Instruction chat card (bottom-right of the viewport).
    chatCard = document.createElement('div');
    chatCard.className = 'comet-chat';
    chatCard.hidden = true;
    chatCard.innerHTML =
      '<div class="comet-chat-head"></div>' +
      '<textarea class="comet-chat-input" rows="3" ' +
      ' placeholder="Your thoughts/instructions for this element…"></textarea>' +
      '<div class="comet-chat-actions">' +
      '  <button type="button" class="comet-btn" data-chat="cancel">Cancel</button>' +
      '  <button type="button" class="comet-btn comet-chat-add" data-chat="add">Add</button>' +
      '</div>';

    // Element inspector panel (attached below the toolbar, max 320px wide).
    inspPanel = document.createElement('div');
    inspPanel.className = 'comet-inspector';
    inspPanel.hidden = true;
    inspPanel.innerHTML =
      '<div class="comet-insp-head">Element inspector</div>' +
      '<div class="comet-selection-head"><span class="comet-selection-count">0 selected</span></div>' +
      '<div class="comet-selection-list"></div>' +
      '<div class="comet-insp-rows"></div>' +
      '<div class="comet-insp-foot">' +
      '  <div class="comet-insp-foot-meta">' +
      '    <span class="comet-insp-count">0 edits</span>' +
      '    <button type="button" class="comet-insp-reset-all" title="Reset all live edits">Reset all</button>' +
      '  </div>' +
      '  <textarea class="comet-chat-input comet-insp-instr" rows="2" ' +
      ' placeholder="Your thoughts/instructions for this element…"></textarea>' +
      '  <button type="button" class="comet-btn comet-send comet-insp-send">Send</button>' +
      '</div>';

    toastEl = document.createElement('div');
    toastEl.className = 'comet-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.hidden = true;
    toastEl.textContent = 'Sent';

    shadow.appendChild(toolbar);
    shadow.appendChild(chipEl);
    shadow.appendChild(selLayer);
    selLayer.appendChild(hlEl);
    selLayer.appendChild(hoverBoxEl);
    shadow.appendChild(canvas);
    shadow.appendChild(chatCard);
    shadow.appendChild(inspPanel);
    shadow.appendChild(toastEl);
    ctx = canvas.getContext('2d');

    // ONE shadow host on the page; nothing else touches the page DOM.
    document.documentElement.appendChild(host);

    statusEl = toolbar.querySelector('.status');
    countEl = toolbar.querySelector('.comet-count');
    chatHead = chatCard.querySelector('.comet-chat-head');
    chatInput = chatCard.querySelector('.comet-chat-input');
    inspRows = inspPanel.querySelector('.comet-insp-rows');
    inspCountEl = inspPanel.querySelector('.comet-insp-count');
    inspSelectionCountEl = inspPanel.querySelector('.comet-selection-count');
    inspSelectionList = inspPanel.querySelector('.comet-selection-list');
    inspResetAllBtn = inspPanel.querySelector('.comet-insp-reset-all');
    inspInput = inspPanel.querySelector('.comet-insp-instr');
    inspSend = inspPanel.querySelector('.comet-insp-send');
    toolbar.querySelector('.comet-swatch .dot').classList.add('active');
    animateEntrance();
    updateCount();
    applyMode();
    resizeCanvas();
  }

  /* Styles: single source of truth is overlay.css. Manifest also injects it
   * into the page (styles the host); we re-inject it inside the shadow root
   * so toolbar/canvas/status are styled despite the closed shadow boundary. */
  async function injectShadowStyles() {
    const style = document.createElement('style');
    style.setAttribute('data-hermes-annotate', '');
    let css = '';
    try {
      const res = await fetch(chrome.runtime.getURL('overlay.css'));
      if (res.ok) css = await res.text();
    } catch (_) { /* fall through to fallback */ }
    if (!css) {
      // Minimal fallback: critical layout only, same look as overlay.css.
      css =
        '#hermes-annotate-host{position:fixed;inset:0;z-index:2147483646;pointer-events:none;}' +
        '.comet-toolbar{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:6px;' +
        'padding:8px 10px;background:rgba(16,18,24,.92);border:1px solid rgba(255,255,255,.14);border-radius:10px;' +
        'color:#e8eaed;font:13px system-ui,-apple-system,sans-serif;pointer-events:auto;user-select:none;}' +
        '.comet-btn{background:rgba(255,255,255,.08);color:#e8eaed;border:1px solid rgba(255,255,255,.16);' +
        'border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer;}' +
        '.comet-btn.active{background:#4a9eff;border-color:#4a9eff;color:#fff;}' +
        '.comet-btn.comet-send{background:#35c759;border-color:#35c759;color:#07130a;font-weight:600;}' +
        '.comet-swatch{display:flex;gap:3px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);' +
        'border-radius:6px;padding:4px 6px;cursor:pointer;}' +
        '.comet-swatch .dot{width:10px;height:10px;border-radius:50%;border:1px solid rgba(0,0,0,.4);}' +
        '.comet-swatch .dot.active{outline:2px solid #fff;outline-offset:1px;}' +
        '.comet-width{background:rgba(255,255,255,.08);color:#e8eaed;border:1px solid rgba(255,255,255,.16);' +
        'border-radius:6px;padding:4px 6px;font:inherit;}' +
        '.comet-canvas{position:fixed;inset:0;z-index:2147483646;pointer-events:none;touch-action:none;}' +
        '.comet-canvas.active{cursor:crosshair;}' +
        '.status{min-width:90px;text-align:right;font-size:12px;color:#9aa0a6;}' +
        '.status.ok{color:#35c759;}.status.err{color:#ff5252;}' +
        '.comet-sel-layer{position:fixed;inset:0;z-index:2147483646;pointer-events:none;}' +
        '.comet-hl{position:absolute;border:2px solid #4a9eff;background:rgba(74,158,255,.12);' +
        'pointer-events:none;box-sizing:border-box;display:none;}' +
        '.comet-hl-chip{position:absolute;left:0;top:0;transform:translate(0,-100%);background:#4a9eff;color:#fff;' +
        'font:11px/1.4 system-ui;padding:2px 6px;border-radius:4px 4px 0 0;white-space:nowrap;max-width:240px;' +
        'overflow:hidden;text-overflow:ellipsis;}' +
        '.comet-hover-box{position:absolute;border:2px solid #ff6b6b;background:rgba(255,82,82,.08);' +
        'pointer-events:none;box-sizing:border-box;display:none;z-index:1;}' +
        '.comet-insp-cat-header{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:4px 6px;' +
        'border:1px solid transparent;border-radius:6px;background:rgba(255,255,255,.04);color:#e8eaed;' +
        'font:11px/1.3 system-ui;font-weight:600;text-transform:uppercase;cursor:pointer;text-align:left;}' +
        '.comet-insp-cat-chevron{display:inline-block;width:10px;transform:rotate(90deg);transition:transform .15s ease;color:#9aa0a6;}' +
        '.comet-insp-cat-header.is-collapsed .comet-insp-cat-chevron{transform:rotate(0deg);}' +
        '.comet-insp-cat-body{display:flex;flex-direction:column;gap:6px;}' +
        '.comet-insp-cat-body[hidden]{display:none;}' +
        '.comet-el{position:absolute;border:2px dashed #ff5252;pointer-events:none;box-sizing:border-box;}' +
        '.comet-el-badge{position:absolute;left:0;top:0;transform:translate(-50%,-100%);min-width:16px;height:16px;' +
        'border-radius:50%;background:#ff5252;color:#fff;font:bold 10px/16px system-ui;text-align:center;' +
        'padding:0 3px;box-sizing:border-box;white-space:nowrap;}' +
        '.comet-chat{position:fixed;bottom:16px;right:16px;z-index:2147483647;width:280px;' +
        'display:flex;flex-direction:column;gap:8px;padding:10px;background:rgba(16,18,24,.95);' +
        'border:1px solid rgba(255,255,255,.16);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);' +
        'font:13px/1.4 system-ui;color:#e8eaed;pointer-events:auto;}' +
        '.comet-chat[hidden]{display:none;}' +
        '.comet-chat-head{font-size:12px;color:#9aa0a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.comet-chat-input{width:100%;min-height:56px;max-height:140px;resize:vertical;box-sizing:border-box;' +
        'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:6px;' +
        'color:#e8eaed;font:inherit;padding:6px 8px;outline:none;}' +
        '.comet-chat-input:focus{border-color:#4a9eff;}' +
        '.comet-chat-actions{display:flex;justify-content:flex-end;gap:6px;}' +
        '.comet-chat-add{background:#4a9eff;border-color:#4a9eff;color:#fff;}' +
        '.comet-count{min-width:64px;text-align:center;font-size:12px;color:#9aa0a6;white-space:nowrap;}' +
        '.comet-chip{position:fixed;width:48px;height:48px;border-radius:50%;z-index:2147483647;' +
        'display:flex;align-items:center;justify-content:center;background:var(--bl-bg,rgba(16,18,24,.92));' +
        'border:1px solid var(--bl-border,rgba(255,255,255,.14));box-shadow:0 6px 24px rgba(0,0,0,.35);' +
        'cursor:pointer;pointer-events:auto;user-select:none;touch-action:none;}' +
        '.comet-chip-dot{width:14px;height:14px;border-radius:50%;background:var(--bl-accent,#4a9eff);' +
        'box-shadow:0 0 0 4px rgba(74,158,255,.25);}' +
        '.comet-drag{cursor:grab;padding:4px 6px;border-radius:6px;color:var(--bl-muted,#9aa0a6);' +
        'font-weight:600;letter-spacing:1px;touch-action:none;}' +
        '.comet-drag:hover{background:rgba(255,255,255,.14);color:#e8eaed;}' +
        '.comet-chip.dragging,.comet-drag.dragging{cursor:grabbing;}' +
        '.comet-power:hover{background:#35c759;border-color:#35c759;color:#07130a;}' +
        '.comet-exit:hover{background:#ff5252;border-color:#ff5252;color:#fff;}' +
        '.comet-inspector{position:fixed;z-index:2147483647;width:320px;max-width:calc(100vw - 24px);' +
        'max-height:60vh;display:flex;flex-direction:column;gap:8px;padding:10px;' +
        'background:var(--bl-bg,rgba(16,18,24,.95));border:1px solid var(--bl-border,rgba(255,255,255,.16));' +
        'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:13px/1.4 system-ui;' +
        'color:var(--bl-text,#e8eaed);pointer-events:auto;user-select:none;}' +
        '.comet-inspector[hidden]{display:none;}' +
        '.comet-insp-head{font-size:12px;color:#9aa0a6;border-bottom:1px solid rgba(255,255,255,.14);padding-bottom:6px;}' +
        '.comet-insp-rows{overflow-y:auto;display:flex;flex-direction:column;gap:6px;}' +
        '.comet-insp-row{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:6px;' +
        'align-items:center;border:1px solid transparent;border-radius:6px;padding:4px 6px;}' +
        '.comet-insp-row.edited{border-color:#4a9eff;background:rgba(74,158,255,.08);}' +
        '.comet-insp-row.hint-active{border-color:rgba(255,209,102,.7);background:rgba(255,209,102,.08);}' +
        '.comet-insp-label{font-size:11px;color:#9aa0a6;text-transform:capitalize;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;}' +
        '.comet-insp-control{display:flex;align-items:center;gap:6px;min-width:0;}' +
        '.comet-insp-slider{flex:1 1 auto;min-width:0;width:100%;accent-color:#4a9eff;cursor:pointer;}' +
        '.comet-insp-val{flex:0 0 auto;min-width:42px;text-align:right;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;color:#9aa0a6;}' +
        '.comet-insp-input,.comet-insp-select{min-width:0;width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);' +
        'border:1px solid rgba(255,255,255,.16);border-radius:4px;color:#e8eaed;font:inherit;' +
        'padding:3px 5px;outline:none;}' +
        '.comet-insp-select{cursor:pointer;}' +
        '.comet-insp-color{width:36px;height:24px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:4px;background:transparent;cursor:pointer;}' +
        '.comet-insp-input:focus,.comet-insp-select:focus,.comet-insp-row.edited .comet-insp-input,' +
        '.comet-insp-row.edited .comet-insp-select{border-color:#4a9eff;}' +
        '.comet-insp-reset{border:1px solid transparent;background:transparent;color:#9aa0a6;cursor:pointer;font-size:10px;' +
        'padding:2px 4px;border-radius:4px;white-space:nowrap;}' +
        '.comet-insp-reset:hover{color:#ff5252;background:rgba(255,82,82,.12);}' +
        '.comet-insp-foot{display:flex;flex-direction:column;gap:6px;border-top:1px solid rgba(255,255,255,.14);' +
        'padding-top:8px;}' +
        '.comet-insp-foot-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
        '.comet-insp-count{font-size:11px;color:#9aa0a6;}' +
        '.comet-insp-reset-all{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8eaed;' +
        'cursor:pointer;font:11px system-ui;padding:3px 8px;border-radius:4px;}' +
        '.comet-insp-reset-all:hover{border-color:#ff5252;color:#ff5252;}' +
        '.comet-insp-send{align-self:flex-end;}';
    }
    style.textContent = css;
    shadow.appendChild(style);
  }

  /* ---------------- wiring ---------------- */
  function onWindowResize() {
    resizeCanvas();
    repositionAll();
    if (state.position) applyPosition(state.position.x, state.position.y); // re-clamp
  }

  function bindEvents() {
    toolbar.addEventListener('click', onToolbarClick);
    toolbar.addEventListener('change', onToolbarChange);
    dragHandle.addEventListener('pointerdown', startDrag);
    dragHandle.addEventListener('pointermove', onDragMove);
    dragHandle.addEventListener('pointerup', endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);
    chipEl.addEventListener('pointerdown', startDrag);
    chipEl.addEventListener('pointermove', onDragMove);
    chipEl.addEventListener('pointerup', endDrag);
    chipEl.addEventListener('pointercancel', endDrag);
    chipEl.addEventListener('click', onChipClick);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke); // spec: handle pointercancel
    chatCard.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-chat]') : null;
      if (!b) return;
      if (b.dataset.chat === 'add') addChat();
      else if (b.dataset.chat === 'cancel') cancelChat();
    });
    chatInput.addEventListener('input', () => {
      if (pending && pending.descriptor) pending.descriptor.instruction = chatInput.value;
      if (inspInput) inspInput.value = chatInput.value;
    });
    inspRows.addEventListener('input', onInspectorInput);
    inspRows.addEventListener('change', onInspectorInput);
    inspRows.addEventListener('click', onInspectorFormatClick);
    inspRows.addEventListener('click', onInspectorReset);
    inspRows.addEventListener('pointerover', onInspectorPointerOver);
    inspRows.addEventListener('focusin', onInspectorFocusIn);
    inspRows.addEventListener('pointerout', onInspectorPointerLeave);
    inspRows.addEventListener('focusout', onInspectorFocusOut);
    if (inspResetAllBtn) inspResetAllBtn.addEventListener('click', onInspectorResetAll);
    if (inspSelectionList) inspSelectionList.addEventListener('click', onSelectionListClick);
    inspInput.addEventListener('input', onInspectorInstr);
    inspSend.addEventListener('click', () => send(inspSend));
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('click', onPageClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', repositionAll, true); // incl. inner scrollers
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);
    if (!messagesBound) {
      messagesBound = true;
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    }
  }

  /* ---------------- init ---------------- */
  async function init() {
    try {
      updateMotionPreference();
      // The message listener must survive exit so the popup can re-enable us.
      if (!messagesBound) {
        messagesBound = true;
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
      }
      // Learn the real tab id BEFORE reading per-tab state: the storage key
      // is browserlink:<tabId>, and fullExit saves under the real id. Without
      // this, a refresh reads browserlink:unknown and reopens a closed tool.
      await pingTabId();
      let saved = null;
      try {
        saved = await chrome.storage.session.get(tabStorageKey());
      } catch (_) { saved = null; }
      const st = saved && saved[tabStorageKey()] ? saved[tabStorageKey()] : null;
      // The popup master switch (storage.local) is the authoritative on/off
      // flag: it survives refreshes without depending on the SW tab-id ping
      // (which can race on a fresh page load). The per-tab session state is
      // kept as a fallback for state saved before this check existed.
      let masterEnabled = true;
      try {
        const got = await chrome.storage.local.get('toolEnabled');
        if (got && typeof got.toolEnabled === 'boolean') masterEnabled = got.toolEnabled;
      } catch (_) { /* storage unavailable */ }
      if (masterEnabled === false || (st && st.enabled === false)) {
        // Deactivation persists: stay off until the popup re-enables.
        saveTabState({ enabled: false });
        return;
      }
      buildUI();
      bindEvents();
      injectShadowStyles();
      restoreTabState(st);
    } catch (err) {
      // Never break the host page.
      try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (_) { /* ok */ }
      window.__hermesAnnotateInjected = false;
      window.__browserlinkInjected = false;
      console.error('Browserlink init failed:', err);
    }
  }

  // Test/harness hooks (no-op unless window.__BL_TEST__ is set before inject).
  if (typeof window !== 'undefined' && window.__BL_TEST__) {
    window.__BL_INSPECTOR__ = {
      openInspector,
      closeInspector,
      renderInspector,
      applyLive,
      applyLiveText,
      recordEdit,
      restoreProp,
      onInspectorFormatClick,
      onInspectorInput,
      syncFormatToolbar,
      setPropertyHint,
      clearPropertyHint,
      drawPropertyHint,
      get hintProp() { return hintProp; },
      get inspector() { return inspector; },
      get originals() { return inspectorOriginals; },
      getRows: () => inspRows,
      getCtx: () => ctx,
      toggleCatCollapse,
      propCategory,
      isEditorInternalTarget,
    };
    window.__BL_TEST_API__ = {
      get state() { return state; },
      get reducedMotion() { return reducedMotion; },
      get activeElement() { return inspector.el; },
      get hoverBoxEl() { return hoverBoxEl; },
      get hlEl() { return hlEl; },
      onPageClick,
      onMouseMove,
      positionHover,
      setElementMode,
      removeSelectionAt,
      computeCaptureRect,
      send,
      updateMotionPreference,
    };
  }

  init();
})();
