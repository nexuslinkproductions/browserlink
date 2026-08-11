/* Browserlink - Browser Annotate & Connect - content script (MV3). SPEC v1.2.
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
 *     "N edits" + Reset all + the instruction textarea. Notes queue into
 *     state.elements (Enter/Add); the toolbar Send is the only sender.
 *     Selection rows show a muted note preview when an instruction is set.
 *     Send payload elements gain "edits": {property: desiredValue}
 *     (non-empty edits only). The panel closes on deselection, mode switch
 *     to Annotate, and exit/power.
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
 * status shows "bridge offline" on failure; success clears the status (the
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
  const DOCK_EDGE_PX = 64;         // proximity threshold for toolbar edge docking
  // Edge inset for a docked toolbar/chip (clamped 10-25px per design spec).
  const DOCK_GAP_PX = Math.min(25, Math.max(10, 14));

  /* ---------------- state ---------------- */
  const state = {
    annotateOn: true,    // draw mode is the default selection on start
    elementMode: false,  // element pick mode (mutually exclusive with annotate)
    annotNote: '',       // legacy last committed note ('note' payload back-compat)
    annotNotes: [],      // committed annotation note queue (chat card note mode)
    color: COLORS[0],
    width: WIDTHS[1],
    strokes: [],         // [{color, width, points:[[nx,ny],...]}]
    elements: [],        // [{descriptor, el, outlineEl}]
    currentStroke: null, // in-progress stroke
    nextIndex: 1,        // selection numbering (1-based)
    capturedPointerId: null, // active canvas pointer capture (released on exit)
    collapsed: false,    // toolbar minimized to the 48px chip
    modeBeforeCollapse: null, // 'annotate'|'element'|null, restored when the chip expands
    position: null,      // {x, y} top-left of toolbar/chip (viewport px)
    toolbarDock: null,   // toolbar edge dock: 'left'|'right'|'bottom'|null (null = floating)
    activeIndex: -1,     // index in elements currently bound to the inspector
    collapsedCats: {},   // { Text: true, Layout: false, ... } inspector category collapse
    dock: null,          // inspector edge dock: 'left'|'top'|'right'|'bottom'|null (null = floating popup)
    inspSize: null,      // {w, h} inspector panel size from the corner resize handle
  };

  // Element inspector: {el, descriptor} - descriptor is the object that
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
  let noteCountEl = null; // toolbar chip: queued annotation notes count
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
  let inspDragHandle = null; // ⋮⋮ inspector header drag handle (floating mode only)
  let inspDockEl = null;     // 4-way dock control in the inspector header
  let inspDrag = null;       // active inspector drag {pointerId,startX,startY,baseX,baseY,moved}
  let inspRows = null;
  let inspCountEl = null;
  let inspInput = null;
  let inspAddEl = null;         // footer Add button (commits the pending element)
  let inspGlowEl = null;        // cursor glow layer inside the inspector
  let inspResizeHandle = null;  // bottom-right corner resize handle
  let inspResize = null;        // active inspector resize {pointerId,startX,startY,baseW,baseH}
  let inspSelectionCountEl = null;
  let inspSelectionList = null;
  let modeToggle = null;
  let modePill = null;
  let sentToastEl = null;
  let sentToastTimer = 0;
  let sendHideTimer = 0; // delayed Send-button collapse after a successful send
  const rafPending = { v: false };

  // Motion is deliberately centralized so reduced-motion also disables the
  // JavaScript loops (not only the CSS transitions in overlay.css).
  let reducedMotion = false;
  let motionMedia = null;
  let inspectorRingTween = null;
  let collapseTimer = 0;
  let exitTimer = 0;
  let hoverTargetRect = null;
  let hoverVisualRect = null;
  let hoverLerpRaf = 0;
  let selectionPulseRaf = 0;
  let selectionPulseStarted = 0;
  let lastSelectionCount = -1;

  /* ---------------- drag + per-tab persistence ---------------- */
  let drag = null;             // active toolbar/chip pointer drag
  let suppressChipClick = false; // chip click right after a drag = restore, not drag
  let lastDragPersist = 0;
  let toolbarDragRaf = 0;
  let toolbarDockLayoutToken = 0;
  let toolbarMorphTimeline = null;
  let toolbarMorphCleanup = null;
  let messagesBound = false;   // chrome.runtime.onMessage registered once

  /* ---------------- diagnostics (window.__browserlinkDiag) ----------------
   * Agnostic live diagnostics: a ring buffer of events, a lazy JSON snapshot,
   * console helpers, init health checks (D-1..D-6), and a Ctrl+Shift+D overlay
   * panel inside the shadow root. Nothing here depends on Hermes specifics and
   * nothing runs on the hot path; the dump builds lazily on demand. */
  const DIAG_RING_MAX = 50;
  const diagRing = [];
  let diagPanel = null;           // comet-diag overlay (inside the shadow root)
  let diagPanelOpen = false;
  let diagLastCaptureRect = null; // last send() capture rect, for the snapshot
  let diagErrorHandler = null;
  let diagRejectionHandler = null;
  let diagKeyHandler = null;

  function diagLog(code, msg, data) {
    const entry = { t: new Date().toISOString(), code: String(code), msg: String(msg) };
    if (data !== undefined) entry.data = data;
    diagRing.push(entry);
    if (diagRing.length > DIAG_RING_MAX) diagRing.splice(0, diagRing.length - DIAG_RING_MAX);
    return entry;
  }

  function diagClearLog() {
    diagRing.length = 0;
    return diagRing.length;
  }

  function diagHealthChecks() {
    return [
      { code: 'D-1', name: 'host attached', ok: !!(host && host.parentNode) },
      { code: 'D-2', name: 'shadow root', ok: !!(shadow && toolbar && toolbar.parentNode === shadow) },
      { code: 'D-3', name: 'canvas + 2d ctx', ok: !!(canvas && canvas.parentNode && ctx && typeof ctx.drawImage === 'function') },
      { code: 'D-4', name: 'refs (toolbar/chat/inspector)', ok: !!(toolbar && chatCard && inspPanel && selLayer && inspRows && inspInput) },
      { code: 'D-5', name: 'gsap loaded', ok: gsapReady === true },
      { code: 'D-6', name: 'runtime listener bound', ok: messagesBound === true },
    ];
  }

  // Run the health checks; optionally log each failure to the ring (init).
  function diagHealth(logFailures) {
    const checks = diagHealthChecks();
    let failed = 0;
    for (const c of checks) {
      if (!c.ok) {
        failed += 1;
        if (logFailures) diagLog(c.code, c.name + ' FAILED');
      }
    }
    return { ok: failed === 0, failed: failed, checks: checks };
  }

  function diagRectOf(el) {
    if (!el) return null;
    try {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: !el.hidden && (el.style ? el.style.display !== 'none' : true),
      };
    } catch (_) { return null; }
  }

  function diagVersion() {
    try {
      if (chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        const m = chrome.runtime.getManifest();
        if (m && m.version) return String(m.version);
      }
    } catch (_) { /* manifest unavailable */ }
    return 'unknown';
  }

  // Lazy JSON snapshot of tool state. Nothing is cached; callers pay the cost
  // only when they ask (diag(), dump(), or the overlay panel).
  function diagDump() {
    return {
      tool: 'browserlink',
      version: diagVersion(),
      ready: !!(host && host.parentNode),
      injected: !!window.__browserlinkInjected,
      gsapReady: gsapReady,
      reducedMotion: !!reducedMotion,
      dpr: Number(window.devicePixelRatio) || 1,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      mode: {
        annotateOn: state.annotateOn,
        elementMode: state.elementMode,
        collapsed: state.collapsed,
        toolbarDock: state.toolbarDock,
        inspectorDock: state.dock,
      },
      rects: {
        host: diagRectOf(host),
        toolbar: diagRectOf(toolbar),
        inspector: diagRectOf(inspPanel),
        chat: diagRectOf(chatCard),
      },
      elements: {
        count: state.elements.length,
        queue: state.elements.map((en) => ({
          selector: (en.descriptor && en.descriptor.cssPath) ? en.descriptor.cssPath : '',
          tag: (en.descriptor && en.descriptor.tag) ? en.descriptor.tag : '',
          instructionLen: (en.descriptor && en.descriptor.instruction) ? en.descriptor.instruction.length : 0,
        })),
      },
      annotNote: state.annotNote || '',
      annotNotes: state.annotNotes.length,
      strokes: state.strokes.length,
      captureRect: diagLastCaptureRect,
      canvasCtx: !!(canvas && ctx),
      messagesBound: messagesBound,
      health: diagHealth(false),
      log: diagRing.slice(),
    };
  }

  // Console print: JSON snapshot plus a compact log tail.
  function diagPrint() {
    const d = diagDump();
    console.log('[browserlink diag] snapshot');
    console.log(JSON.stringify(d, null, 2));
    console.log('[browserlink diag] health ' + (d.health.ok ? 'OK' : 'FAILED'));
    console.log('[browserlink diag] log tail (' + d.log.length + ' entries)');
    d.log.slice(-20).forEach((e) => {
      console.log('  ' + e.t + ' [' + e.code + '] ' + e.msg
        + (e.data ? ' ' + JSON.stringify(e.data) : ''));
    });
  }

  function diagCopyToClipboard() {
    try {
      const text = JSON.stringify(diagDump(), null, 2);
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).catch(() => { /* clipboard blocked */ });
      }
    } catch (_) { /* clipboard unavailable */ }
  }

  function diagRenderPanel() {
    if (!diagPanel) return;
    const body = diagPanel.querySelector('.comet-diag-body');
    if (body) body.textContent = JSON.stringify(diagDump(), null, 2);
  }

  function diagOpenPanel() {
    if (!diagPanel) return;
    diagPanel.hidden = false;
    diagPanelOpen = true;
    diagRenderPanel();
    const closeBtn = diagPanel.querySelector('.comet-diag-close');
    if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  }

  function diagClosePanel() {
    if (diagPanel) diagPanel.hidden = true;
    diagPanelOpen = false;
  }

  function diagTogglePanel() {
    if (diagPanelOpen) diagClosePanel();
    else diagOpenPanel();
  }

  // Ctrl+Shift+D toggles the overlay; Escape closes it. Capture phase so the
  // hotkey wins over page shortcuts while the panel is open.
  function onDiagKeyDown(e) {
    if (e.key === 'Escape' && diagPanelOpen) {
      e.preventDefault();
      e.stopPropagation();
      diagClosePanel();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      e.stopPropagation();
      diagTogglePanel();
    }
  }

  function diagAttach() {
    if (!diagErrorHandler) {
      diagErrorHandler = (ev) => {
        diagLog('error', (ev && ev.message) ? String(ev.message) : 'window error', {
          source: (ev && ev.filename) ? String(ev.filename) : '',
          line: (ev && ev.lineno != null) ? ev.lineno : null,
          col: (ev && ev.colno != null) ? ev.colno : null,
        });
      };
      window.addEventListener('error', diagErrorHandler);
    }
    if (!diagRejectionHandler) {
      diagRejectionHandler = (ev) => {
        const r = ev && ev.reason;
        diagLog('error', 'unhandledrejection: ' + ((r && r.message) ? r.message : String(r)));
      };
      window.addEventListener('unhandledrejection', diagRejectionHandler);
    }
    if (!diagKeyHandler) {
      diagKeyHandler = onDiagKeyDown;
      window.addEventListener('keydown', diagKeyHandler, true);
    }
  }

  function diagDetach() {
    if (diagErrorHandler) {
      window.removeEventListener('error', diagErrorHandler);
      diagErrorHandler = null;
    }
    if (diagRejectionHandler) {
      window.removeEventListener('unhandledrejection', diagRejectionHandler);
      diagRejectionHandler = null;
    }
    if (diagKeyHandler) {
      window.removeEventListener('keydown', diagKeyHandler, true);
      diagKeyHandler = null;
    }
    diagPanel = null;
    diagPanelOpen = false;
  }

  if (typeof window !== 'undefined') {
    window.__browserlinkDiag = {
      dump: diagDump,
      diag: diagPrint,
      clearLog: diagClearLog,
      health: () => diagHealth(true),
      log: (code, msg, data) => diagLog(code, msg, data),
      get ready() { return !!(host && host.parentNode); },
      get logEntries() { return diagRing.slice(); },
    };
  }

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

  /* ---------------- toolbar position / collapse / edge dock ---------------- */
  const TOOLBAR_DOCK_SIDES = ['left', 'right', 'bottom'];

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

  // Commit an unclamped position to both toolbar surfaces. Dragging updates
  // this only at frame boundaries, while normal placement clamps first.
  function writeToolbarPosition(x, y) {
    if (!toolbar) return;
    const p = { x, y };
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
  }

  function applyPosition(x, y) {
    const s = currentSurfaceSize();
    const p = clampPos(x, y, s.w, s.h);
    writeToolbarPosition(p.x, p.y);
  }

  function clearToolbarDockClasses() {
    if (!toolbar) return;
    TOOLBAR_DOCK_SIDES.forEach((side) => {
      toolbar.classList.remove('comet-dock-' + side);
    });
  }

  function applyToolbarDockClasses(side) {
    if (!toolbar) return;
    clearToolbarDockClasses();
    if (TOOLBAR_DOCK_SIDES.indexOf(side) !== -1) {
      toolbar.classList.add('comet-dock-' + side);
    }
  }

  function toolbarRenderedDock() {
    if (!toolbar) return null;
    for (let i = 0; i < TOOLBAR_DOCK_SIDES.length; i += 1) {
      const side = TOOLBAR_DOCK_SIDES[i];
      if (toolbar.classList.contains('comet-dock-' + side)) return side;
    }
    return null;
  }

  function toolbarIsVertical(side) {
    return side === 'left' || side === 'right';
  }

  // A dock class changes flex direction and therefore the measured box. Two
  // frames plus a forced layout read guarantee measurement of the settled CSS
  // shape, and the token prevents stale placement work from fighting a drag.
  function scheduleToolbarLayout(fn) {
    const token = ++toolbarDockLayoutToken;
    const run = () => {
      if (token !== toolbarDockLayoutToken || !toolbar) return;
      void toolbar.offsetHeight;
      fn();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      run();
    }
  }

  function snapshotToolbarMorph() {
    if (!toolbar || state.collapsed || toolbar.style.display === 'none') return null;
    const box = toolbar.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const children = Array.from(toolbar.children).map((el) => ({
      el,
      rect: el.getBoundingClientRect(),
    })).filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
    return { box, children };
  }

  // Centered edge pin for the current surface size (toolbar or chip).
  function dockedToolbarPosition(side) {
    const s = currentSurfaceSize();
    const w = s.w || (state.collapsed ? 48 : 320);
    const h = s.h || (state.collapsed ? 48 : 48);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (side === 'left') {
      return clampPos(DOCK_GAP_PX, Math.round((vh - h) / 2), w, h);
    }
    if (side === 'right') {
      return clampPos(vw - w - DOCK_GAP_PX, Math.round((vh - h) / 2), w, h);
    }
    if (side === 'bottom') {
      return clampPos(Math.round((vw - w) / 2), vh - h - DOCK_GAP_PX, w, h);
    }
    return state.position || defaultPosition();
  }

  // Pick a dock edge from the dragged surface's nearest edge, or null to stay
  // floating. Tests the surface EDGE (not its center) against DOCK_EDGE_PX so
  // the snap threshold is reachable even for the wide floating toolbar; a
  // center-based test could never trigger left/right docking once the toolbar
  // is wider than ~2x the threshold.
  function detectToolbarDock() {
    const s = currentSurfaceSize();
    const w = s.w || 1;
    const h = s.h || 1;
    const p = state.position || defaultPosition();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (p.x <= DOCK_EDGE_PX) return 'left';
    if (p.x + w >= vw - DOCK_EDGE_PX) return 'right';
    if (p.y + h >= vh - DOCK_EDGE_PX) return 'bottom';
    return null;
  }

  function animateToolbarDockTo(target, onDone) {
    const surface = state.collapsed && chipEl ? chipEl : toolbar;
    if (!surface) {
      if (typeof onDone === 'function') onDone();
      return;
    }
    const from = state.position || defaultPosition();
    // Keep the exact pointer-release position. The target was already clamped,
    // so clamping here would create a visible jump before the snap tween.
    writeToolbarPosition(from.x, from.y);
    if (isReducedMotion() || !gsapReady) {
      applyPosition(target.x, target.y);
      if (typeof onDone === 'function') onDone();
      return;
    }
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    surface.classList.add('comet-toolbar-motion');
    gsapKill(surface);
    gsapSet(surface, { x: 0, y: 0, scale: 1, opacity: 1 });
    gsapLib.to(surface, {
      x: dx,
      y: dy,
      scale: 1.03,
      duration: 0.18,
      ease: EASE.md3Emphasized,
      overwrite: true,
      onComplete: () => {
        writeToolbarPosition(target.x, target.y);
        gsapSet(surface, { x: 0, y: 0 });
        gsapLib.to(surface, {
          scale: 1,
          duration: 0.14,
          ease: EASE.spring,
          overwrite: true,
          onComplete: () => {
            gsapSet(surface, { clearProps: 'transform,scale,x,y' });
            surface.classList.remove('comet-toolbar-motion');
            if (typeof onDone === 'function') onDone();
          },
        });
      },
    });
  }

  function stopToolbarOrientationMorph() {
    const timeline = toolbarMorphTimeline;
    const cleanup = toolbarMorphCleanup;
    toolbarMorphTimeline = null;
    toolbarMorphCleanup = null;
    if (timeline) {
      try { timeline.kill(); } catch (_) { /* ok */ }
    }
    if (cleanup) cleanup(false);
  }

  // Manual nested FLIP. The toolbar transform maps the new row/column box
  // back onto the old box, while each child is counter-scaled and translated
  // to its old screen rect. GSAP then resolves both layers to the new layout.
  function animateToolbarOrientationMorph(snapshot, target, oldVertical, newVertical, onDone) {
    if (!toolbar || !snapshot) {
      applyPosition(target.x, target.y);
      if (typeof onDone === 'function') onDone();
      return;
    }

    writeToolbarPosition(target.x, target.y);
    void toolbar.offsetHeight;
    const finalBox = toolbar.getBoundingClientRect();
    const pairs = snapshot.children.map((entry) => ({
      el: entry.el,
      from: entry.rect,
      to: entry.el.getBoundingClientRect(),
    })).filter((entry) => entry.to.width > 0 && entry.to.height > 0);

    const finishInstant = () => {
      writeToolbarPosition(target.x, target.y);
      if (toolbar) toolbar.classList.remove('comet-toolbar-morphing', 'comet-toolbar-motion');
      if (typeof onDone === 'function') onDone();
    };
    if (isReducedMotion() || !gsapReady || !finalBox.width || !finalBox.height || !pairs.length) {
      finishInstant();
      return;
    }

    stopToolbarOrientationMorph();
    const scaleX = snapshot.box.width / finalBox.width;
    const scaleY = snapshot.box.height / finalBox.height;
    const translateX = snapshot.box.left - finalBox.left;
    const translateY = snapshot.box.top - finalBox.top;
    let finished = false;
    const cleanup = (notify) => {
      if (finished) return;
      finished = true;
      toolbarMorphTimeline = null;
      toolbarMorphCleanup = null;
      if (toolbar) {
        gsapSet(toolbar, { clearProps: 'transform,transformOrigin,scale,scaleX,scaleY,x,y,rotation' });
        toolbar.classList.remove('comet-toolbar-morphing', 'comet-toolbar-motion');
      }
      pairs.forEach((entry) => {
        gsapSet(entry.el, { clearProps: 'transform,transformOrigin,opacity,scale,scaleX,scaleY,x,y,rotation' });
      });
      writeToolbarPosition(target.x, target.y);
      applyMode({ instant: true });
      if (notify && typeof onDone === 'function') onDone();
    };
    toolbarMorphCleanup = cleanup;

    toolbar.classList.add('comet-toolbar-morphing', 'comet-toolbar-motion');
    gsapKill(toolbar);
    gsapSet(toolbar, {
      transformOrigin: '0 0',
      x: translateX,
      y: translateY,
      scaleX,
      scaleY,
    });

    pairs.forEach((entry) => {
      const oldLocalX = entry.from.left - snapshot.box.left;
      const oldLocalY = entry.from.top - snapshot.box.top;
      const newLocalX = entry.to.left - finalBox.left;
      const newLocalY = entry.to.top - finalBox.top;
      const childScaleX = (entry.from.width / (entry.to.width * scaleX)) * 0.96;
      const childScaleY = (entry.from.height / (entry.to.height * scaleY)) * 0.96;
      const vars = {
        transformOrigin: '0 0',
        x: (oldLocalX / scaleX) - newLocalX,
        y: (oldLocalY / scaleY) - newLocalY,
        scaleX: childScaleX,
        scaleY: childScaleY,
        opacity: 0.82,
      };
      if (entry.el === dragHandle) vars.rotation = oldVertical ? 90 : 0;
      gsapKill(entry.el);
      gsapSet(entry.el, vars);
    });

    toolbarMorphTimeline = gsapLib.timeline({
      onComplete: () => cleanup(true),
    });
    toolbarMorphTimeline.to(toolbar, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      duration: 0.32,
      ease: EASE.md3Emphasized,
    }, 0);
    toolbarMorphTimeline.to(pairs.map((entry) => entry.el), {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      duration: 0.16,
      ease: EASE.md3Emphasized,
      stagger: 0.022,
    }, 0.018);
    if (dragHandle) {
      toolbarMorphTimeline.to(dragHandle, {
        rotation: newVertical ? 90 : 0,
        duration: 0.28,
        ease: EASE.md3Emphasized,
      }, 0);
    }
  }

  // Snap / animate the main toolbar to an edge (or float). Persists toolbarDock.
  function setToolbarDock(side, opts) {
    const o = opts || {};
    const next = TOOLBAR_DOCK_SIDES.indexOf(side) !== -1 ? side : null;

    // Finish any prior layout work before reading the rendered orientation.
    toolbarDockLayoutToken += 1;
    stopToolbarOrientationMorph();
    const renderedBefore = toolbarRenderedDock();
    const oldVertical = toolbarIsVertical(renderedBefore);
    const newVertical = toolbarIsVertical(next);
    const desiredPosition = state.position
      ? { x: state.position.x, y: state.position.y }
      : null;
    const shouldMorph = !!o.animate && !state.collapsed && oldVertical !== newVertical;
    const morphSnapshot = shouldMorph ? snapshotToolbarMorph() : null;

    state.toolbarDock = next;
    diagLog('dock', 'toolbar=' + (next || 'float'));
    applyToolbarDockClasses(next);
    applyMode({ instant: true });

    const finishPlacement = () => {
      if (toolbar) toolbar.style.visibility = '';
      if (chipEl) chipEl.style.visibility = '';
      if (o.persist !== false) {
        saveTabState({ toolbarDock: next, position: state.position });
      }
      if (typeof o.onComplete === 'function') o.onComplete();
    };

    const place = () => {
      if (!toolbar || state.toolbarDock !== next) return;
      void toolbar.offsetHeight;
      const size = currentSurfaceSize();
      let target;
      if (next) {
        target = dockedToolbarPosition(next);
      } else {
        const desired = desiredPosition || defaultPosition();
        target = clampPos(desired.x, desired.y, size.w, size.h);
      }

      if (morphSnapshot) {
        animateToolbarOrientationMorph(
          morphSnapshot,
          target,
          oldVertical,
          newVertical,
          finishPlacement
        );
        return;
      }

      const from = state.position || target;
      const moved = Math.abs(target.x - from.x) > 0.5 || Math.abs(target.y - from.y) > 0.5;
      if (o.animate && moved) {
        animateToolbarDockTo(target, finishPlacement);
      } else {
        applyPosition(target.x, target.y);
        finishPlacement();
      }
    };

    // Runtime orientation FLIP must be inverted before this event can paint.
    // Non-morph placement uses two frames so first-run centering measures the
    // fully styled row/column dimensions rather than the pre-class box.
    if (morphSnapshot) {
      void toolbar.offsetHeight;
      place();
    } else {
      scheduleToolbarLayout(place);
    }
  }

  function clearToolbarFoldProps() {
    if (!toolbar) return;
    gsapKill(toolbar);
    gsapSet(toolbar, {
      clearProps: 'transform,opacity,filter,scale,x,y,transformOrigin',
    });
    toolbar.style.pointerEvents = '';
    toolbar.classList.remove('is-collapsing', 'is-restoring', 'comet-fold-out');
  }

  // Fold origin near the power button (top-left of the bar in LTR layouts).
  function foldOriginTowardPower() {
    if (!toolbar) return '12px 50%';
    const powerBtn = toolbar.querySelector('[data-act="power"]');
    if (!powerBtn) return '12px 50%';
    const tb = toolbar.getBoundingClientRect();
    const pb = powerBtn.getBoundingClientRect();
    const ox = Math.round(pb.left + pb.width / 2 - tb.left);
    const oy = Math.round(pb.top + pb.height / 2 - tb.top);
    return ox + 'px ' + oy + 'px';
  }

  function setCollapsed(on) {
    if (!toolbar) return;
    if (on === state.collapsed && !collapseTimer && !toolbar.classList.contains('is-collapsing')
        && !toolbar.classList.contains('is-restoring')) return;
    const wasCollapsed = state.collapsed;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = 0;
    }
    clearToolbarFoldProps();
    if (on && !wasCollapsed) {
      state.modeBeforeCollapse = state.annotateOn ? 'annotate' : (state.elementMode ? 'element' : null);
      setAnnotate(false);
      setElementMode(false);
      if (chatCard) chatCard.hidden = true;
    }
    state.collapsed = on;
    if (!on && wasCollapsed) {
      const modeToRestore = state.modeBeforeCollapse;
      state.modeBeforeCollapse = null;
      if (modeToRestore === 'annotate') setAnnotate(true, { showCard: false });
      else if (modeToRestore === 'element') setElementMode(true);
      if (chatCard) chatCard.hidden = true;
    }
    const placeSurface = () => {
      if (state.toolbarDock) {
        const target = dockedToolbarPosition(state.toolbarDock);
        applyPosition(target.x, target.y);
      } else if (state.position) {
        applyPosition(state.position.x, state.position.y);
      } else {
        const d = defaultPosition();
        applyPosition(d.x, d.y);
      }
    };

    if (on) {
      closeInspector();
      if (isReducedMotion() || !gsapReady) {
        toolbar.style.display = 'none';
        if (chipEl) {
          chipEl.style.display = '';
          chipEl.classList.remove('is-chip-enter');
        }
        placeSurface();
      } else {
        toolbar.classList.add('is-collapsing');
        toolbar.style.pointerEvents = 'none';
        const origin = foldOriginTowardPower();
        gsapSet(toolbar, { transformOrigin: origin });
        // Premium fold: scale + translate toward power, fade, soft blur.
        gsapExit(toolbar, {
          duration: 0.26,
          ease: EASE.md3Accelerate,
          to: {
            opacity: 0,
            scale: 0.9,
            x: -10,
            y: -4,
            filter: 'blur(2px)',
          },
          onComplete: () => {
            toolbar.style.display = 'none';
            toolbar.style.pointerEvents = '';
            toolbar.classList.remove('is-collapsing');
            gsapSet(toolbar, {
              clearProps: 'transform,opacity,filter,scale,x,y,transformOrigin',
            });
            if (chipEl) {
              chipEl.style.display = '';
              chipEl.classList.add('is-chip-enter');
              gsapSpring(chipEl, {
                duration: 0.24,
                from: { opacity: 0, scale: 0.82, y: 4 },
                to: { opacity: 1, scale: 1, y: 0 },
                onComplete: () => {
                  if (chipEl) chipEl.classList.remove('is-chip-enter');
                  gsapSet(chipEl, { clearProps: 'transform,opacity,scale,x,y' });
                },
              });
            }
            placeSurface();
            collapseTimer = 0;
          },
        });
        // Safety: if GSAP stalls, still hide after the fold window.
        collapseTimer = setTimeout(() => {
          if (!toolbar || !state.collapsed) return;
          if (toolbar.style.display === 'none') return;
          toolbar.style.display = 'none';
          toolbar.style.pointerEvents = '';
          toolbar.classList.remove('is-collapsing');
          clearToolbarFoldProps();
          if (chipEl) {
            chipEl.style.display = '';
            chipEl.classList.remove('is-chip-enter');
          }
          placeSurface();
          collapseTimer = 0;
        }, 420);
      }
    } else {
      if (isReducedMotion() || !gsapReady) {
        toolbar.style.display = '';
        if (chipEl) chipEl.style.display = 'none';
        placeSurface();
      } else {
        const hideChipThenFoldOut = () => {
          toolbar.style.display = '';
          toolbar.classList.add('is-restoring', 'comet-fold-out');
          placeSurface();
          const origin = foldOriginTowardPower();
          gsapSet(toolbar, {
            transformOrigin: origin,
            opacity: 0,
            scale: 0.9,
            x: -8,
            y: -3,
            filter: 'blur(2px)',
          });
          gsapEnter(toolbar, {
            duration: 0.28,
            ease: EASE.spring,
            from: {
              opacity: 0,
              scale: 0.9,
              x: -8,
              y: -3,
              filter: 'blur(2px)',
            },
            to: {
              opacity: 1,
              scale: 1,
              x: 0,
              y: 0,
              filter: 'blur(0px)',
            },
            onComplete: () => {
              toolbar.classList.remove('is-restoring', 'comet-fold-out');
              gsapSet(toolbar, {
                clearProps: 'transform,opacity,filter,scale,x,y,transformOrigin',
              });
              collapseTimer = 0;
            },
          });
          const kids = Array.prototype.slice.call(
            toolbar.querySelectorAll('.comet-btn, .comet-mode-toggle, .comet-swatch, .comet-width, .comet-count, .status, .comet-drag')
          );
          if (kids.length) {
            gsapStaggerIn(kids, {
              duration: 0.2,
              stagger: 0.025,
              delay: 0.04,
              from: { opacity: 0, y: 6, scale: 0.96 },
              to: { opacity: 1, y: 0, scale: 1 },
            });
          }
        };
        if (chipEl && chipEl.style.display !== 'none') {
          chipEl.classList.remove('is-chip-enter');
          gsapExit(chipEl, {
            duration: 0.16,
            ease: EASE.md3Accelerate,
            to: { opacity: 0, scale: 0.86, y: 3 },
            onComplete: () => {
              if (chipEl) {
                chipEl.style.display = 'none';
                gsapSet(chipEl, { clearProps: 'transform,opacity,scale,x,y' });
              }
              hideChipThenFoldOut();
            },
          });
        } else {
          if (chipEl) chipEl.style.display = 'none';
          hideChipThenFoldOut();
        }
        collapseTimer = setTimeout(() => {
          if (!toolbar || state.collapsed) return;
          toolbar.classList.remove('is-restoring', 'comet-fold-out');
          clearToolbarFoldProps();
          collapseTimer = 0;
        }, 480);
      }
    }
    placeSurface();
    saveTabState({ collapsed: on });
  }

  // ---- inspector placement: floating popup near the element, or docked ----
  // The inspector no longer hangs below the toolbar. When free it is a
  // floating popup near the selected element (draggable via the header
  // handle); when docked it snaps to a viewport edge with POS_PAD inset.
  const INSP_DIRS = ['left', 'top', 'right', 'bottom'];

  // Anchor side for the fold animations: dock edge when docked, else the
  // viewport side the selected element sits in (dominant axis wins).
  function inspDirection() {
    if (state.dock) return state.dock;
    const el = inspector.el;
    if (!el) return 'bottom';
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
    if (!r || !r.width || !r.height) return 'bottom';
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const dx = Math.abs(cx / window.innerWidth - 0.5);
    const dy = Math.abs(cy / window.innerHeight - 0.5);
    if (dx >= dy) return cx < window.innerWidth / 2 ? 'left' : 'right';
    return cy < window.innerHeight / 2 ? 'top' : 'bottom';
  }

  // Set the directional class (comet-insp-from-*) that picks the fold origin.
  function setInspDirection(dir) {
    if (!inspPanel) return;
    INSP_DIRS.forEach((d) => inspPanel.classList.remove('comet-insp-from-' + d));
    if (INSP_DIRS.indexOf(dir) !== -1) inspPanel.classList.add('comet-insp-from-' + dir);
    inspPanel.dataset.inspDir = dir || '';
  }

  // Dock to a viewport edge: POS_PAD inset, centered on the other axis via
  // measured offsets (no transform centering - transforms belong to the fold
  // animations, and a transform on the panel would fight their keyframes).
  function applyDock() {
    if (!inspPanel || !state.dock) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const iw = inspPanel.offsetWidth || 320;
    const ih = inspPanel.offsetHeight || 0;
    const side = state.dock;
    inspPanel.style.left = 'auto';
    inspPanel.style.right = 'auto';
    inspPanel.style.top = 'auto';
    inspPanel.style.bottom = 'auto';
    if (side === 'left' || side === 'right') {
      inspPanel.style.top = Math.max(POS_PAD, Math.round((vh - ih) / 2)) + 'px';
      inspPanel.style[side] = POS_PAD + 'px';
    } else {
      inspPanel.style.left = Math.max(POS_PAD, Math.round((vw - iw) / 2)) + 'px';
      inspPanel.style[side] = POS_PAD + 'px';
    }
    inspPanel.classList.add('comet-insp-docked');
    INSP_DIRS.forEach((d) => inspPanel.classList.toggle('comet-insp-docked-' + d, d === side));
  }

  // Floating placement: sit beside the selected element (roomier side wins),
  // offset toward the viewport center so the popup never sits on top of the
  // element it describes, then clamp to the viewport. Not pinned to the
  // click point - the element rect is the anchor.
  function positionInspector() {
    if (!inspPanel || inspPanel.hidden) return;
    if (state.dock) { applyDock(); return; }
    inspPanel.classList.remove('comet-insp-docked');
    const el = inspector.el;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const iw = inspPanel.offsetWidth || 320;
    const ih = inspPanel.offsetHeight || 0;
    const pad = POS_PAD + 8; // breathing room around the element
    let r = null;
    if (el) { try { r = el.getBoundingClientRect(); } catch (_) { r = null; } }
    let left = Math.round((vw - iw) / 2);
    let top = Math.max(POS_PAD, Math.round((vh - ih) / 2));
    if (r && r.width > 1 && r.height > 1) {
      const roomR = vw - (r.right + pad);
      const roomL = r.left - pad;
      const roomB = vh - (r.bottom + pad);
      const roomT = r.top - pad;
      const useHoriz = Math.max(roomR, roomL) >= Math.min(iw, vw * 0.55)
        || Math.max(roomT, roomB) < ih * 0.8;
      if (useHoriz) {
        left = roomR >= roomL ? r.right + pad : r.left - pad - iw;
        top = r.top + (r.height - ih) / 2;
      } else {
        top = roomB >= roomT ? r.bottom + pad : r.top - pad - ih;
        left = r.left + (r.width - iw) / 2;
      }
      // Nudge toward the viewport center so a near-center element is never
      // fully covered by its own popup.
      const cxp = Math.max(0, Math.min(1, (left + iw / 2) / vw));
      const cyp = Math.max(0, Math.min(1, (top + ih / 2) / vh));
      left += (0.5 - cxp) * iw * 0.25;
      top += (0.5 - cyp) * ih * 0.25;
    }
    left = Math.round(Math.min(Math.max(left, POS_PAD), Math.max(POS_PAD, vw - iw - POS_PAD)));
    top = Math.round(Math.min(Math.max(top, POS_PAD), Math.max(POS_PAD, vh - ih - POS_PAD)));
    inspPanel.style.left = left + 'px';
    inspPanel.style.top = top + 'px';
    inspPanel.style.right = 'auto';
    inspPanel.style.bottom = 'auto';
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

  // Document-level registration for the ring angle custom property. The
  // stylesheet lives inside a closed shadow root where @property rules do not
  // register reliably; CSS.registerProperty at document level makes the
  // keyframe fallback (comet-ring-spin) interpolate smoothly.
  function registerInspectorRingProperty() {
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') {
        CSS.registerProperty({
          name: '--bl-ring-angle',
          syntax: '<angle>',
          inherits: true,
          initialValue: '0deg',
        });
      }
    } catch (_) { /* already registered or unsupported */ }
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
          syncInspectorRingAnimation();
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

  /* ---------------- GSAP motion helpers (Premium / Apple-grade) ----------
   * GSAP + CustomEase are injected before this script (manifest content_scripts).
   * Helpers build fromTo/to tweens with signature easings. When
   * prefers-reduced-motion is on, helpers gsap.set final state and skip tweens.
   * CSS keyframes remain as fallbacks; GSAP inline styles win when active. */
  const gsapLib = (typeof window !== 'undefined' && window.gsap) ? window.gsap : null;
  const CustomEaseLib = (typeof window !== 'undefined' && window.CustomEase) ? window.CustomEase : null;
  let gsapReady = false;
  const EASE = {
    apple: 'power2.out',
    md3Emphasized: 'power3.out',
    md3Accelerate: 'power2.in',
    spring: 'back.out(1.4)',
    hig: 'power2.inOut',
  };
  if (gsapLib) {
    try {
      if (CustomEaseLib && typeof gsapLib.registerPlugin === 'function') {
        gsapLib.registerPlugin(CustomEaseLib);
      }
      if (CustomEaseLib && typeof CustomEaseLib.create === 'function') {
        EASE.apple = CustomEaseLib.create('blApple', '0.25,0.1,0.25,1');
        EASE.md3Emphasized = CustomEaseLib.create('blMd3Emphasized', '0.05,0.7,0.1,1');
        EASE.md3Accelerate = CustomEaseLib.create('blMd3Accelerate', '0.3,0,1,1');
        EASE.spring = CustomEaseLib.create('blSpring', '0.34,1.56,0.64,1');
        EASE.hig = CustomEaseLib.create('blHig', '0.25,0.1,0.25,1');
      }
      gsapReady = true;
    } catch (_) {
      gsapReady = !!gsapLib;
    }
  }

  function gsapKill(el) {
    if (gsapReady && el) gsapLib.killTweensOf(el);
  }

  function gsapSet(el, vars) {
    if (!el || !vars) return;
    if (gsapReady) gsapLib.set(el, vars);
    else {
      if (vars.opacity != null) el.style.opacity = String(vars.opacity);
      if (vars.x != null || vars.y != null || vars.scale != null || vars.scaleX != null || vars.scaleY != null) {
        const xv = vars.x;
        const yv = vars.y;
        const tx = xv != null ? 'translateX(' + (typeof xv === 'number' ? xv + 'px' : xv) + ')' : '';
        const ty = yv != null ? 'translateY(' + (typeof yv === 'number' ? yv + 'px' : yv) + ')' : '';
        const sx = vars.scaleX != null ? vars.scaleX : (vars.scale != null ? vars.scale : 1);
        const sy = vars.scaleY != null ? vars.scaleY : (vars.scale != null ? vars.scale : 1);
        const sc = (vars.scale != null || vars.scaleX != null || vars.scaleY != null)
          ? 'scale(' + sx + ',' + sy + ')' : '';
        el.style.transform = [tx, ty, sc].filter(Boolean).join(' ') || 'none';
      }
      if (vars.clearProps) {
        String(vars.clearProps).split(',').forEach((p) => {
          try { el.style.removeProperty(p.trim()); } catch (_) { /* ok */ }
        });
      }
    }
  }

  function stopInspectorRingTween() {
    if (!inspectorRingTween) return;
    try { inspectorRingTween.kill(); } catch (_) { /* ok */ }
    inspectorRingTween = null;
    if (inspPanel) inspPanel.classList.remove('comet-ring-js');
  }

  // GSAP is the primary angle driver: it tweens --bl-ring-angle on the panel
  // (reliable inside the closed shadow root). The comet-ring-js class tells
  // the CSS to skip its own keyframe spin so the two never fight. Without
  // GSAP (or under reduced motion) the CSS keyframe fallback takes over.
  function startInspectorRingTween() {
    stopInspectorRingTween();
    if (!inspPanel || inspPanel.hidden || isReducedMotion()) return;
    if (!gsapReady || typeof gsapLib === 'undefined') return;
    try {
      inspPanel.classList.add('comet-ring-js');
      inspectorRingTween = gsapLib.to(inspPanel, {
        '--bl-ring-angle': '360deg',
        duration: 9,
        repeat: -1,
        ease: 'none',
      });
    } catch (err) {
      diagLog('error', 'startInspectorRingTween failed: ' + (err && err.message ? err.message : String(err)));
      inspPanel.classList.remove('comet-ring-js');
    }
  }

  function syncInspectorRingAnimation() {
    try {
      if (!inspPanel || inspPanel.hidden) {
        stopInspectorRingTween();
        return;
      }
      startInspectorRingTween();
    } catch (err) {
      diagLog('error', 'syncInspectorRingAnimation failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // Entrance: ease-out / MD3 Emphasized. Reduced motion -> instant final state.
  function gsapEnter(el, opts) {
    if (!el) return null;
    const o = opts || {};
    const duration = (o.duration != null ? o.duration : 0.34);
    const ease = o.ease || EASE.md3Emphasized;
    const from = Object.assign({ opacity: 0, y: 10, scale: 0.96 }, o.from || {});
    const to = Object.assign({ opacity: 1, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1 }, o.to || {});
    gsapKill(el);
    if (isReducedMotion() || !gsapReady) {
      gsapSet(el, Object.assign({}, to, o.set || {}));
      if (typeof o.onComplete === 'function') o.onComplete();
      return null;
    }
    return gsapLib.fromTo(el, from, Object.assign({}, to, {
      duration,
      ease,
      delay: o.delay || 0,
      overwrite: true,
      onComplete: o.onComplete,
    }));
  }

  // Exit: 65-75% of entrance duration, ease-in / MD3 Accelerate.
  function gsapExit(el, opts) {
    if (!el) return null;
    const o = opts || {};
    const duration = (o.duration != null ? o.duration : 0.24);
    const ease = o.ease || EASE.md3Accelerate;
    const to = Object.assign({ opacity: 0, y: -8, scale: 0.96 }, o.to || {});
    gsapKill(el);
    if (isReducedMotion() || !gsapReady) {
      gsapSet(el, Object.assign({}, to, o.set || {}));
      if (typeof o.onComplete === 'function') o.onComplete();
      return null;
    }
    return gsapLib.to(el, Object.assign({}, to, {
      duration,
      ease,
      delay: o.delay || 0,
      overwrite: true,
      onComplete: o.onComplete,
    }));
  }

  // Spring pop (toast / success) with slight overshoot.
  function gsapSpring(el, opts) {
    if (!el) return null;
    const o = opts || {};
    const duration = (o.duration != null ? o.duration : 0.3);
    const ease = o.ease || EASE.spring;
    const from = Object.assign({ opacity: 0, scale: 0.85, y: -6 }, o.from || {});
    const to = Object.assign({ opacity: 1, scale: 1, y: 0 }, o.to || {});
    gsapKill(el);
    if (isReducedMotion() || !gsapReady) {
      gsapSet(el, Object.assign({}, to, o.set || {}));
      if (typeof o.onComplete === 'function') o.onComplete();
      return null;
    }
    return gsapLib.fromTo(el, from, Object.assign({}, to, {
      duration,
      ease,
      delay: o.delay || 0,
      overwrite: true,
      onComplete: o.onComplete,
    }));
  }

  function gsapStaggerIn(els, opts) {
    const list = Array.isArray(els) ? els.filter(Boolean) : [];
    if (!list.length) return null;
    const o = opts || {};
    const duration = (o.duration != null ? o.duration : 0.22);
    const stagger = (o.stagger != null ? o.stagger : 0.025);
    const ease = o.ease || EASE.md3Emphasized;
    const from = Object.assign({ opacity: 0, y: 8 }, o.from || {});
    const to = Object.assign({ opacity: 1, y: 0 }, o.to || {});
    list.forEach((el) => gsapKill(el));
    if (isReducedMotion() || !gsapReady) {
      list.forEach((el) => gsapSet(el, to));
      if (typeof o.onComplete === 'function') o.onComplete();
      return null;
    }
    return gsapLib.fromTo(list, from, Object.assign({}, to, {
      duration,
      ease,
      stagger,
      delay: o.delay || 0,
      overwrite: true,
      onComplete: o.onComplete,
    }));
  }

  // Inspector fold open: directional scale+translate+opacity, ~340ms, MD3
  // Emphasized with slight overshoot. Direction comes from comet-insp-from-*.
  function gsapInspectorOpen(el, dir) {
    if (!el) return null;
    const d = dir || 'bottom';
    const from = { opacity: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, filter: 'drop-shadow(0 0 0 rgba(74,158,255,0))' };
    if (d === 'left') { from.x = -26; from.scaleX = 0.3; from.scaleY = 0.92; }
    else if (d === 'right') { from.x = 26; from.scaleX = 0.3; from.scaleY = 0.92; }
    else if (d === 'top') { from.y = -26; from.scaleY = 0.3; from.scaleX = 0.92; }
    else { from.y = 26; from.scaleY = 0.3; from.scaleX = 0.92; }
    gsapKill(el);
    if (isReducedMotion() || !gsapReady) {
      gsapSet(el, { opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, clearProps: 'filter' });
      return null;
    }
    const tl = gsapLib.timeline({ overwrite: true });
    tl.fromTo(el, from, {
      opacity: 1,
      x: d === 'left' ? 4 : (d === 'right' ? -4 : 0),
      y: d === 'top' ? 4 : (d === 'bottom' ? -4 : 0),
      scaleX: d === 'left' || d === 'right' ? 1.04 : 1,
      scaleY: d === 'top' || d === 'bottom' ? 1.04 : 1,
      filter: 'drop-shadow(0 0 13px rgba(74,158,255,0.33))',
      duration: 0.2,
      ease: EASE.md3Emphasized,
    }).to(el, {
      x: 0, y: 0, scaleX: 1, scaleY: 1,
      filter: 'drop-shadow(0 0 0 rgba(74,158,255,0))',
      duration: 0.14,
      ease: EASE.apple,
      onComplete: () => { try { gsapLib.set(el, { clearProps: 'filter' }); } catch (_) { /* ok */ } },
    });
    return tl;
  }

  // Inspector fold close: reverse toward anchor, ~70% duration, ease-in.
  function gsapInspectorClose(el, dir, onComplete) {
    if (!el) return null;
    const d = dir || 'bottom';
    const to = { opacity: 0, x: 0, y: 0, scaleX: 1, scaleY: 1 };
    if (d === 'left') { to.x = -18; to.scaleX = 0.35; to.scaleY = 0.94; }
    else if (d === 'right') { to.x = 18; to.scaleX = 0.35; to.scaleY = 0.94; }
    else if (d === 'top') { to.y = -18; to.scaleY = 0.35; to.scaleX = 0.94; }
    else { to.y = 18; to.scaleY = 0.35; to.scaleX = 0.94; }
    return gsapExit(el, {
      duration: 0.24,
      ease: EASE.md3Accelerate,
      to,
      onComplete,
    });
  }

  // Top-center send confirmation toast: pops in (scale/fade), holds ~1.4s,
  // then slides up and vanishes. Independent of the toolbar/status slot.
  function showSentToast(text) {
    if (!sentToastEl) return;
    if (sentToastTimer) clearTimeout(sentToastTimer);
    gsapKill(sentToastEl);
    sentToastEl.textContent = text || 'Sent ✓';
    sentToastEl.hidden = false;
    sentToastEl.classList.remove('comet-sent-in', 'comet-sent-out');
    // Keep comet-sent-* classes for CSS compatibility; GSAP drives transform/opacity.
    sentToastEl.classList.add('comet-sent-in');
    const finishHide = () => {
      if (!sentToastEl) return;
      sentToastEl.hidden = true;
      sentToastEl.classList.remove('comet-sent-in', 'comet-sent-out');
      gsapSet(sentToastEl, { clearProps: 'opacity,transform,x,y,scale' });
    };
    if (isReducedMotion() || !gsapReady) {
      // Opacity only: the base rule already centers via translateX(-50%), and
      // the no-GSAP fallback cannot express xPercent (it would drop the
      // centering translate). Clear stale inline transforms from a prior toast.
      gsapSet(sentToastEl, { opacity: 1, clearProps: 'transform,x,y,scale' });
      sentToastTimer = setTimeout(() => {
        sentToastTimer = 0;
        finishHide();
      }, 1400);
      return;
    }
    // Pop in ~300ms spring, hold 1.4s, slide up + fade ~200ms.
    gsapSpring(sentToastEl, {
      duration: 0.3,
      from: { opacity: 0, xPercent: -50, y: -6, scale: 0.85 },
      to: { opacity: 1, xPercent: -50, y: 0, scale: 1 },
    });
    sentToastTimer = setTimeout(() => {
      sentToastTimer = 0;
      if (!sentToastEl) return;
      sentToastEl.classList.remove('comet-sent-in');
      sentToastEl.classList.add('comet-sent-out');
      gsapExit(sentToastEl, {
        duration: 0.2,
        ease: EASE.md3Accelerate,
        to: { opacity: 0, xPercent: -50, y: -12, scale: 1 },
        onComplete: finishHide,
      });
    }, 1400);
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
    if (ok) showSentToast('Sent ✓');
  }

  function updateCount() {
    if (!countEl) return;
    const n = state.elements.length;
    countEl.textContent = n === 1 ? '1 element' : n + ' elements';
    updateSelectionUI();
    showSendButton(); // elements exist again -> bring the Send button back
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
    showSendButton(); // new stroke -> Send button returns
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
  // html/body, never the extension's own shadow UI. Our UI lives in a CLOSED
  // shadow root, so host.contains() cannot see inside it (closed shadow
  // boundaries are opaque to light-tree traversal); getRootNode() returns the
  // ShadowRoot for our elements and document for page elements, which is the
  // reliable exclusion. If nothing meaningful is found in the walk, fall back
  // to the raw hit element (DevTools-style) so hover always works over plain
  // page content.
  function resolveMeaningful(hit) {
    if (!hit || hit.nodeType !== 1) return null;
    if (hit.getRootNode() !== document) return null; // inside our closed shadow root
    if (host && host.contains(hit)) return null;     // host itself / light-tree children
    let el = hit;
    for (let i = 0; i <= MAX_PARENT_WALK; i++) {
      if (!el || el.nodeType !== 1) break;           // walked off the tree
      if (el === document.documentElement || el === document.body) break; // never html/body
      if (hasMeaning(el)) return el;
      el = el.parentElement;
    }
    // No meaningful element within MAX_PARENT_WALK: fall back to the deepest
    // page element under the cursor (never html/body, never our own UI), so
    // hover always works over plain page content.
    if (hit === document.documentElement || hit === document.body) return null;
    return hit;
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

  // Hover chip label: tag#id chip plus the queue badge while element mode is
  // active and the hover box is showing. A hovered element that is already
  // committed shows its own queue number (E<n>); any other element shows the
  // total queued count, so the queue length is always visible while picking.
  function hoverChipLabel(el) {
    let label = chipFromEl(el);
    if (!state.elementMode || !state.elements.length) return label;
    const qi = state.elements.findIndex((en) => en.el === el);
    if (qi !== -1) {
      const en = state.elements[qi];
      const num = en.descriptor && en.descriptor.index != null ? en.descriptor.index : qi + 1;
      label += ' · E' + num;
    } else {
      label += ' · ' + state.elements.length + ' queued';
    }
    return label;
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
    // Must be an explicit visible value: stylesheet defaults to display:none,
    // so clearing the inline style (`''`) keeps the box hidden forever.
    hlEl.style.display = 'block';
    hlEl.style.left = box.left + 'px';
    hlEl.style.top = box.top + 'px';
    hlEl.style.width = box.width + 'px';
    hlEl.style.height = box.height + 'px';
  }

  // Stronger, unambiguous hover box (element mode only). Coexists with the
  // lerped hlEl; recomputed from live rect, invalidated on scroll/resize.
  function applyHoverOutlineBox(box) {
    if (!hoverBoxEl || !box) return;
    hoverBoxEl.style.display = 'block';
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
    if (mouse && pointOverUi(mouse.x, mouse.y)) {
      // Cursor over extension UI: never draw the red hover box, even when
      // hoveredEl is stale (panel opened or scrolled under the cursor
      // between ticks). Mirrors the hoverTick guard on every draw path.
      hideHoverOutlineBox();
      return;
    }
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

  // Hover highlight stays glued to the cursor/target: no laggy box lerp.
  // Optional subtle opacity fade-in on first show (~80ms) only.
  function startHoverLerp() {
    // Intentionally no-op: owner wants the hover box glued, not lagged.
    cancelHoverLerp();
  }

  function positionHover() {
    if (!hlEl) return;
    if (mouse && pointOverUi(mouse.x, mouse.y)) {
      // Cursor over extension UI: never draw the hover highlight here,
      // even if hoveredEl is stale (panel opened / scrolled under the
      // cursor between ticks, or a scroll/resize fired before the next
      // hoverTick). Mirrors the hoverTick guard on every draw path.
      cancelHoverLerp();
      hoverTargetRect = null;
      hoverVisualRect = null;
      if (gsapReady) gsapKill(hlEl);
      hlEl.style.opacity = '';
      hlEl.style.display = 'none';
      hideHoverOutlineBox();
      return;
    }
    if (!state.elementMode || !hoveredEl) {
      cancelHoverLerp();
      hoverTargetRect = null;
      hoverVisualRect = null;
      if (gsapReady) gsapKill(hlEl);
      hlEl.style.opacity = '';
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
      if (gsapReady) gsapKill(hlEl);
      hlEl.style.opacity = '';
      hlEl.style.display = 'none';
      hideHoverOutlineBox();
      return;
    }
    const firstShow = !hoverVisualRect;
    hoverTargetRect = target;
    hoverVisualRect = Object.assign({}, target);
    // Instant follow (glued): never animate left/top/width/height.
    applyHoverBox(hoverVisualRect);
    if (firstShow && !isReducedMotion() && gsapReady) {
      gsapLib.fromTo(hlEl, { opacity: 0 }, {
        opacity: 1,
        duration: 0.08,
        ease: EASE.apple,
        overwrite: 'auto',
      });
    }
    if (hlEl.style.display !== 'none') hlChip.textContent = hoverChipLabel(hoveredEl);
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
    // Keep Size & Position readout glued to the live element rect.
    updateInspectorMetrics();
    // Floating inspector follows its element on scroll; docked panels are
    // viewport-anchored and skip this.
    if (inspPanel && !inspPanel.hidden && !state.dock) positionInspector();
  }

  // Suppression guard for our own UI surfaces. The host element is
  // pointer-events:none, so elementFromPoint() over the inspector panel,
  // toolbar, chip, chat card or toast resolves the PAGE element BEHIND the
  // UI. When the cursor sits inside any visible UI rect, the hover highlight
  // must not draw (and clicks must not select) that page element. Hidden
  // surfaces (hidden attribute or display:none) report a zero-size rect and
  // are skipped, so only what the user can actually see suppresses hover.
  function pointOverUi(x, y) {
    const uiSurfaces = [inspPanel, toolbar, chatCard, chipEl, sentToastEl];
    for (let i = 0; i < uiSurfaces.length; i++) {
      const el = uiSurfaces[i];
      if (!el || el.hidden) continue;
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
      if (!r || r.width < 1 || r.height < 1) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  // rAF loop while element mode is active: re-resolve the hovered element
  // only when the mouse actually moved (elementFromPoint is rAF-throttled),
  // then keep highlight + selection outlines glued to their elements.
  function hoverTick() {
    if (!state.elementMode) {
      stopHoverLoop();
      return;
    }
    // Any throw in hit-testing / layout would otherwise kill the rAF loop
    // permanently; keep the loop alive and clear hover on failure.
    try {
      if (mouseDirty && mouse) {
        mouseDirty = false;
        if (pointOverUi(mouse.x, mouse.y)) {
          // Cursor is over one of our own surfaces (inspector, toolbar,
          // chip, chat card, toast): the host is pointer-events:none, so
          // elementFromPoint() would resolve the PAGE element behind the
          // UI. Never highlight the element behind our own panel. Both
          // hover boxes hide together (the outline box can otherwise stay
          // visible with display:block over the panel).
          hoveredEl = null;
          if (hlEl) {
            hlEl.style.opacity = '';
            hlEl.style.display = 'none';
          }
          if (hoverBoxEl) hoverBoxEl.style.display = 'none';
        } else {
          let hit = null;
          try { hit = document.elementFromPoint(mouse.x, mouse.y); } catch (_) { hit = null; }
          try { hoveredEl = resolveMeaningful(hit); } catch (_) { hoveredEl = null; }
        }
      }
      try { positionHover(); } catch (_) {
        if (hlEl) hlEl.style.display = 'none';
        hideHoverOutlineBox();
      }
      try { positionSelections(); } catch (_) { /* keep outlines sticky on next tick */ }
    } catch (_) {
      hoveredEl = null;
      if (hlEl) hlEl.style.display = 'none';
      hideHoverOutlineBox();
    }
    if (isReducedMotion()) return;
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
    const rows = [];
    state.elements.forEach((en, i) => {
      const row = document.createElement('div');
      row.className = 'comet-selection-row' + (i === state.activeIndex ? ' active' : '');
      row.dataset.selectionIndex = String(i);
      // Keep --row-delay for CSS fallback; GSAP drives the stagger when ready.
      row.style.setProperty('--row-delay', Math.min(i * 25, 200) + 'ms');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'comet-selection-main';
      main.dataset.selectionAction = 'activate';
      const label = selectionLabel(en);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'comet-selection-label';
      labelSpan.textContent = label;
      main.appendChild(labelSpan);
      const note = String((en.descriptor && en.descriptor.instruction) || '').replace(/\s+/g, ' ').trim();
      if (note) {
        const noteSpan = document.createElement('span');
        noteSpan.className = 'comet-selection-note';
        noteSpan.textContent = note.length > 40 ? note.slice(0, 40) + '…' : note;
        main.appendChild(noteSpan);
      }
      main.title = 'Edit ' + label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comet-selection-remove';
      remove.dataset.selectionAction = 'remove';
      remove.textContent = '×';
      remove.title = 'Remove ' + label;
      row.appendChild(main);
      row.appendChild(remove);
      inspSelectionList.appendChild(row);
      rows.push(row);
    });
    // Stagger reveal 25ms with slight y-offset (Premium / MD3 Emphasized).
    if (rows.length) {
      gsapStaggerIn(rows, {
        duration: 0.22,
        stagger: 0.025,
        from: { opacity: 0, y: 8 },
        to: { opacity: 1, y: 0 },
      });
    }
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
    syncInspAdd();
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
    syncInspAdd();
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
    chatHead.textContent = chipFromEl(el) + (isEdit ? ' - edit instruction' : '');
    chatInput.value = isEdit ? (state.elements[editIndex].descriptor.instruction || '') : '';
    // Element instructions live in the inspector, not the bottom-right chat
    // card (the card is annotate-note only). The panel opens below via
    // openInspector; focus its instruction field.
    positionSelections();
    // v1.1: inspector is bound to the committed descriptor, so edits remain
    // per element when a different selection becomes active.
    const inspDesc = isEdit ? state.elements[editIndex].descriptor : descriptor;
    // A panel failure must never break element picking: log via the diag ring
    // and continue the focus/selection flow so the next click still works.
    try {
      openInspector(el, inspDesc);
    } catch (err) {
      diagLog('error', 'openInspector failed: ' + (err && err.message ? err.message : String(err)));
    }
    if (inspInput) inspInput.value = inspDesc.instruction || '';
    if (inspInput) inspInput.focus();
    syncInspAdd();
    updateSelectionUI();
  }

  function addChat() {
    if (!pending) return;
    // The instruction field is the inspector textarea in element mode (the
    // chat card is annotate-note only); fall back to the card input.
    const src = (inspInput && inspPanel && !inspPanel.hidden) ? inspInput : chatInput;
    const instr = String(src.value || '').trim().slice(0, MAX_INSTR);
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
    if (chatInput) chatInput.value = '';
    if (inspInput) inspInput.value = state.elements[committedIndex].descriptor.instruction || '';
    if (inspInput) inspInput.focus(); // inspector stays open for the next element
    syncInspAdd();
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
    if (chatInput) chatInput.value = '';
    if (inspInput) inspInput.value = '';
    syncInspAdd();
    closeInspector(); // deselection closes the inspector
  }

  /* ---- annotate-mode note card (not bound to any element) ---- */
  // The bottom-right chat card doubles as a scratchpad while the ANNOTATE
  // tool is active: notes queue into state.annotNote (Enter / Add) and ship
  // with the payload as `note`. Element-mode behavior (pending) is untouched.
  function showAnnotNoteCard() {
    if (!chatCard) return;
    chatHead.textContent = 'Annotation note';
    chatInput.placeholder = 'Your thoughts/instructions for this annotation…';
    chatInput.value = state.annotNotes.join('\n'); // re-shows the committed notes
    chatCard.classList.add('comet-chat-note');
    chatCard.hidden = false;
    // Premium pop: layered scale + slide + opacity (MD3 Emphasized, 240ms).
    // Reduced motion -> gsapEnter snaps straight to the final state.
    gsapEnter(chatCard, {
      duration: 0.24,
      ease: EASE.md3Emphasized,
      from: { opacity: 0, y: 14, scale: 0.96 },
      to: { opacity: 1, y: 0, scale: 1 },
    });
    chatInput.focus();
  }

  function hideAnnotNoteCard() {
    if (!chatCard) return;
    chatCard.hidden = true;
    chatCard.classList.remove('comet-chat-note');
    chatInput.value = ''; // discard the uncommitted draft, keep the committed queue
    chatInput.placeholder = 'Your thoughts/instructions for this element…';
  }

  function commitAnnotNote() {
    if (!state.annotateOn || state.elementMode) return;
    if (!chatCard || chatCard.hidden) return;
    const text = chatInput.value.trim().slice(0, MAX_INSTR);
    if (text) {
      state.annotNote = text; // legacy last note ('note' payload back-compat)
      state.annotNotes.push(text);
      // Keep the queue in sync with what send() ships (slice(0, 20)).
      if (state.annotNotes.length > 20) state.annotNotes.splice(0, state.annotNotes.length - 20);
    }
    chatInput.value = '';
    chatInput.focus(); // stays open for the next note (queue-first)
    updateNoteCount();
  }

  // Toolbar chip showing how many annotation notes are queued. Notes ship
  // ONLY via the toolbar Send button; the inspector Add button never sends.
  function updateNoteCount() {
    if (!noteCountEl) return;
    const n = state.annotNotes.length;
    noteCountEl.hidden = n === 0;
    noteCountEl.textContent = n === 1 ? '📝 1 note' : '📝 ' + n + ' notes';
    if (n > 0) showSendButton(); // queued notes are sendable even with no strokes/elements
  }

  function onMouseMove(e) {
    if (!state.elementMode) return;
    mouse = { x: e.clientX, y: e.clientY };
    mouseDirty = true;
    if (isReducedMotion()) hoverTick();
  }

  // DevTools-style: suppress mousedown so SPA/custom buttons that navigate
  // on mousedown (not click) cannot react while the picker is active.
  // preventDefault on mousedown does NOT suppress the subsequent click event.
  function onPageMouseDown(e) {
    if (!state.elementMode) return;
    if (e.composedPath().indexOf(host) !== -1) return; // interaction inside our UI
    if (pointOverUi(e.clientX, e.clientY)) return;     // over our own UI surface
    e.preventDefault();
    e.stopPropagation();
  }

  function onPageClick(e) {
    if (!state.elementMode) return;
    if (e.composedPath().indexOf(host) !== -1) return; // click inside our UI
    if (pointOverUi(e.clientX, e.clientY)) return;     // over our own UI surface
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

    // Plain click makes this the active element for editing. Clicking an
    // already-committed element keeps the whole queue and enters edit mode;
    // the committed selection list always persists (queue-first model).
    if (existingIdx !== -1) {
      const idx = state.elements.findIndex((en) => en.descriptor.cssPath === d.cssPath);
      openChat(d, el, true, idx);
      return;
    }
    if (pending && pending.descriptor.cssPath === d.cssPath) {
      if (inspInput) inspInput.focus(); // same pending element -> just refocus
      return;
    }
    // New element pick: keep every committed selection. openChat drops only
    // the previous NEW pending outline, so the queue never disappears.
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
    const path = e.composedPath();
    const fromUi = path.indexOf(host) !== -1;
    const fromChatInput = !!chatInput && path.indexOf(chatInput) !== -1;
    const fromInspInput = !!inspInput && path.indexOf(inspInput) !== -1;
    const chatEnter = fromChatInput && e.key === 'Enter' && !e.shiftKey;
    const inspEnter = fromInspInput && e.key === 'Enter' && !e.shiftKey;
    // Events from inspector controls must reach their real shadow-DOM target.
    // Only Escape and the Enter shortcuts (chat card / inspector instruction
    // field) are global actions.
    if (fromUi && e.key !== 'Escape' && !chatEnter && !inspEnter) {
      // Block host-page shortcuts (capture-phase window listeners run before
      // the shadow-root bubble guard at bindEvents). stopImmediatePropagation
      // without preventDefault: the field still receives the character, the
      // page never sees the key.
      e.stopImmediatePropagation();
      return;
    }

    // Annotate note mode: the card is bound to the note, not to an element.
    if (state.annotateOn && !state.elementMode && chatCard && !chatCard.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        hideAnnotNoteCard();
        return;
      }
      if (chatEnter) {
        e.preventDefault();
        commitAnnotNote();
        return;
      }
    }
    if (!state.elementMode) return;
    // Element mode: instructions live in the inspector instruction field.
    // Enter commits the pending element (Shift+Enter inserts a newline and
    // never commits; Enter with no pending element does nothing either).
    // Escape cancels the pending element and closes the inspector.
    if (inspEnter || chatEnter) {
      if (!pending) return;
      e.preventDefault();
      addChat();
      return;
    }
    if (e.key === 'Escape' && pending && (fromInspInput || fromChatInput)) {
      e.preventDefault();
      cancelChat();
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
  const TEXT_HINT_PROPS = new Set(['fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'color', 'textAlign', 'textTransform', 'textDecoration', 'fontStyle']);
  const UNDERLINE_HINT_PROPS = new Set(['text', 'href']);
  const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'];
  const TEXT_TRANSFORM_VALUES = ['none', 'uppercase', 'lowercase', 'capitalize'];
  const TEXT_TRANSFORM_CYCLE = ['uppercase', 'lowercase', 'capitalize', 'none'];
  const TEXT_DECORATION_VALUES = ['none', 'underline', 'line-through'];
  const FONT_STYLE_VALUES = ['normal', 'italic'];
  const TEXT_PROP_LABELS = {
    text: 'Content',
    fontFamily: 'Font',
    fontWeight: 'Weight',
    fontSize: 'Size',
    lineHeight: 'Leading',
    letterSpacing: 'Tracking',
    textAlign: 'Align',
    fontStyle: 'Style',
    textTransform: 'Case',
    textDecoration: 'Decor',
    color: 'Color',
  };
  const INLINE_TAGS = new Set([
    'SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'U', 'LABEL', 'CODE', 'SMALL', 'BIG',
    'ABBR', 'CITE', 'DFN', 'KBD', 'SAMP', 'VAR', 'MARK', 'TIME', 'Q', 'SUB', 'SUP',
    'BUTTON', 'S', 'STRIKE', 'DEL', 'INS',
  ]);
  // Inspector category grouping (v1.6). Each property maps to exactly one bucket.
  const CAT_ORDER = ['Text', 'Layout', 'Appearance', 'Other'];
  const CAT_TEXT = new Set([
    'text', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing',
    'color', 'textAlign', 'textTransform', 'textDecoration', 'fontStyle',
    'wordSpacing', 'whiteSpace', 'textShadow', 'verticalAlign',
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

  // Append a collapsible inspector category (header + body). Returns the body.
  function appendInspectorCategory(cat) {
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
    inspRows.appendChild(header);
    inspRows.appendChild(body);
    return body;
  }

  // Compact CSS selector for copy (prefer #id, else tag.class, else cssPath).
  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    try {
      if (el.id && typeof el.id === 'string' && /^[A-Za-z][\w-]*$/.test(el.id)) {
        return '#' + el.id;
      }
    } catch (_) { /* ok */ }
    const tag = (el.tagName || '').toLowerCase();
    let cls = '';
    try { cls = el.getAttribute('class') || ''; } catch (_) {
      try { cls = el.className || ''; } catch (__) { cls = ''; }
    }
    if (typeof cls === 'string') {
      const tokens = cls.trim().split(/\s+/).filter((c) => c && /^[A-Za-z_-][\w-]*$/.test(c));
      if (tokens.length) return tag + '.' + tokens.slice(0, 3).join('.');
    }
    return cssPath(el);
  }

  function copyTextToClipboard(text) {
    const s = String(text == null ? '' : text);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(s).then(() => true).catch(() => copyTextExecCommand(s));
    }
    return Promise.resolve(copyTextExecCommand(s));
  }

  function copyTextExecCommand(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function flashCopyButton(btn) {
    if (!btn) return;
    const prev = btn.textContent;
    btn.classList.add('is-copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.textContent = prev;
    }, 900);
  }

  function bindCopyButton(btn, getText) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = typeof getText === 'function' ? getText() : getText;
      Promise.resolve(copyTextToClipboard(text)).then((ok) => {
        if (ok !== false) flashCopyButton(btn);
      }).catch(() => { /* silent */ });
    });
  }

  let revealPulseTimer = 0;
  function revealElementOnPage(el) {
    if (!el || !el.isConnected) return;
    try {
      el.scrollIntoView({
        behavior: isReducedMotion() ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    } catch (_) {
      try { el.scrollIntoView(true); } catch (__) { /* ok */ }
    }
    // Prefer pulsing the existing selection outline; otherwise create a temp ring.
    let outline = null;
    const entry = state.elements.find((en) => en.el === el);
    if (entry && entry.outlineEl) outline = entry.outlineEl;
    if (pending && pending.el === el && pending.outlineEl) outline = pending.outlineEl;
    if (revealPulseTimer) {
      clearTimeout(revealPulseTimer);
      revealPulseTimer = 0;
    }
    if (outline) {
      outline.classList.remove('comet-el-reveal-pulse');
      void outline.offsetWidth;
      if (!isReducedMotion()) outline.classList.add('comet-el-reveal-pulse');
      revealPulseTimer = setTimeout(() => {
        revealPulseTimer = 0;
        if (outline) outline.classList.remove('comet-el-reveal-pulse');
      }, isReducedMotion() ? 0 : 700);
      return;
    }
    // Temporary outline when the element is not yet in the selection list.
    if (!selLayer || isReducedMotion()) return;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
    if (!r || r.width < 1 || r.height < 1) return;
    const tmp = document.createElement('div');
    tmp.className = 'comet-el comet-el-reveal-pulse';
    placeRect(tmp, r);
    selLayer.appendChild(tmp);
    revealPulseTimer = setTimeout(() => {
      revealPulseTimer = 0;
      if (tmp.parentNode) tmp.parentNode.removeChild(tmp);
    }, 700);
  }

  const COMPUTED_STYLE_KEYS = [
    'display', 'position', 'color', 'background-color', 'font-size',
    'padding', 'margin', 'border', 'border-radius', 'opacity', 'z-index', 'box-shadow',
  ];

  function readComputedStyleMap(el) {
    const out = {};
    if (!el) return out;
    let cs = null;
    try { cs = window.getComputedStyle(el); } catch (_) { cs = null; }
    if (!cs) return out;
    COMPUTED_STYLE_KEYS.forEach((key) => {
      try { out[key] = cs.getPropertyValue(key) || ''; } catch (_) { out[key] = ''; }
    });
    return out;
  }

  function formatRectReadout(el) {
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { r = null; }
    const sx = window.scrollX || window.pageXOffset || 0;
    const sy = window.scrollY || window.pageYOffset || 0;
    if (!r) {
      return { x: '-', y: '-', w: '-', h: '-', scroll: '-' };
    }
    const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
    return {
      x: round1(r.left),
      y: round1(r.top),
      w: round1(r.width),
      h: round1(r.height),
      scroll: round1(sx) + ', ' + round1(sy),
    };
  }

  function updateInspectorMetrics() {
    if (!inspRows || !inspector.el) return;
    const grid = inspRows.querySelector('.comet-insp-metrics');
    if (!grid) return;
    const vals = formatRectReadout(inspector.el);
    grid.querySelectorAll('[data-metric]').forEach((cell) => {
      const key = cell.dataset.metric;
      if (key && vals[key] != null) cell.textContent = vals[key];
    });
  }

  function appendDevtoolCategories(el) {
    if (!el || !inspRows) return;

    // ---- Selectors: copy path / selector + reveal on page ----
    const selBody = appendInspectorCategory('Selectors');
    const path = cssPath(el);
    const selector = cssSelector(el);

    const pathRow = document.createElement('div');
    pathRow.className = 'comet-insp-dev-row';
    const pathLab = document.createElement('span');
    pathLab.className = 'comet-insp-label';
    pathLab.textContent = 'CSS path';
    const pathVal = document.createElement('code');
    pathVal.className = 'comet-insp-mono';
    pathVal.textContent = path;
    pathVal.title = path;
    const pathCopy = document.createElement('button');
    pathCopy.type = 'button';
    pathCopy.className = 'comet-insp-copy';
    pathCopy.textContent = 'Copy';
    pathCopy.title = 'Copy CSS path';
    bindCopyButton(pathCopy, () => path);
    pathRow.appendChild(pathLab);
    pathRow.appendChild(pathVal);
    pathRow.appendChild(pathCopy);
    selBody.appendChild(pathRow);

    const selRow = document.createElement('div');
    selRow.className = 'comet-insp-dev-row';
    const selLab = document.createElement('span');
    selLab.className = 'comet-insp-label';
    selLab.textContent = 'Selector';
    const selVal = document.createElement('code');
    selVal.className = 'comet-insp-mono';
    selVal.textContent = selector;
    selVal.title = selector;
    const selCopy = document.createElement('button');
    selCopy.type = 'button';
    selCopy.className = 'comet-insp-copy';
    selCopy.textContent = 'Copy';
    selCopy.title = 'Copy CSS selector';
    bindCopyButton(selCopy, () => selector);
    selRow.appendChild(selLab);
    selRow.appendChild(selVal);
    selRow.appendChild(selCopy);
    selBody.appendChild(selRow);

    const revealRow = document.createElement('div');
    revealRow.className = 'comet-insp-dev-row comet-insp-dev-row-actions';
    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'comet-insp-reveal';
    revealBtn.textContent = 'Reveal on page';
    revealBtn.title = 'Scroll to element and pulse its outline';
    revealBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealElementOnPage(el);
    });
    revealRow.appendChild(revealBtn);
    selBody.appendChild(revealRow);

    // ---- Computed: compact 2-col read-only grid ----
    const compBody = appendInspectorCategory('Computed');
    const compGrid = document.createElement('div');
    compGrid.className = 'comet-insp-computed';
    const cmap = readComputedStyleMap(el);
    COMPUTED_STYLE_KEYS.forEach((key) => {
      const cell = document.createElement('div');
      cell.className = 'comet-insp-computed-cell';
      const k = document.createElement('span');
      k.className = 'comet-insp-computed-key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'comet-insp-computed-val';
      v.textContent = cmap[key] || '-';
      v.title = cmap[key] || '';
      cell.appendChild(k);
      cell.appendChild(v);
      compGrid.appendChild(cell);
    });
    compBody.appendChild(compGrid);

    // ---- Size & Position: live getBoundingClientRect + scroll ----
    const metricsBody = appendInspectorCategory('Size & Position');
    const metrics = document.createElement('div');
    metrics.className = 'comet-insp-metrics';
    const vals = formatRectReadout(el);
    [
      ['x', 'X'],
      ['y', 'Y'],
      ['w', 'W'],
      ['h', 'H'],
      ['scroll', 'Scroll'],
    ].forEach(([key, label]) => {
      const cell = document.createElement('div');
      cell.className = 'comet-insp-metric' + (key === 'scroll' ? ' comet-insp-metric-wide' : '');
      const k = document.createElement('span');
      k.className = 'comet-insp-metric-key';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'comet-insp-metric-val';
      v.dataset.metric = key;
      v.textContent = vals[key];
      cell.appendChild(k);
      cell.appendChild(v);
      metrics.appendChild(cell);
    });
    metricsBody.appendChild(metrics);
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
    if (s.indexOf('line-through') !== -1 || s.indexOf('linethrough') !== -1) return 'line-through';
    if (s.indexOf('underline') !== -1) return 'underline';
    return 'none';
  }

  function parseLetterSpacing(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'normal') return 0;
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function elementHasEditableText(el) {
    if (!el) return false;
    try {
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'AUDIO' ||
          tag === 'CANVAS' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED' ||
          tag === 'HR' || tag === 'BR' || tag === 'SOURCE' || tag === 'TRACK' ||
          tag === 'AREA' || tag === 'MAP' || tag === 'PICTURE') {
        // AREA can still have href; text controls stay hidden.
        return false;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      const text = readEditableText(el);
      return !!(text && String(text).trim() !== '');
    } catch (_) {
      return false;
    }
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
      const ls = parseLetterSpacing(cs.letterSpacing);
      out.push({
        prop: 'letterSpacing', kind: 'slider', min: -2, max: 20, step: 0.1, unit: 'px',
        numeric: ls, current: String(cs.letterSpacing),
      });
      out.push({
        prop: 'textAlign', kind: 'select', options: TEXT_ALIGN_VALUES,
        current: cs.textAlign, value: mapTextAlign(cs.textAlign),
      });
      out.push({
        prop: 'fontStyle', kind: 'select', options: FONT_STYLE_VALUES,
        current: cs.fontStyle, value: mapFontStyle(cs.fontStyle),
      });
      out.push({
        prop: 'textTransform', kind: 'select', options: TEXT_TRANSFORM_VALUES,
        current: cs.textTransform, value: mapTextTransform(cs.textTransform),
      });
      out.push({
        prop: 'textDecoration', kind: 'select', options: TEXT_DECORATION_VALUES,
        current: cs.textDecoration || cs.textDecorationLine,
        value: mapTextDecoration(cs.textDecorationLine || cs.textDecoration),
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
    // Hide text content + typography controls for non-text elements (img, svg, ...).
    // Layout/Appearance rows still render; Text category only appears when useful.
    if (elementHasEditableText(el) || (text && String(text).length > 0)) {
      out.push({ prop: 'text', kind: 'textarea', current: text, value: text, max: MAX_TEXT });
    } else {
      // Strip typography props already pushed when the element has no text.
      for (let i = out.length - 1; i >= 0; i--) {
        if (CAT_TEXT.has(out[i].prop) && out[i].prop !== 'href') out.splice(i, 1);
      }
    }
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
    const value = Number(numeric);
    const safe = Number.isFinite(value) ? value : 0;
    if (prop === 'lineHeight') {
      const n = Math.round(safe * 100) / 100;
      return String(n);
    }
    if (prop === 'letterSpacing') {
      const n = Math.round(safe * 100) / 100;
      return String(n) + (unit || 'px');
    }
    return String(Math.round(safe)) + (unit || 'px');
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
    const fmtProps = ['fontStyle', 'textDecoration', 'textAlign', 'textTransform', 'letterSpacing'];
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
      else if (prop === 'letterSpacing') n = parseLetterSpacing(display);
      else n = parsePx(display);
      control.value = String(Number.isFinite(n) ? n : control.min);
      if (valEl) valEl.textContent = formatManipValue(prop, control.value, control.dataset.unit || '');
    } else if (control.type === 'color') {
      control.value = rgbToHex(display);
    } else if (prop === 'fontWeight') {
      control.value = mapFontWeight(display);
    } else if (prop === 'fontFamily') {
      control.value = firstFontFamily(display);
    } else if (prop === 'textAlign') {
      control.value = mapTextAlign(display);
    } else if (prop === 'fontStyle') {
      control.value = mapFontStyle(display);
    } else if (prop === 'textTransform') {
      control.value = mapTextTransform(display);
    } else if (prop === 'textDecoration') {
      control.value = mapTextDecoration(display);
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
      wrap.classList.add('comet-insp-slider-control');
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

    // Multiline text editor: content textarea. Typography controls live in the
    // grouped Text panel (Character/Paragraph style) below this row.
    // Enter inserts newlines; applyLiveText renders via <br> or pre-line.
    wrap.className = 'comet-insp-control comet-insp-text-editor';

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

  // Premium Text panel helpers (Character / Paragraph), Adobe + Figma pattern:
  // compact labeled rows, segmented controls for align/style/case/decoration.
  // All writes go through applyLive + recordEdit.
  function buildSegmentedControl(prop, values, labels, titles, current) {
    const group = document.createElement('div');
    group.className = 'comet-insp-seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', prop);
    group.dataset.inspSeg = prop;
    values.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'comet-insp-seg-btn' + (current === v ? ' active' : '');
      b.dataset.inspFmt = prop;
      if (prop === 'textAlign') b.dataset.alignValue = v;
      else if (prop === 'textTransform') b.dataset.transformValue = v;
      else {
        b.dataset.onValue = v;
        b.dataset.offValue = values[0];
      }
      b.setAttribute('aria-pressed', current === v ? 'true' : 'false');
      b.title = (titles && titles[v]) || String(v);
      b.textContent = (labels && labels[v]) || String(v);
      group.appendChild(b);
    });
    return group;
  }

  function buildTextFormatToolbar(edits) {
    const bar = document.createElement('div');
    bar.className = 'comet-insp-fmt comet-insp-fmt-compact';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');

    const fsBase = mapFontStyle(edits.fontStyle != null ? edits.fontStyle : readFormatBaseline('fontStyle'));
    const tdBase = mapTextDecoration(edits.textDecoration != null ? edits.textDecoration : readFormatBaseline('textDecoration'));
    const taBase = mapTextAlign(edits.textAlign != null ? edits.textAlign : readFormatBaseline('textAlign'));
    const ttBase = mapTextTransform(edits.textTransform != null ? edits.textTransform : readFormatBaseline('textTransform'));

    bar.appendChild(buildSegmentedControl(
      'fontStyle', FONT_STYLE_VALUES,
      { normal: 'Aa', italic: 'I' },
      { normal: 'Normal', italic: 'Italic' },
      fsBase
    ));
    bar.appendChild(buildSegmentedControl(
      'textDecoration', TEXT_DECORATION_VALUES,
      { none: '-', underline: 'U', 'line-through': 'S' },
      { none: 'None', underline: 'Underline', 'line-through': 'Strikethrough' },
      tdBase
    ));
    bar.appendChild(buildSegmentedControl(
      'textAlign', TEXT_ALIGN_VALUES,
      { left: 'L', center: 'C', right: 'R', justify: 'J' },
      { left: 'Align left', center: 'Align center', right: 'Align right', justify: 'Justify' },
      taBase
    ));
    bar.appendChild(buildSegmentedControl(
      'textTransform', TEXT_TRANSFORM_VALUES,
      { none: 'off', uppercase: 'AA', lowercase: 'aa', capitalize: 'Aa' },
      { none: 'None', uppercase: 'UPPERCASE', lowercase: 'lowercase', capitalize: 'Capitalize' },
      ttBase
    ));
    return bar;
  }

  function syncFormatToolbar(bar) {
    if (!bar) return;
    const edits = currentEdits();
    const fs = mapFontStyle(edits.fontStyle != null ? edits.fontStyle : readFormatBaseline('fontStyle'));
    const td = mapTextDecoration(edits.textDecoration != null ? edits.textDecoration : readFormatBaseline('textDecoration'));
    const ta = mapTextAlign(edits.textAlign != null ? edits.textAlign : readFormatBaseline('textAlign'));
    const tt = mapTextTransform(edits.textTransform != null ? edits.textTransform : readFormatBaseline('textTransform'));

    bar.querySelectorAll('[data-insp-fmt="fontStyle"]').forEach((b) => {
      const on = (b.dataset.onValue || '') === fs || (fs === 'italic' && b.dataset.onValue === 'italic');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textDecoration"]').forEach((b) => {
      const on = (b.dataset.onValue || '') === td;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textAlign"]').forEach((b) => {
      const on = b.dataset.alignValue === ta;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    bar.querySelectorAll('[data-insp-fmt="textTransform"]').forEach((b) => {
      const on = (b.dataset.transformValue || b.dataset.onValue) === tt;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function syncTextPanelSegments(root) {
    if (!root) return;
    root.querySelectorAll('.comet-insp-fmt, .comet-insp-seg').forEach((node) => {
      syncFormatToolbar(node.closest('.comet-insp-fmt') || node);
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
    if (prop === 'textAlign') {
      value = btn.dataset.alignValue || 'left';
    } else if (prop === 'textTransform') {
      // Segmented case control: pick the pressed value directly.
      value = btn.dataset.transformValue || btn.dataset.onValue || 'none';
    } else if (prop === 'fontStyle' || prop === 'textDecoration' || prop === 'fontWeight') {
      // Segmented / toggle: pressing an active exclusive option keeps it; otherwise set onValue.
      const onValue = btn.dataset.onValue;
      const offValue = btn.dataset.offValue;
      if (btn.closest('.comet-insp-seg')) {
        value = onValue;
      } else {
        const isOn = btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true';
        value = isOn ? offValue : onValue;
      }
    } else {
      return;
    }
    // Live style writes + edits payload (existing schema keys).
    applyLive(prop, value);
    recordEdit(prop, value);
    // Keep matching select rows in sync when segmented controls change.
    const row = inspRows && inspRows.querySelector('.comet-insp-row[data-prop="' + prop + '"]');
    const sel = row && row.querySelector('[data-insp-control]');
    if (sel && sel.tagName === 'SELECT') {
      if (prop === 'fontWeight') sel.value = mapFontWeight(value);
      else if (prop === 'fontStyle') sel.value = mapFontStyle(value);
      else if (prop === 'textDecoration') sel.value = mapTextDecoration(value);
      else if (prop === 'textAlign') sel.value = mapTextAlign(value);
      else if (prop === 'textTransform') sel.value = mapTextTransform(value);
    }
    const bar = btn.closest('.comet-insp-fmt') || btn.closest('.comet-insp-text-panel');
    if (bar) syncTextPanelSegments(bar);
    else syncFormatToolbar(btn.closest('.comet-insp-fmt'));
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

      if (cat === 'Text') {
        // Premium Character + Paragraph grouping (Adobe/Figma pattern).
        const panel = document.createElement('div');
        panel.className = 'comet-insp-text-panel';

        const byProp = {};
        items.forEach((p) => { byProp[p.prop] = p; });

        const appendPropRow = (p, groupEl, labelOverride) => {
          if (!p) return;
          const row = document.createElement('div');
          const rowClasses = ['comet-insp-row', 'comet-insp-text-field'];
          if (p.prop === 'text') rowClasses.push('comet-insp-row-text');
          if (p.kind === 'slider') rowClasses.push('comet-insp-row-slider');
          else if (p.kind === 'select' || p.kind === 'fontFamily') rowClasses.push('comet-insp-row-select');
          else if (p.kind === 'color') rowClasses.push('comet-insp-row-color');
          row.className = rowClasses.join(' ');
          row.dataset.prop = p.prop;
          row.tabIndex = -1;
          row.style.setProperty('--row-delay', Math.min(rowIndex * 30, 200) + 'ms');
          rowIndex++;

          const propLab = document.createElement('span');
          propLab.className = 'comet-insp-label';
          const pretty = labelOverride || TEXT_PROP_LABELS[p.prop] || p.prop;
          propLab.textContent = pretty;
          propLab.title = p.prop;

          const control = buildControl(p, edits);
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
          groupEl.appendChild(row);
        };

        // Content
        if (byProp.text) {
          const g = document.createElement('div');
          g.className = 'comet-insp-text-group';
          const gh = document.createElement('div');
          gh.className = 'comet-insp-text-group-label';
          gh.textContent = 'Content';
          g.appendChild(gh);
          appendPropRow(byProp.text, g, 'Text');
          panel.appendChild(g);
        }

        // Character: font / weight / size / leading / tracking / color
        const char = document.createElement('div');
        char.className = 'comet-insp-text-group';
        const charLab = document.createElement('div');
        charLab.className = 'comet-insp-text-group-label';
        charLab.textContent = 'Character';
        char.appendChild(charLab);

        const twin = document.createElement('div');
        twin.className = 'comet-insp-text-twin';
        ['fontFamily', 'fontWeight'].forEach((prop) => {
          if (!byProp[prop]) return;
          const cell = document.createElement('div');
          cell.className = 'comet-insp-text-cell';
          appendPropRow(byProp[prop], cell);
          twin.appendChild(cell);
        });
        if (twin.childNodes.length) char.appendChild(twin);

        const metrics = document.createElement('div');
        metrics.className = 'comet-insp-text-metrics';
        ['fontSize', 'lineHeight', 'letterSpacing'].forEach((prop) => {
          if (!byProp[prop]) return;
          const cell = document.createElement('div');
          cell.className = 'comet-insp-text-cell';
          appendPropRow(byProp[prop], cell);
          metrics.appendChild(cell);
        });
        if (metrics.childNodes.length) char.appendChild(metrics);

        if (byProp.color) appendPropRow(byProp.color, char);
        panel.appendChild(char);

        // Paragraph: align + style + case + decoration (segmented)
        const para = document.createElement('div');
        para.className = 'comet-insp-text-group';
        const paraLab = document.createElement('div');
        paraLab.className = 'comet-insp-text-group-label';
        paraLab.textContent = 'Paragraph';
        para.appendChild(paraLab);

        // Hidden rows keep Reset/sync/edited-state wiring for segmented props.
        ['textAlign', 'fontStyle', 'textTransform', 'textDecoration'].forEach((prop) => {
          if (!byProp[prop]) return;
          const row = document.createElement('div');
          row.className = 'comet-insp-row comet-insp-row-seg';
          row.dataset.prop = prop;
          row.tabIndex = -1;
          row.style.setProperty('--row-delay', Math.min(rowIndex * 30, 200) + 'ms');
          rowIndex++;

          const propLab = document.createElement('span');
          propLab.className = 'comet-insp-label';
          propLab.textContent = TEXT_PROP_LABELS[prop] || prop;
          propLab.title = prop;

          const wrap = document.createElement('div');
          wrap.className = 'comet-insp-control';
          // Keep a select as the canonical [data-insp-control] for Reset sync,
          // visually replaced by the segmented control beside it.
          const selWrap = buildControl(byProp[prop], edits);
          selWrap.classList.add('comet-insp-seg-source');
          wrap.appendChild(selWrap);

          const edited = edits[prop] != null ? String(edits[prop]) : null;
          let current = edited != null ? edited : byProp[prop].value;
          if (prop === 'textAlign') current = mapTextAlign(current);
          else if (prop === 'fontStyle') current = mapFontStyle(current);
          else if (prop === 'textTransform') current = mapTextTransform(current);
          else if (prop === 'textDecoration') current = mapTextDecoration(current);

          let labels = null;
          let titles = null;
          let values = null;
          if (prop === 'textAlign') {
            values = TEXT_ALIGN_VALUES;
            labels = { left: 'L', center: 'C', right: 'R', justify: 'J' };
            titles = { left: 'Align left', center: 'Align center', right: 'Align right', justify: 'Justify' };
          } else if (prop === 'fontStyle') {
            values = FONT_STYLE_VALUES;
            labels = { normal: 'Aa', italic: 'I' };
            titles = { normal: 'Normal', italic: 'Italic' };
          } else if (prop === 'textTransform') {
            values = TEXT_TRANSFORM_VALUES;
            labels = { none: 'off', uppercase: 'AA', lowercase: 'aa', capitalize: 'Aa' };
            titles = { none: 'None', uppercase: 'UPPERCASE', lowercase: 'lowercase', capitalize: 'Capitalize' };
          } else if (prop === 'textDecoration') {
            values = TEXT_DECORATION_VALUES;
            labels = { none: '-', underline: 'U', 'line-through': 'S' };
            titles = { none: 'None', underline: 'Underline', 'line-through': 'Strikethrough' };
          }
          wrap.appendChild(buildSegmentedControl(prop, values, labels, titles, current));

          if (edits[prop] !== undefined && edits[prop] !== null && String(edits[prop]).trim() !== '') {
            applyLive(prop, String(edits[prop]));
          }

          const rst = document.createElement('button');
          rst.type = 'button';
          rst.className = 'comet-insp-reset';
          rst.textContent = 'Reset';
          rst.title = 'Reset ' + prop + ' to original';
          rst.dataset.inspReset = '1';

          row.appendChild(propLab);
          row.appendChild(wrap);
          row.appendChild(rst);
          para.appendChild(row);
        });
        panel.appendChild(para);

        // Any remaining Text-category props not covered above.
        const covered = new Set([
          'text', 'fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing',
          'color', 'textAlign', 'fontStyle', 'textTransform', 'textDecoration',
        ]);
        items.forEach((p) => {
          if (covered.has(p.prop)) return;
          appendPropRow(p, panel);
        });

        body.appendChild(panel);
      } else {
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
      }

      inspRows.appendChild(header);
      inspRows.appendChild(body);
    });
    // Devtool readouts: Selectors (copy/reveal), Computed, Size & Position.
    // Appended after editable property categories; Text category untouched.
    appendDevtoolCategories(el);
    // Re-apply formatting toolbar edits (fontStyle/textDecoration/textAlign/
    // textTransform) that are not independent inspector rows.
    ['fontStyle', 'textDecoration', 'textAlign', 'textTransform', 'fontWeight', 'letterSpacing'].forEach((prop) => {
      if (edits[prop] !== undefined && edits[prop] !== null && String(edits[prop]).trim() !== '') {
        applyLive(prop, String(edits[prop]));
      }
    });
    const textPanel = inspRows.querySelector('.comet-insp-text-panel');
    if (textPanel) syncTextPanelSegments(textPanel);
    updateInspectorState();
    updateSelectionUI();
    updateInspectorMetrics();
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
    // Segmented Paragraph props own their rows; no need to bleed onto Content.
    inspCountEl.textContent = n === 1 ? '1 edit' : n + ' edits';
  }

  // Delayed-hide timer for the inspector exit animation (comet-insp-close).
  let inspCloseTimer = 0;

  function openInspector(el, descriptor) {
    clearPropertyHint();
    if (inspCloseTimer) {
      clearTimeout(inspCloseTimer);
      inspCloseTimer = 0;
    }
    inspector.el = el;
    inspector.descriptor = descriptor;
    const selectedIndex = state.elements.findIndex((en) => en.descriptor === descriptor);
    if (selectedIndex !== -1) state.activeIndex = selectedIndex;
    captureOriginals(el);
    renderInspector();
    // Anchor side for the fold: dock edge when docked, else the viewport side
    // the selected element sits in. Enter/exit animate toward that side.
    const dir = inspDirection();
    setInspDirection(dir);
    updateDockUI();
    inspPanel.hidden = false;
    diagLog('inspector', 'open');
    if (state.dock) applyDock();
    else positionInspector();
    inspPanel.classList.remove('is-open', 'comet-insp-close', 'comet-insp-open');
    gsapKill(inspPanel);
    inspPanel.classList.add('is-open');
    // Keep comet-insp-open class for CSS fallback; GSAP drives the fold.
    if (!isReducedMotion() && gsapReady) {
      inspPanel.classList.add('comet-insp-open');
      gsapInspectorOpen(inspPanel, dir);
      setTimeout(() => {
        if (inspPanel) inspPanel.classList.remove('comet-insp-open');
      }, 380);
    } else if (!isReducedMotion()) {
      void inspPanel.offsetWidth;
      playMotion(inspPanel, 'comet-insp-open', 280);
    } else {
      gsapSet(inspPanel, { opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    }
    syncInspectorRingAnimation();
    updateSelectionUI();
  }

  function closeInspector() {
    clearPropertyHint();
    stopInspectorRingTween();
    if (revealPulseTimer) {
      clearTimeout(revealPulseTimer);
      revealPulseTimer = 0;
    }
    inspector.el = null;
    inspector.descriptor = null;
    inspectorOriginals = new Map();
    diagLog('inspector', 'close');
    if (!inspPanel) return;
    if (inspCloseTimer) {
      clearTimeout(inspCloseTimer);
      inspCloseTimer = 0;
    }
    let closed = false;
    const finishClose = () => {
      if (closed) return;
      closed = true;
      if (inspCloseTimer) { clearTimeout(inspCloseTimer); inspCloseTimer = 0; }
      if (inspPanel) {
        inspPanel.classList.remove('comet-insp-close', 'comet-insp-open', 'is-open');
        inspPanel.hidden = true;
        gsapSet(inspPanel, { clearProps: 'opacity,transform,x,y,scale,scaleX,scaleY,filter' });
      }
    };
    if (isReducedMotion() || inspPanel.hidden) {
      gsapKill(inspPanel);
      inspPanel.classList.remove('is-open', 'comet-insp-open', 'comet-insp-close');
      inspPanel.hidden = true;
      return;
    }
    inspPanel.classList.remove('is-open', 'comet-insp-open');
    // Close collapses back toward the anchor side (comet-insp-from-*).
    if (!inspPanel.dataset.inspDir) setInspDirection(inspDirection());
    const dir = inspPanel.dataset.inspDir || 'bottom';
    inspPanel.classList.add('comet-insp-close');
    gsapInspectorClose(inspPanel, dir, finishClose);
    // Safety hide if GSAP unavailable / interrupted (~70% of 340ms open).
    inspCloseTimer = setTimeout(finishClose, 280);
  }

  /* ---------------- inspector drag (floating mode only) + dock control ---- */
  function startInspDrag(e) {
    if (!inspPanel || state.dock) return; // docked panels snap to the edge and stay
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left button only
    e.preventDefault();
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    inspDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: parseInt(inspPanel.style.left, 10) || 0,
      baseY: parseInt(inspPanel.style.top, 10) || 0,
      moved: false,
    };
    inspPanel.classList.add('dragging');
  }

  function onInspDragMove(e) {
    if (!inspDrag || e.pointerId !== inspDrag.pointerId) return;
    const dx = e.clientX - inspDrag.startX;
    const dy = e.clientY - inspDrag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) inspDrag.moved = true;
    const iw = inspPanel.offsetWidth || 320;
    const ih = inspPanel.offsetHeight || 0;
    const p = clampPos(inspDrag.baseX + dx, inspDrag.baseY + dy, iw, ih);
    inspPanel.style.left = p.x + 'px';
    inspPanel.style.top = p.y + 'px';
    inspPanel.style.right = 'auto';
    inspPanel.style.bottom = 'auto';
  }

  function endInspDrag(e) {
    if (!inspDrag || (e.pointerId !== undefined && e.pointerId !== inspDrag.pointerId)) return;
    try {
      if (inspDragHandle && inspDragHandle.hasPointerCapture(inspDrag.pointerId)) {
        inspDragHandle.releasePointerCapture(inspDrag.pointerId);
      }
    } catch (_) { /* ok */ }
    if (inspPanel) inspPanel.classList.remove('dragging');
    inspDrag = null;
  }

  /* ---------------- inspector corner resize (size pulling) ---------------- */
  // Dragging the bottom-right handle resizes the panel like a regular
  // window. Inline width/height win over the CSS defaults; the flex column
  // layout fills the box (rows flex:1, overflow-y auto). Clamped so the
  // layout cannot break; size persists per tab via state.inspSize.
  const INSP_MIN_W = 280;
  const INSP_MIN_H = 240;

  function inspMaxW() {
    return Math.min(720, window.innerWidth - 48);
  }

  function inspMaxH() {
    return Math.min(Math.floor(window.innerHeight * 0.9), 720);
  }

  function clampInspSize(w, h) {
    const mw = inspMaxW();
    const mh = inspMaxH();
    return {
      w: Math.max(INSP_MIN_W, Math.min(mw, Math.round(w))),
      h: Math.max(INSP_MIN_H, Math.min(mh, Math.round(h))),
    };
  }

  function applyInspSize(w, h) {
    if (!inspPanel) return;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const s = clampInspSize(w, h);
    inspPanel.style.width = s.w + 'px';
    inspPanel.style.height = s.h + 'px';
    state.inspSize = { w: s.w, h: s.h };
    saveTabState({ inspSize: state.inspSize });
  }

  function startInspResize(e) {
    if (!inspPanel || !inspResizeHandle) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left button only
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    inspResize = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseW: inspPanel.offsetWidth || 320,
      baseH: inspPanel.offsetHeight || 0,
    };
    inspPanel.classList.add('resizing');
  }

  function onInspResizeMove(e) {
    if (!inspResize || e.pointerId !== inspResize.pointerId) return;
    applyInspSize(
      inspResize.baseW + (e.clientX - inspResize.startX),
      inspResize.baseH + (e.clientY - inspResize.startY)
    );
  }

  function endInspResize(e) {
    if (!inspResize || (e.pointerId !== undefined && e.pointerId !== inspResize.pointerId)) return;
    try {
      if (inspResizeHandle && inspResizeHandle.hasPointerCapture(inspResize.pointerId)) {
        inspResizeHandle.releasePointerCapture(inspResize.pointerId);
      }
    } catch (_) { /* ok */ }
    if (inspPanel) inspPanel.classList.remove('resizing');
    inspResize = null;
  }

  /* ---------------- inspector footer Add button + cursor glow ---------------- */
  // The footer Add button commits the pending element (same as addChat).
  // It is dimmed/ignored while nothing is pending.
  function syncInspAdd() {
    if (!inspAddEl) return;
    const on = !!pending;
    inspAddEl.disabled = !on;
    inspAddEl.classList.toggle('is-disabled', !on);
  }

  // Subtle radial glow that follows the cursor inside the panel bounds.
  // --cx/--cy are set on pointermove (panel-relative px); the layer is
  // hidden on pointerleave and restored on pointerenter. It only follows
  // the cursor (no animation), so it stays under reduced motion.
  function onInspPointerMove(e) {
    if (!inspGlowEl || !inspPanel) return;
    const r = inspPanel.getBoundingClientRect();
    inspGlowEl.style.setProperty('--cx', (e.clientX - r.left) + 'px');
    inspGlowEl.style.setProperty('--cy', (e.clientY - r.top) + 'px');
  }

  function onInspPointerEnter() {
    if (inspGlowEl) inspGlowEl.style.opacity = '1';
  }

  function onInspPointerLeave() {
    if (inspGlowEl) inspGlowEl.style.opacity = '0';
  }

  // Reflect state.dock on the 4 dock buttons (aria-pressed + .active).
  function updateDockUI() {
    if (!inspDockEl) return;
    const btns = inspDockEl.querySelectorAll('[data-dock]');
    for (let i = 0; i < btns.length; i++) {
      const on = btns[i].dataset.dock === state.dock;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function onDockClick(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-dock]') : null;
    if (!b || !inspPanel) return;
    const side = b.dataset.dock;
    // Clicking the active dock again undocks back to the floating popup.
    state.dock = state.dock === side ? null : side;
    diagLog('dock', 'inspector=' + (state.dock || 'float'));
    updateDockUI();
    setInspDirection(inspDirection());
    if (state.dock) applyDock();
    else if (!inspPanel.hidden) positionInspector();
    saveTabState({ panelDock: state.dock });
    if (!isReducedMotion() && !inspPanel.hidden) {
      // Fold the panel into place at its new anchor (GSAP when ready).
      const dir = inspPanel.dataset.inspDir || inspDirection();
      if (gsapReady) {
        inspPanel.classList.remove('comet-insp-open');
        inspPanel.classList.add('comet-insp-open');
        gsapInspectorOpen(inspPanel, dir);
        setTimeout(() => {
          if (inspPanel) inspPanel.classList.remove('comet-insp-open');
        }, 380);
      } else {
        playMotion(inspPanel, 'comet-insp-open', 220);
      }
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
    // Keep segmented Paragraph controls in sync when matching selects change.
    if (prop === 'fontWeight' || prop === 'fontStyle' || prop === 'textDecoration' ||
        prop === 'textAlign' || prop === 'textTransform') {
      const panel = inspRows && inspRows.querySelector('.comet-insp-text-panel');
      if (panel) syncTextPanelSegments(panel);
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
    const panel = row.closest('.comet-insp-text-panel');
    if (panel) syncTextPanelSegments(panel);
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
    const textPanel = inspRows.querySelector('.comet-insp-text-panel');
    if (textPanel) syncTextPanelSegments(textPanel);
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
    updateSelectionUI();
  }

  /* ---------------- toolbar ---------------- */
  function applyMode(opts) {
    const o = opts || {};
    canvas.style.pointerEvents = state.annotateOn ? 'all' : 'none';
    canvas.classList.toggle('active', state.annotateOn || state.elementMode);
    toolbar.querySelector('[data-act="annotate"]').classList.toggle('active', state.annotateOn);
    toolbar.querySelector('[data-act="element"]').classList.toggle('active', state.elementMode);
    if (modePill) {
      const verticalDock = state.toolbarDock === 'left' || state.toolbarDock === 'right';
      const pct = state.elementMode ? 100 : 0;
      const finalTransform = verticalDock
        ? { xPercent: 0, yPercent: pct, x: 0, y: 0 }
        : { yPercent: 0, xPercent: pct, x: 0, y: 0 };
      gsapKill(modePill);
      if (o.instant || isReducedMotion() || !gsapReady) {
        if (gsapReady) {
          gsapSet(modePill, finalTransform);
        } else {
          modePill.style.transform = verticalDock
            ? ('translateY(' + pct + '%)')
            : ('translateX(' + pct + '%)');
        }
      } else {
        // Same 155ms timing as the CSS transition; Apple HIG ease.
        // Side-docked toolbars stack the mode toggle vertically.
        gsapLib.to(modePill, Object.assign({
          duration: 0.155,
          ease: EASE.apple,
          overwrite: true,
        }, finalTransform));
      }
    }
    updateSelectionPulse();
  }

  function setAnnotate(on, opts) {
    const o = opts || {};
    if (on) setElementMode(false);
    state.annotateOn = on;
    if (on && o.showCard !== false) showAnnotNoteCard();
    else hideAnnotNoteCard();
    applyMode();
    diagLog('mode', 'annotate=' + (on ? 1 : 0) + ' element=' + (state.elementMode ? 1 : 0));
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
      hideAnnotNoteCard(); // note card is annotate-only; committed note kept
      startHoverLoop();
    }
    applyMode();
    updateSelectionPulse();
    diagLog('mode', 'annotate=' + (state.annotateOn ? 1 : 0) + ' element=' + (on ? 1 : 0));
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

  /* ---- send energy pulse (comet-send-pulse) ---- */
  let sendPulseEl = null;
  let sendBusy = false; // in-flight guard: one annotate round-trip at a time
  let sendHideDoneTimer = 0; // display:none step of the send-away collapse

  // Radiate a subtle energy ring from the center of the Send button while
  // the annotation round-trip is in flight. The ring is anchored to the
  // shadow root with position:fixed (viewport coords from getBoundingClientRect)
  // so it can escape the button's overflow:hidden. Reduced motion skips it.
  function startSendPulse(button) {
    if (!button || !shadow || isReducedMotion()) return;
    if (sendPulseEl && sendPulseEl.parentNode) {
      gsapKill(sendPulseEl);
      sendPulseEl.remove();
    }
    const r = button.getBoundingClientRect();
    const el = document.createElement('span');
    el.className = 'comet-send-pulse';
    el.setAttribute('aria-hidden', 'true');
    el.style.left = Math.round(r.left + r.width / 2) + 'px';
    el.style.top = Math.round(r.top + r.height / 2) + 'px';
    shadow.appendChild(el);
    sendPulseEl = el;
    // Keep ring visual + class for CSS fallback; GSAP drives scale/opacity (~650ms).
    el.classList.add('comet-send-pulse-run');
    if (gsapReady) {
      gsapLib.fromTo(el,
        { opacity: 0.9, scale: 0.15 },
        {
          opacity: 0,
          scale: 15,
          duration: 0.65,
          ease: EASE.md3Emphasized,
          overwrite: true,
        });
    } else {
      playMotion(el, 'comet-send-pulse-run', 650);
    }
  }

  // Success lets the ring finish radiating; failure fades it out quickly so
  // it never reads as success.
  function endSendPulse(ok) {
    const el = sendPulseEl;
    sendPulseEl = null;
    if (!el || !el.parentNode) return;
    if (ok) {
      setTimeout(() => {
        gsapKill(el);
        if (el.parentNode) el.remove();
      }, 720);
    } else {
      el.classList.remove('comet-send-pulse-run');
      el.classList.add('comet-send-pulse-fail');
      if (gsapReady) {
        gsapKill(el);
        gsapLib.to(el, {
          opacity: 0,
          scale: 1.6,
          duration: 0.18,
          ease: EASE.md3Accelerate,
          overwrite: true,
          onComplete: () => { if (el.parentNode) el.remove(); },
        });
      } else {
        setTimeout(() => { if (el.parentNode) el.remove(); }, 240);
      }
    }
  }

  // Re-kick the in-flight ring once the capture-hide lifts: the host hide
  // (element sends) covered the ring's first radiation, and the toolbar
  // layout may have shifted under it, so re-anchor to the button's current
  // center and run the ring once more, fully visible. Failure keeps the
  // quick fade-out path (endSendPulse(false)) instead of a re-radiation.
  function restartSendPulse(button) {
    const el = sendPulseEl;
    if (!el || !el.parentNode || !button || isReducedMotion()) return;
    const r = button.getBoundingClientRect();
    el.style.left = Math.round(r.left + r.width / 2) + 'px';
    el.style.top = Math.round(r.top + r.height / 2) + 'px';
    el.classList.remove('comet-send-pulse-run', 'comet-send-pulse-fail');
    void el.offsetWidth;
    el.classList.add('comet-send-pulse-run');
    if (gsapReady) {
      gsapKill(el);
      gsapLib.fromTo(el,
        { opacity: 0.9, scale: 0.15 },
        {
          opacity: 0,
          scale: 15,
          duration: 0.65,
          ease: EASE.md3Emphasized,
          overwrite: true,
        });
    } else {
      playMotion(el, 'comet-send-pulse-run', 650);
    }
  }

  /* ---- send button hide/show (comet-send-away) ---- */
  function sendButtonEl() {
    return toolbar && toolbar.querySelector ? toolbar.querySelector('.comet-send') : null;
  }

  // Collapse the toolbar Send button away (scaleX/opacity/max-width -> 0,
  // then display:none). Called 2.5s after a successful send: nothing is left
  // to send, so the dead slot disappears with it.
  function hideSendButton() {
    const b = sendButtonEl();
    if (!b) return;
    if (sendHideTimer) { clearTimeout(sendHideTimer); sendHideTimer = 0; }
    if (isReducedMotion()) {
      b.classList.remove('comet-send-away');
      b.style.display = 'none';
      return;
    }
    b.classList.remove('comet-send-away');
    void b.offsetWidth;
    b.classList.add('comet-send-away');
    if (sendHideDoneTimer) clearTimeout(sendHideDoneTimer);
    sendHideDoneTimer = setTimeout(() => {
      sendHideDoneTimer = 0;
      if (b.classList.contains('comet-send-away')) b.style.display = 'none';
    }, 260);
  }

  // Bring the Send button back whenever new strokes/elements exist
  // (endStroke / updateCount). Cancels any pending collapse.
  function showSendButton() {
    if (sendHideTimer) { clearTimeout(sendHideTimer); sendHideTimer = 0; }
    if (sendHideDoneTimer) { clearTimeout(sendHideDoneTimer); sendHideDoneTimer = 0; }
    const b = sendButtonEl();
    if (!b) return;
    b.style.display = '';
    b.classList.remove('comet-send-away');
  }

  async function send(button) {
    if (sendBusy) return; // one annotate round-trip at a time
    sendBusy = true;
    if (button) playMotion(button, 'send-press', 100);
    startSendPulse(button);
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
      // Committed annotation notes from the chat card note mode (annotate
      // tool). 'note' stays for backward compatibility (queue joined, capped);
      // 'notes' ships the full queue (each entry capped).
      note: (state.annotNotes.length
        ? state.annotNotes.join(' | ')
        : state.annotNote || '').slice(0, MAX_TEXT),
      notes: state.annotNotes.slice(0, 20).map((n) => String(n).slice(0, MAX_TEXT)),
      strokes: state.strokes.map((s) => ({ color: s.color, width: s.width, points: s.points })),
      // v1.4: every selected descriptor carries its own instruction + edits.
      elements: state.elements.map(descriptorForPayload),
    };
    const captureRect = computeCaptureRect(state.elements);
    if (captureRect) payload.captureRect = captureRect;
    diagLastCaptureRect = captureRect;
    const sendStartMs = Date.now();
    diagLog('send:start', 'elements=' + state.elements.length
      + ' strokes=' + state.strokes.length
      + ' captureRect=' + (captureRect ? 'yes' : 'no'));
    setStatus('sending…', '');
    let ok = false;
    // Hide the tool surface (toolbar, chip, hover box, canvas) so the
    // captured screenshot shows only the page element, never the tool UI.
    // The inspector and chat card stay visible - they are the chrome the
    // user watches while the note sends. The SW captures before it
    // responds, so restoring after the round-trip is safe.
    let overlayHidden = false;
    // Hide the tool overlay ONLY when an element-only screenshot is being
    // captured (captureRect exists). For stroke-only sends there is no
    // capture, so the overlay must NOT blink out and the send pulse keeps
    // animating uninterrupted.
    try {
      if (captureRect && host && host.parentNode) {
        // Hide the tool surface so the capture shows only the page element.
        // The toolbar and its collapsed chip are draggable and can sit inside
        // the element crop, so they hide only when they actually intersect
        // the crop; otherwise they stay fully visible and never blink. The
        // hover box and canvas strokes always sit ON the element, so they
        // always hide. The inspector and chat card are the chrome the user
        // watches while the note sends and stay visible throughout.
        const toolbarTouchesCrop = (() => {
          const tb = host.querySelector('.comet-toolbar') ?? host.querySelector('.comet-chip');
          if (!tb) return false;
          const r = tb.getBoundingClientRect();
          return !(
            r.right < captureRect.x || r.left > captureRect.x + captureRect.w ||
            r.bottom < captureRect.y || r.top > captureRect.y + captureRect.h
          );
        })();
        host.dataset.capturing = toolbarTouchesCrop ? 'full' : 'partial';
        overlayHidden = true;
        // Flush the hide to the compositor BEFORE the SW captures: the SW
        // runs captureVisibleTab on message receipt, and without waiting for
        // a paint it can capture the overlay still visible. A double rAF
        // lands after the next compositor frame commit.
        if (typeof requestAnimationFrame === 'function') {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      }
    } catch (_) { /* overlay stays visible */ }
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'annotate', payload });
      ok = !!(resp && resp.ok);
      diagLog(ok ? 'send:ok' : 'send:fail',
        'latencyMs=' + (Date.now() - sendStartMs)
        + ' screenshot=' + (captureRect ? 'crop-requested' : 'n/a'));
    } catch (_) {
      ok = false;
      diagLog('send:fail',
        'latencyMs=' + (Date.now() - sendStartMs) + ' error=sendMessage threw');
    }
    try {
      if (overlayHidden && host) delete host.dataset.capturing;
    } catch (_) { /* ok */ }
    // The capture-hide covered the ring's first radiation (element sends):
    // re-kick it from the button's current center so the success moment shows
    // a full, aligned ring. Failure keeps the quick fade-out path instead.
    if (ok && overlayHidden) restartSendPulse(button);
    if (ok) {
      // Success: clear the status slot so it collapses (status:empty) and the
      // toolbar gap closes; the confirmation lives in the top-center toast.
      setStatus('', '');
      sendFeedback(button, true);
      endSendPulse(true);
      state.strokes = [];
      state.annotNote = ''; // next batch starts with a clean note
      state.annotNotes = []; // queued notes ship with the batch, then reset
      updateNoteCount();
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
      // Nothing left to send: let the button collapse away after 2.5s.
      sendHideTimer = setTimeout(hideSendButton, 2500);
    } else {
      setStatus(BRIDGE_OFFLINE, 'err');
      sendFeedback(button, false);
      endSendPulse(false);
    }
    sendBusy = false;
  }

  function onToolbarClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'power': fullExit(); break;
      case 'annotate': toggleAnnotate(); break;
      case 'element': toggleElement(); break;
      case 'color': cycleColor(); break;
      case 'undo': undo(); break;
      case 'clear': clearAll(); break;
      case 'send': send(btn); break;
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
  function renderToolbarDrag() {
    toolbarDragRaf = 0;
    if (!drag || !drag.surface) return;
    drag.surface.style.transform = 'translate3d(' + drag.dx + 'px,' + drag.dy + 'px,0)';
  }

  function startDrag(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left button only
    e.preventDefault();
    const target = e.currentTarget; // drag handle or the chip itself
    try { target.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }

    // Cancel delayed placement and keep the rendered dock class while moving.
    // A side-docked toolbar therefore stays vertical until the drop decides
    // whether to morph into a horizontal float or remain side-docked.
    toolbarDockLayoutToken += 1;
    stopToolbarOrientationMorph();
    const prevDock = state.toolbarDock || toolbarRenderedDock();
    if (prevDock) {
      state.toolbarDock = null;
      saveTabState({ toolbarDock: null });
    }

    const surface = state.collapsed && chipEl ? chipEl : toolbar;
    if (!surface) return;
    gsapKill(surface);
    gsapSet(surface, { clearProps: 'transform,x,y,scale,scaleX,scaleY' });
    surface.classList.add('comet-toolbar-dragging');
    const base = state.position || defaultPosition();
    drag = {
      target,
      surface,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: base.x,
      baseY: base.y,
      dx: 0,
      dy: 0,
      prevDock: prevDock || null,
      moved: false,
    };
    lastDragPersist = 0;
    target.classList.add('dragging');
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.dx = e.clientX - drag.startX;
    drag.dy = e.clientY - drag.startY;
    if (Math.abs(drag.dx) + Math.abs(drag.dy) > 4) drag.moved = true;

    // Pointer state is exact and unclamped. One compositor transform is
    // coalesced per frame; viewport clamping happens only after pointerup.
    state.position = {
      x: drag.baseX + drag.dx,
      y: drag.baseY + drag.dy,
    };
    if (!toolbarDragRaf && typeof requestAnimationFrame === 'function') {
      toolbarDragRaf = requestAnimationFrame(renderToolbarDrag);
    } else if (typeof requestAnimationFrame !== 'function') {
      renderToolbarDrag();
    }

    const now = Date.now();
    if (now - lastDragPersist >= DRAG_PERSIST_MS) {
      lastDragPersist = now;
      saveTabState({ position: state.position, toolbarDock: null });
    }
  }

  function endDrag(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
    const activeDrag = drag;
    try {
      if (activeDrag.target.hasPointerCapture(activeDrag.pointerId)) {
        activeDrag.target.releasePointerCapture(activeDrag.pointerId);
      }
    } catch (_) { /* ok */ }

    if (toolbarDragRaf) {
      cancelAnimationFrame(toolbarDragRaf);
      toolbarDragRaf = 0;
    }
    writeToolbarPosition(
      activeDrag.baseX + activeDrag.dx,
      activeDrag.baseY + activeDrag.dy
    );
    gsapKill(activeDrag.surface);
    gsapSet(activeDrag.surface, { clearProps: 'transform,x,y,scale,scaleX,scaleY' });
    activeDrag.surface.classList.remove('comet-toolbar-dragging');
    activeDrag.target.classList.remove('dragging');

    if (activeDrag.moved && activeDrag.target === chipEl) suppressChipClick = true;
    const moved = activeDrag.moved;
    const prevDock = activeDrag.prevDock || null;
    drag = null;
    if (moved) {
      // Edge drops snap with the existing travel tween. A free drop still
      // enters setToolbarDock so a retained vertical class can FLIP to row.
      const side = detectToolbarDock();
      if (side) setToolbarDock(side, { animate: true, persist: true });
      else setToolbarDock(null, { animate: true, persist: true });
    } else if (prevDock) {
      // A plain click on the handle keeps the prior dock and orientation.
      setToolbarDock(prevDock, { animate: false, persist: true });
    } else {
      saveTabState({ position: state.position, toolbarDock: state.toolbarDock });
    }
  }

  function onChipClick() {
    if (suppressChipClick) {
      suppressChipClick = false; // this click finished a drag, not a restore
      return;
    }
    setCollapsed(false); // click restores the full toolbar
  }

  function teardownHost() {
    stopInspectorRingTween();
    toolbarDockLayoutToken += 1;
    stopToolbarOrientationMorph();
    if (toolbarDragRaf) {
      cancelAnimationFrame(toolbarDragRaf);
      toolbarDragRaf = 0;
    }
    if (toolbar) gsapKill(toolbar);
    if (chipEl) gsapKill(chipEl);
    drag = null;
    diagDetach();
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
    inspDragHandle = null;
    inspDockEl = null;
    inspDrag = null;
    inspRows = null;
    inspCountEl = null;
    inspSelectionCountEl = null;
    inspSelectionList = null;
    inspResetAllBtn = null;
    inspInput = null;
    modeToggle = null;
    modePill = null;
    sentToastEl = null;
    if (sentToastTimer) clearTimeout(sentToastTimer);
    sentToastTimer = 0;
    if (sendHideTimer) clearTimeout(sendHideTimer);
    sendHideTimer = 0;
    if (sendHideDoneTimer) clearTimeout(sendHideDoneTimer);
    sendHideDoneTimer = 0;
    sendBusy = false;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = 0;
    if (revealPulseTimer) clearTimeout(revealPulseTimer);
    revealPulseTimer = 0;
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
    state.modeBeforeCollapse = null;
    state.position = null;
    state.toolbarDock = null;
    state.dock = null;
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
    if (inspDrag) {
      try {
        if (inspDragHandle && inspDragHandle.hasPointerCapture(inspDrag.pointerId)) {
          inspDragHandle.releasePointerCapture(inspDrag.pointerId);
        }
      } catch (_) { /* ok */ }
      if (inspPanel) inspPanel.classList.remove('dragging');
    }
    inspDrag = null;

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
    window.removeEventListener('mousedown', onPageMouseDown, true);
    window.removeEventListener('click', onPageClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('mouseup', endDrag);
    document.removeEventListener('scroll', repositionAll, true);
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('orientationchange', onWindowResize);
    saveTabState({ enabled: false }); // deactivation persists per tab
    try {
      chrome.storage.local.set({ toolEnabled: false }); // master switch stays off across refreshes
    } catch (_) { /* storage unavailable */ }

    // Premium smooth-out: reverse of the toolbar entrance. The whole host
    // (toolbar + chip + card) scales 0.98 -> 0.92 toward the toolbar's
    // position while fading and blurring (~230ms, MD3 Accelerate); teardown
    // runs only after the animation completes. Reduced motion / no GSAP ->
    // instant teardown, unchanged behavior.
    const doTeardown = () => {
      exitTimer = 0;
      teardownHost();
    };
    if (host && host.parentNode && !isReducedMotion() && gsapReady) {
      let origin = '50% 50%';
      if (toolbar) {
        try {
          const tb = toolbar.getBoundingClientRect();
          origin = Math.round(tb.left + tb.width / 2) + 'px ' +
                   Math.round(tb.top + tb.height / 2) + 'px';
        } catch (_) { /* keep center origin */ }
      }
      gsapKill(host);
      gsapSet(host, { transformOrigin: origin });
      host.style.transition = 'none'; // GSAP drives 1:1; host is removed after
      if (toolbar) toolbar.style.pointerEvents = 'none';
      exitTimer = 1; // guard: no double-run while the exit animation plays
      gsapLib.fromTo(host,
        { opacity: 1, scale: 0.98, filter: 'blur(0px)' },
        {
          opacity: 0,
          scale: 0.92,
          filter: 'blur(4px)',
          duration: 0.23,
          ease: EASE.md3Accelerate,
          overwrite: true,
          onComplete: doTeardown,
        });
    } else {
      doTeardown();
    }
  }

  // Idempotent re-injection (popup master switch ON / browserlinkToggle true).
  async function reinject() {
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
      await injectShadowStyles();
      diagAttach();
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
    // Toolbar edge dock is per-tab (null = floating). Apply before collapse so
    // the chip/toolbar land on the docked edge when restoring collapsed state.
    // Default dock: first run (no saved dock) pins the toolbar to the LEFT
    // edge, vertically centered with a DOCK_GAP_PX inset; a saved dock always
    // wins over the default. Applied instantly (animate: false); drag
    // re-docking keeps its animated snap via setToolbarDock(animate: true).
    const tbDock = st && st.toolbarDock;
    const dockSide = TOOLBAR_DOCK_SIDES.indexOf(tbDock) !== -1 ? tbDock : 'left';
    setToolbarDock(
      dockSide,
      { animate: false, persist: false }
    );
    setCollapsed(!!(st && st.collapsed));
    // Inspector dock is per-tab view state (null = floating popup).
    const dock = st && st.panelDock;
    state.dock = ['left', 'top', 'right', 'bottom'].indexOf(dock) !== -1 ? dock : null;
    updateDockUI();
    // Inspector category collapse is per-tab view state (default: all expanded).
    state.collapsedCats = (st && st.collapsedCats && typeof st.collapsedCats === 'object')
      ? Object.assign({}, st.collapsedCats)
      : {};
    // Inspector corner-resize size is per-tab view state; clamp it to the
    // current viewport (persisted value may predate a window resize).
    const isz = st && st.inspSize;
    if (inspPanel && isz && typeof isz.w === 'number' && typeof isz.h === 'number') {
      applyInspSize(isz.w, isz.h);
    } else {
      state.inspSize = null;
    }
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
    const finishEntered = () => {
      if (!host) return;
      host.classList.remove('is-entering');
      host.classList.add('is-entered');
    };
    if (isReducedMotion() || !gsapReady) {
      finishEntered();
      if (toolbar) gsapSet(toolbar, { opacity: 1, y: 0, scale: 1 });
      return;
    }
    // Toolbar fades/scales in as one unit, then its interactive children
    // stagger in 25-30ms each (Premium / MD3 Emphasized).
    const kids = toolbar
      ? Array.from(toolbar.children).filter((el) => el && el.nodeType === 1)
      : [];
    gsapEnter(host, {
      duration: 0.22,
      from: { opacity: 0, y: -6, scale: 1 },
      to: { opacity: 1, y: 0, scale: 1 },
      onComplete: finishEntered,
    });
    if (toolbar) {
      gsapEnter(toolbar, {
        duration: 0.28,
        from: { opacity: 0, y: -8, scale: 0.98 },
        to: { opacity: 1, y: 0, scale: 1 },
      });
    }
    if (kids.length) {
      gsapStaggerIn(kids, {
        duration: 0.2,
        stagger: 0.028,
        delay: 0.08,
        from: { opacity: 0, y: 6, scale: 0.96 },
        to: { opacity: 1, y: 0, scale: 1 },
      });
    }
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
    // Hide the unstyled/default-position frame. setToolbarDock reveals only
    // after shadow CSS, dock reflow, and final centering have completed.
    toolbar.style.visibility = 'hidden';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Browserlink - Browser Annotate & Connect');
    toolbar.innerHTML =
      '<button type="button" data-act="power" class="comet-btn comet-power" title="Deactivate Browserlink (removes everything from this page)">⏻</button>' +
      '<button type="button" data-act="collapse" class="comet-btn comet-collapse" title="Collapse to a floating chip">−</button>' +
      '<span class="comet-drag" data-act="drag" title="Drag to move. Drop near left, right, or bottom edge to dock.">⋮⋮</span>' +
      '<span class="comet-mode-toggle" role="group" aria-label="Mode">' +
      '  <span class="comet-mode-pill" aria-hidden="true"></span>' +
      '  <button type="button" data-act="annotate" class="comet-btn comet-mode-btn" title="Toggle drawing" aria-label="Annotate">✎</button>' +
      '  <button type="button" data-act="element" class="comet-btn comet-mode-btn" title="Element picker: hover to highlight, click to select + instruct" aria-label="Element">▣</button>' +
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
      '<span class="comet-note-count" data-act="count" title="Queued annotation notes" hidden></span>' +
      '<button type="button" data-act="undo" class="comet-btn comet-icon-btn" title="Undo" aria-label="Undo">↩</button>' +
      '<button type="button" data-act="clear" class="comet-btn comet-icon-btn" title="Clear" aria-label="Clear">✕</button>' +
      '<button type="button" data-act="send" class="comet-btn comet-send comet-icon-btn" title="Send" aria-label="Send">➤</button>' +
      '<span class="status"></span>';
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
    chipEl.style.visibility = 'hidden';
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

    // Element inspector panel: floating popup near the selected element
    // (draggable via the header handle) or docked to a viewport edge.
    inspPanel = document.createElement('div');
    inspPanel.className = 'comet-inspector';
    inspPanel.hidden = true;
    inspPanel.innerHTML =
      '<div class="comet-insp-head">' +
      '  <span class="comet-insp-drag" title="Drag to move">⋮⋮</span>' +
      '  <span class="comet-insp-title">Element inspector</span>' +
      '  <span class="comet-dock" role="group" aria-label="Dock inspector to a screen edge">' +
      '    <button type="button" class="comet-dock-btn" data-dock="left" title="Dock left">◀</button>' +
      '    <button type="button" class="comet-dock-btn" data-dock="top" title="Dock top">▲</button>' +
      '    <button type="button" class="comet-dock-btn" data-dock="right" title="Dock right">▶</button>' +
      '    <button type="button" class="comet-dock-btn" data-dock="bottom" title="Dock bottom">▼</button>' +
      '  </span>' +
      '</div>' +
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
      '  <button type="button" class="comet-btn comet-insp-add">Add</button>' +
      '</div>' +
      '<div class="comet-insp-glow" aria-hidden="true"></div>' +
      '<div class="comet-insp-resize" title="Resize inspector"></div>';

    sentToastEl = document.createElement('div');
    sentToastEl.className = 'comet-sent-toast';
    sentToastEl.setAttribute('aria-hidden', 'true');
    sentToastEl.hidden = true;
    sentToastEl.textContent = 'Sent ✓';

    shadow.appendChild(toolbar);
    shadow.appendChild(chipEl);
    shadow.appendChild(selLayer);
    selLayer.appendChild(hlEl);
    selLayer.appendChild(hoverBoxEl);
    shadow.appendChild(canvas);
    shadow.appendChild(chatCard);
    shadow.appendChild(inspPanel);
    shadow.appendChild(sentToastEl);

    // Diagnostics overlay (Ctrl+Shift+D to toggle). Sits inside the shadow
    // root so the host hide during capture hides it too. Hidden by default:
    // closed it never blocks element picking.
    diagPanel = document.createElement('div');
    diagPanel.className = 'comet-diag';
    diagPanel.hidden = true;
    diagPanel.innerHTML =
      '<div class="comet-diag-head">' +
      '<span class="comet-diag-title">Browserlink diag</span>' +
      '<button type="button" class="comet-diag-btn comet-diag-copy">Copy</button>' +
      '<button type="button" class="comet-diag-btn comet-diag-close">Close</button>' +
      '</div>' +
      '<pre class="comet-diag-body"></pre>';
    const diagCopyBtn = diagPanel.querySelector('.comet-diag-copy');
    if (diagCopyBtn) diagCopyBtn.addEventListener('click', diagCopyToClipboard);
    const diagCloseBtn = diagPanel.querySelector('.comet-diag-close');
    if (diagCloseBtn) diagCloseBtn.addEventListener('click', diagClosePanel);
    shadow.appendChild(diagPanel);
    diagPanelOpen = false;

    ctx = canvas.getContext('2d');

    // ONE shadow host on the page; nothing else touches the page DOM.
    document.documentElement.appendChild(host);

    statusEl = toolbar.querySelector('.status');
    countEl = toolbar.querySelector('.comet-count');
    noteCountEl = toolbar.querySelector('.comet-note-count');
    chatHead = chatCard.querySelector('.comet-chat-head');
    chatInput = chatCard.querySelector('.comet-chat-input');
    inspRows = inspPanel.querySelector('.comet-insp-rows');
    inspCountEl = inspPanel.querySelector('.comet-insp-count');
    inspSelectionCountEl = inspPanel.querySelector('.comet-selection-count');
    inspSelectionList = inspPanel.querySelector('.comet-selection-list');
    inspResetAllBtn = inspPanel.querySelector('.comet-insp-reset-all');
    inspInput = inspPanel.querySelector('.comet-insp-instr');
    inspAddEl = inspPanel.querySelector('.comet-insp-add');
    inspGlowEl = inspPanel.querySelector('.comet-insp-glow');
    inspResizeHandle = inspPanel.querySelector('.comet-insp-resize');
    inspDragHandle = inspPanel.querySelector('.comet-insp-drag');
    inspDockEl = inspPanel.querySelector('.comet-dock');
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
        '.comet-icon-btn{min-width:32px;width:32px;box-sizing:border-box;padding:4px 0;text-align:center;' +
        'font-size:15px;line-height:1.15;letter-spacing:0;}' +
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
        '.comet-note-count{min-width:40px;text-align:center;font-size:12px;color:#9aa0a6;white-space:nowrap;}' +
        '.comet-note-count[hidden]{display:none;}' +
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
        '.comet-inspector{position:fixed;z-index:2147483647;width:320px;max-width:calc(100vw - 24px);' +
        'max-height:60vh;display:flex;flex-direction:column;gap:8px;padding:10px;' +
        'background:var(--bl-bg,rgba(16,18,24,.95));border:1px solid var(--bl-border,rgba(255,255,255,.16));' +
        'border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:13px/1.4 system-ui;' +
        'color:var(--bl-text,#e8eaed);pointer-events:auto;user-select:none;}' +
        '.comet-inspector[hidden]{display:none;}' +
        '.comet-insp-head{display:flex;align-items:center;gap:6px;font-size:12px;color:#9aa0a6;border-bottom:1px solid rgba(255,255,255,.14);padding-bottom:6px;}' +
        '.comet-insp-drag{flex:0 0 auto;cursor:grab;padding:1px 5px;color:#9aa0a6;touch-action:none;}' +
        '.comet-insp-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.comet-dock{flex:0 0 auto;display:inline-flex;gap:2px;}' +
        '.comet-dock-btn{appearance:none;width:18px;height:18px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:4px;background:rgba(255,255,255,.06);color:#9aa0a6;font:9px/1 system-ui;cursor:pointer;}' +
        '.comet-dock-btn.active{background:#4a9eff;border-color:#4a9eff;color:#fff;}' +
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
        '.comet-selection-main{display:flex;flex-direction:column;align-items:flex-start;gap:2px;}' +
        '.comet-selection-note{display:block;font-size:10px;color:#9aa0a6;font-weight:400;' +
        'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
        '.comet-diag{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:min(420px,calc(100vw - 24px));' +
        'max-height:40vh;display:flex;flex-direction:column;background:rgba(10,12,16,.96);' +
        'border:1px solid rgba(255,255,255,.16);border-radius:10px;color:#e8eaed;' +
        'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:auto;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.45);}' +
        '.comet-diag[hidden]{display:none;}' +
        '.comet-diag-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.12);}' +
        '.comet-diag-title{flex:1;font-weight:600;letter-spacing:.02em;}' +
        '.comet-diag-btn{background:rgba(255,255,255,.08);color:#e8eaed;border:1px solid rgba(255,255,255,.16);' +
        'border-radius:5px;font:11px ui-monospace,Menlo,Consolas,monospace;padding:2px 8px;cursor:pointer;}' +
        '.comet-diag-btn:hover{background:rgba(255,255,255,.16);}' +
        '.comet-diag-body{flex:1;overflow:auto;max-height:calc(40vh - 30px);margin:0;padding:8px;' +
        'white-space:pre-wrap;word-break:break-word;color:#9aa0a6;}';
    }
    style.textContent = css;
    shadow.appendChild(style);
  }

  /* ---------------- wiring ---------------- */
  function onWindowResize() {
    resizeCanvas();
    repositionAll();
    // Re-center a docked toolbar/chip; otherwise re-clamp the floating position.
    if (state.toolbarDock) {
      const target = dockedToolbarPosition(state.toolbarDock);
      applyPosition(target.x, target.y);
    } else if (state.position) {
      applyPosition(state.position.x, state.position.y);
    }
    // Re-anchor the inspector: docked panels stay glued to their edge.
    if (inspPanel && !inspPanel.hidden) {
      if (state.dock) applyDock();
      else positionInspector();
    }
    // Re-clamp a persisted inspector size to the new viewport.
    if (state.inspSize) applyInspSize(state.inspSize.w, state.inspSize.h);
  }

  function bindEvents() {
    toolbar.addEventListener('click', onToolbarClick);
    toolbar.addEventListener('change', onToolbarChange);
    // Keep extension field keystrokes from bubbling into host-page shortcuts.
    shadow.addEventListener('keydown', (e) => e.stopPropagation());
    dragHandle.addEventListener('pointerdown', startDrag);
    dragHandle.addEventListener('pointermove', onDragMove);
    dragHandle.addEventListener('pointerup', endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);
    dragHandle.addEventListener('lostpointercapture', endDrag);
    chipEl.addEventListener('pointerdown', startDrag);
    chipEl.addEventListener('pointermove', onDragMove);
    chipEl.addEventListener('pointerup', endDrag);
    chipEl.addEventListener('pointercancel', endDrag);
    chipEl.addEventListener('lostpointercapture', endDrag);
    // Safety net: a capture that is lost or an up that lands elsewhere must
    // never leave the toolbar glued to the cursor.
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('mouseup', endDrag);
    chipEl.addEventListener('click', onChipClick);
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke); // spec: handle pointercancel
    chatCard.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-chat]') : null;
      if (!b) return;
      if (b.dataset.chat === 'add') {
        if (pending) addChat();
        else if (state.annotateOn && !state.elementMode) commitAnnotNote();
      } else if (b.dataset.chat === 'cancel') {
        if (pending) cancelChat();
        else if (state.annotateOn && !state.elementMode) hideAnnotNoteCard();
      }
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
    if (inspAddEl) {
      inspAddEl.addEventListener('click', () => {
        if (pending) addChat();
      });
    }
    if (inspDragHandle) {
      inspDragHandle.addEventListener('pointerdown', startInspDrag);
      inspDragHandle.addEventListener('pointermove', onInspDragMove);
      inspDragHandle.addEventListener('pointerup', endInspDrag);
      inspDragHandle.addEventListener('pointercancel', endInspDrag);
    }
    if (inspResizeHandle) {
      inspResizeHandle.addEventListener('pointerdown', startInspResize);
      inspResizeHandle.addEventListener('pointermove', onInspResizeMove);
      inspResizeHandle.addEventListener('pointerup', endInspResize);
      inspResizeHandle.addEventListener('pointercancel', endInspResize);
    }
    if (inspPanel) {
      inspPanel.addEventListener('pointermove', onInspPointerMove);
      inspPanel.addEventListener('pointerenter', onInspPointerEnter);
      inspPanel.addEventListener('pointerleave', onInspPointerLeave);
    }
    if (inspDockEl) inspDockEl.addEventListener('click', onDockClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onPageMouseDown, true);
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
    diagLog('init:start', 'url=' + location.href);
    try {
      updateMotionPreference();
      registerInspectorRingProperty();
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
        diagLog('init:skip', 'disabled by master switch');
        return;
      }
      buildUI();
      bindEvents();
      await injectShadowStyles();
      restoreTabState(st);
      diagAttach();
      const health = diagHealth(true);
      diagLog('init:done',
        'ready=' + (health.ok ? 'yes' : 'no')
        + ' gsap=' + (gsapReady ? 'yes' : 'no')
        + ' dpr=' + (Number(window.devicePixelRatio) || 1));
    } catch (err) {
      // Never break the host page.
      try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (_) { /* ok */ }
      window.__hermesAnnotateInjected = false;
      window.__browserlinkInjected = false;
      diagLog('init:fail', (err && err.message) ? err.message : String(err));
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
      onPageMouseDown,
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
