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
  const rafPending = { v: false };

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
    try {
      chrome.runtime.sendMessage({ type: 'browserlinkGetTabId' }, (resp) => {
        if (chrome.runtime.lastError) return; // background does not answer
        if (resp && resp.ok && resp.tabId) rememberTabId(resp.tabId);
      });
    } catch (_) { /* no background */ }
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
    if (on === state.collapsed) return;
    state.collapsed = on;
    toolbar.style.display = on ? 'none' : '';
    if (chipEl) chipEl.style.display = on ? '' : 'none';
    if (on) closeInspector();
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

  function updateCount() {
    if (!countEl) return;
    const n = state.elements.length;
    countEl.textContent = n === 1 ? '1 element' : n + ' elements';
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
    // (positioned from getBoundingClientRect) — not on this canvas.
    // v1.2: property-affect hint overlays the strokes while a row is active.
    drawPropertyHint();
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

  function positionHover() {
    if (!hlEl) return;
    if (!state.elementMode || !hoveredEl) {
      hlEl.style.display = 'none';
      return;
    }
    let r = null;
    try { r = hoveredEl.getBoundingClientRect(); } catch (_) { r = null; }
    placeRect(hlEl, r);
    if (hlEl.style.display !== 'none') hlChip.textContent = chipFromEl(hoveredEl);
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
    hoverLoopRaf = requestAnimationFrame(hoverTick);
  }

  function stopHoverLoop() {
    if (hoverLoopRaf) {
      cancelAnimationFrame(hoverLoopRaf);
      hoverLoopRaf = 0;
    }
    if (hlEl) hlEl.style.display = 'none';
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
    return o;
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
    } else {
      outlineEl = createOutline(descriptor.index);
    }
    pending = { descriptor, el, isEdit, editIndex, outlineEl };
    chatHead.textContent = chipFromEl(el) + (isEdit ? ' — edit instruction' : '');
    chatInput.value = isEdit ? (state.elements[editIndex].descriptor.instruction || '') : '';
    chatCard.hidden = false;
    chatInput.focus();
    positionSelections();
    // v1.1: inspector below the toolbar, bound to the committed descriptor
    // (edit mode re-click keeps the stored entry so edits accumulate).
    const inspDesc = isEdit ? state.elements[editIndex].descriptor : descriptor;
    openInspector(el, inspDesc);
    if (inspInput) inspInput.value = inspDesc.instruction || '';
  }

  function addChat() {
    if (!pending) return;
    const instr = chatInput.value.trim().slice(0, MAX_INSTR);
    if (pending.isEdit) {
      state.elements[pending.editIndex].descriptor.instruction = instr;
    } else {
      pending.descriptor.instruction = instr;
      state.elements.push({
        descriptor: pending.descriptor,
        el: pending.el,
        outlineEl: pending.outlineEl,
      });
    }
    pending = null;
    chatInput.value = '';
    if (inspInput) inspInput.value = '';
    chatInput.focus(); // stays open for the next element
    updateCount();
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
    if (existingIdx !== -1) {
      openChat(d, el, true, existingIdx); // edit mode, pre-filled
      return;
    }
    if (pending && pending.descriptor.cssPath === d.cssPath) {
      chatInput.focus(); // same pending element -> just refocus
      return;
    }
    d.index = state.nextIndex++;
    openChat(d, el, false, -1);
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

  function stylePropName(prop) {
    return prop; // camelCase matches CSSStyleDeclaration
  }

  function readInlineStyle(el, prop) {
    try {
      if (prop === 'text') return el.textContent || '';
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
    let text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    out.push({ prop: 'text', kind: 'text', current: text, value: text, max: MAX_TEXT });
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
        value = (editVal != null) ? String(p.value || '') : (el.textContent || '');
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
    if (inspector.descriptor) originalsByDesc.set(inspector.descriptor, inspectorOriginals);
  }

  function applyLive(prop, value) {
    const el = inspector.el;
    if (!el) return;
    if (prop === 'text') {
      el.textContent = value;
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
      el.textContent = orig.value;
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

    // text / href
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
    for (const p of inspectorProps(el)) {
      const row = document.createElement('div');
      row.className = 'comet-insp-row';
      row.dataset.prop = p.prop;
      row.tabIndex = -1;

      const lab = document.createElement('span');
      lab.className = 'comet-insp-label';
      lab.textContent = p.prop;
      lab.title = p.prop;

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

      row.appendChild(lab);
      row.appendChild(control);
      row.appendChild(rst);
      inspRows.appendChild(row);
    }
    updateInspectorState();
  }

  // Accent-marks edited rows and refreshes the "N edits" footer count.
  function updateInspectorState() {
    if (!inspPanel) return;
    const edits = currentEdits();
    let n = 0;
    inspRows.querySelectorAll('.comet-insp-row').forEach((row) => {
      const v = edits[row.dataset.prop];
      const nonEmpty = v !== undefined && v !== null && String(v).trim() !== '';
      row.classList.toggle('edited', nonEmpty);
      if (nonEmpty) n++;
    });
    inspCountEl.textContent = n === 1 ? '1 edit' : n + ' edits';
  }

  function openInspector(el, descriptor) {
    clearPropertyHint();
    inspector.el = el;
    inspector.descriptor = descriptor;
    captureOriginals(el);
    renderInspector();
    inspPanel.hidden = false;
    positionInspector();
  }

  function closeInspector() {
    clearPropertyHint();
    inspector.el = null;
    inspector.descriptor = null;
    inspectorOriginals = new Map();
    if (inspPanel) inspPanel.hidden = true;
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
      if (valEl) valEl.textContent = v;
    }
    applyLive(prop, v);
    recordEdit(prop, v);
    if (hintProp === prop) scheduleRedraw();
  }

  // Per-row Reset: restore original style/text and drop the stored edit.
  function onInspectorReset(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-insp-reset]') : null;
    if (!btn) return;
    const row = btn.closest('.comet-insp-row');
    if (!row) return;
    const prop = row.dataset.prop;
    restoreProp(prop);
    syncRowControl(row, prop);
    updateInspectorState();
    if (hintProp === prop) scheduleRedraw();
  }

  function onInspectorResetAll() {
    if (!inspector.el) return;
    const props = Array.from(inspectorOriginals.keys());
    for (const prop of props) restoreProp(prop);
    inspRows.querySelectorAll('.comet-insp-row').forEach((row) => {
      syncRowControl(row, row.dataset.prop);
    });
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

  function drawPropertyHint() {
    if (!ctx || !hintProp || !inspector.el) return;
    const el = inspector.el;
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
    inspector.descriptor.instruction = e.target.value;
    if (chatInput) chatInput.value = e.target.value;
  }

  /* ---------------- toolbar ---------------- */
  function applyMode() {
    canvas.style.pointerEvents = state.annotateOn ? 'all' : 'none';
    canvas.classList.toggle('active', state.annotateOn || state.elementMode);
    toolbar.querySelector('[data-act="annotate"]').classList.toggle('active', state.annotateOn);
    toolbar.querySelector('[data-act="element"]').classList.toggle('active', state.elementMode);
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
    state.elements = [];
    state.nextIndex = 1;
    while (selLayer.firstChild) selLayer.removeChild(selLayer.firstChild); // all markers
    pending = null;
    if (chatCard) chatCard.hidden = true;
    closeInspector();
    updateCount();
    redraw();
  }

  async function send() {
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
      // v1.1: elements carry "edits" ({property: desiredValue}, non-empty only).
      elements: state.elements.map((en) => {
        const d = Object.assign({}, en.descriptor);
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
      }),
    };
    setStatus('sending…', '');
    let ok = false;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'annotate', payload });
      ok = !!(resp && resp.ok);
    } catch (_) { ok = false; }
    if (ok) {
      setStatus(BRIDGE_OK, 'ok');
      state.strokes = [];   // clear strokes, elements and all markers on success
      state.elements = [];
      state.nextIndex = 1;
      while (selLayer.firstChild) selLayer.removeChild(selLayer.firstChild);
      pending = null;
      if (chatCard) chatCard.hidden = true;
      closeInspector();
      updateCount();
      redraw();
    } else {
      setStatus(BRIDGE_OFFLINE, 'err');
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
      case 'send': send(); break;
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

  /* ---------------- activation / deactivation ---------------- */
  // Full exit: remove the shadow host + overlay from the DOM, close the chat
  // card and inspector, cancel pointer capture, leave the page 100% clean,
  // and persist per-tab {enabled:false}.
  function fullExit() {
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
    pending = null;
    closeInspector();
    stopHoverLoop();
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

    // Remove the shadow host from the DOM (removes toolbar, canvas, chat
    // card, inspector, chip — every node we added).
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
    chatCard = null;
    chatHead = null;
    chatInput = null;
    chipEl = null;
    dragHandle = null;
    inspPanel = null;
    inspRows = null;
    inspCountEl = null;
    inspResetAllBtn = null;
    inspInput = null;
    inspSend = null;
    inspectorOriginals = new Map();
    hintProp = null;
    stopHintLoop();
    state.strokes = [];
    state.elements = [];
    state.nextIndex = 1;
    // UI state is gone with the DOM; rebuild from chrome.storage.session on
    // reinject (setCollapsed early-returns when the value is unchanged, so
    // the collapsed/position state must be reset here).
    state.collapsed = false;
    state.position = null;
    window.__hermesAnnotateInjected = false;
    window.__browserlinkInjected = false;
    saveTabState({ enabled: false }); // deactivation persists per tab
  }

  // Idempotent re-injection (popup master switch ON / browserlinkToggle true).
  function reinject() {
    if (host && host.parentNode) return; // already active
    try {
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
      '<button type="button" data-act="annotate" class="comet-btn" title="Toggle drawing">Annotate</button>' +
      '<button type="button" data-act="element" class="comet-btn" title="Element picker: hover to highlight, click to select + instruct">Element</button>' +
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

    shadow.appendChild(toolbar);
    shadow.appendChild(chipEl);
    shadow.appendChild(selLayer);
    selLayer.appendChild(hlEl);
    shadow.appendChild(canvas);
    shadow.appendChild(chatCard);
    shadow.appendChild(inspPanel);
    ctx = canvas.getContext('2d');

    // ONE shadow host on the page; nothing else touches the page DOM.
    document.documentElement.appendChild(host);

    statusEl = toolbar.querySelector('.status');
    countEl = toolbar.querySelector('.comet-count');
    chatHead = chatCard.querySelector('.comet-chat-head');
    chatInput = chatCard.querySelector('.comet-chat-input');
    inspRows = inspPanel.querySelector('.comet-insp-rows');
    inspCountEl = inspPanel.querySelector('.comet-insp-count');
    inspResetAllBtn = inspPanel.querySelector('.comet-insp-reset-all');
    inspInput = inspPanel.querySelector('.comet-insp-instr');
    inspSend = inspPanel.querySelector('.comet-insp-send');
    toolbar.querySelector('.comet-swatch .dot').classList.add('active');
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
    inspRows.addEventListener('click', onInspectorReset);
    inspRows.addEventListener('pointerover', onInspectorPointerOver);
    inspRows.addEventListener('focusin', onInspectorFocusIn);
    inspRows.addEventListener('pointerout', onInspectorPointerLeave);
    inspRows.addEventListener('focusout', onInspectorFocusOut);
    if (inspResetAllBtn) inspResetAllBtn.addEventListener('click', onInspectorResetAll);
    inspInput.addEventListener('input', onInspectorInstr);
    inspSend.addEventListener('click', send);
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
      // The message listener must survive exit so the popup can re-enable us.
      if (!messagesBound) {
        messagesBound = true;
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
      }
      pingTabId();
      let saved = null;
      try {
        saved = await chrome.storage.session.get(tabStorageKey());
      } catch (_) { saved = null; }
      const st = saved && saved[tabStorageKey()] ? saved[tabStorageKey()] : null;
      if (st && st.enabled === false) {
        // Deactivation persists per tab: stay off until the popup re-enables.
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
      recordEdit,
      restoreProp,
      setPropertyHint,
      clearPropertyHint,
      drawPropertyHint,
      get hintProp() { return hintProp; },
      get inspector() { return inspector; },
      get originals() { return inspectorOriginals; },
      getRows: () => inspRows,
      getCtx: () => ctx,
    };
  }

  init();
})();
