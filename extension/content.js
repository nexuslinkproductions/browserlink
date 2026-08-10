/* Browserlink — Browser Annotate & Connect — content script (MV3). SPEC v2.1.
 *
 * Attaches ONE closed ShadowRoot to document.documentElement containing:
 *   - a floating top-right toolbar [Annotate | Element | color swatch |
 *     width 2/4/8 | N elements | Undo | Clear | Send | status]
 *   - an overlay <canvas> (position fixed, inset 0, z-index 2147483646)
 *   - an element-picker layer (fixed inset 0, pointer-events none) holding
 *     the hover highlight + "tag#id.class" chip and the persistent selection
 *     outlines + numbered badges
 *   - an instruction chat card (bottom-right of the viewport)
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
 *               outline + numbered badge (1..N) and opens the instruction chat
 *               card. Add appends {index, tag, id, className, text, href,
 *               ariaLabel, cssPath, rect, instruction} (instruction trimmed,
 *               cap 500) and keeps the card open for the next element; Enter
 *               adds, Esc cancels/closes; re-click on an already-selected
 *               element (cssPath match) pre-fills the card (edit mode).
 *               Toolbar chip "N elements" + Clear clears all selections.
 *               While the picker is active, page clicks are swallowed
 *               (preventDefault + stopPropagation) so links/buttons don't
 *               fire.
 *
 * Send -> chrome.runtime.sendMessage({type:"annotate", payload}) with the
 * spec payload {source, url, title, viewport, label, strokes, elements};
 * status shows "sent ✓" or "bridge offline"; strokes, elements and all
 * markers are cleared only after a successful send.
 *
 * The page DOM is NEVER touched beyond appending the shadow host.
 */
'use strict';

(() => {
  if (window.__hermesAnnotateInjected) return; // guard duplicate injection
  window.__hermesAnnotateInjected = true;

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
  };

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
  const rafPending = { v: false };

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
  }

  /* ---------------- drawing (Annotate mode, v2, untouched) ---------------- */
  function pointerDown(e) {
    if (!state.annotateOn || state.elementMode) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
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
      // Leaving picker mode: drop the pending selection + close the card.
      if (pending && !pending.isEdit && pending.outlineEl && pending.outlineEl.parentNode) {
        pending.outlineEl.parentNode.removeChild(pending.outlineEl);
      }
      pending = null;
      if (chatCard) chatCard.hidden = true;
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
      elements: state.elements.map((en) => en.descriptor), // includes instruction
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
      default: break;
    }
  }

  function onToolbarChange(e) {
    if (e.target && e.target.dataset && e.target.dataset.act === 'width') {
      const v = parseInt(e.target.value, 10);
      if (WIDTHS.indexOf(v) !== -1) state.width = v;
    }
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
      '<span class="status"></span>';

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

    shadow.appendChild(toolbar);
    shadow.appendChild(selLayer);
    selLayer.appendChild(hlEl);
    shadow.appendChild(canvas);
    shadow.appendChild(chatCard);
    ctx = canvas.getContext('2d');

    // ONE shadow host on the page; nothing else touches the page DOM.
    document.documentElement.appendChild(host);

    statusEl = toolbar.querySelector('.status');
    countEl = toolbar.querySelector('.comet-count');
    chatHead = chatCard.querySelector('.comet-chat-head');
    chatInput = chatCard.querySelector('.comet-chat-input');
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
        '.comet-count{min-width:64px;text-align:center;font-size:12px;color:#9aa0a6;white-space:nowrap;}';
    }
    style.textContent = css;
    shadow.appendChild(style);
  }

  /* ---------------- wiring ---------------- */
  function bindEvents() {
    toolbar.addEventListener('click', onToolbarClick);
    toolbar.addEventListener('change', onToolbarChange);
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
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('click', onPageClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', repositionAll, true); // incl. inner scrollers
    window.addEventListener('resize', () => { resizeCanvas(); repositionAll(); });
    window.addEventListener('orientationchange', () => { resizeCanvas(); repositionAll(); });
  }

  /* ---------------- init ---------------- */
  function init() {
    try {
      buildUI();
      bindEvents();
      injectShadowStyles();
    } catch (err) {
      // Never break the host page.
      try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (_) { /* ok */ }
      window.__hermesAnnotateInjected = false;
      console.error('Browserlink init failed:', err);
    }
  }

  init();
})();
