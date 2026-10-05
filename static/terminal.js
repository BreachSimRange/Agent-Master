/* Terminal cells (xterm.js): one primary terminal plus up to two pinned ones side by side. */
'use strict';

const Terms = (() => {
  const MAX = 3;
  const NO_WEBGL = new URLSearchParams(location.search).has('nowebgl');
  const cells = new Map();   // pane_id -> {term, fit, el, pinned, title}
  let primary = null, grid;
  const handlers = { paste() {}, data() {}, change() {}, top() {}, resize() {}, menu() {}, copied() {}, history() {}, buffer() {}, reset() {} };
  const THEMES = {
    dark: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78', black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5' },
    light: { background: '#ffffff', foreground: '#333333', cursor: '#333333', selectionBackground: '#add6ff', black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555', brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' },
  };
  let THEME = THEMES.dark;

  // clipboard: the async API where the page is a secure context (HTTPS or localhost), a hidden textarea otherwise
  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { } ta.remove(); return ok;
  }
  async function readClipboard() {
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) return await navigator.clipboard.readText(); } catch (e) { }
    return null;
  }
  function imageFiles(dt) { return dt ? [...(dt.files || [])].filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type)) : []; }
  function make(pid, title) {
    const el = document.createElement('div'); el.className = 'term-cell';
    el.innerHTML = `<div class="term-head"><span class="term-title"></span><span class="term-actions"><span class="term-btn pin" title="Keep this terminal open when switching">pin</span><span class="term-btn close" title="Close this terminal">✕</span></span></div><div class="term-host"></div><span class="term-hist" hidden title="A fullscreen program keeps its own view, so the conversation cannot sit in this scrollback: open it as a page"></span>`;
    el.querySelector('.term-title').textContent = title || pid;
    // windowsMode: xterm must not reflow wrapped lines when the grid changes size. A real terminal never does; the program
    // repaints itself on the size change. With reflow on, Claude Code's own cursor moves land on the wrong rows after a
    // resize and old output turns into a staircase of single words.
    const term = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, windowsMode: true, fontFamily: getComputedStyle(document.body).getPropertyValue("--mono"), scrollback: 200000, theme: THEME, allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true });
    const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
    const ser = new SerializeAddon.SerializeAddon(); term.loadAddon(ser);
    term.open(el.querySelector('.term-host'));
    let renderer = 'dom';
    try {   // the WebGL renderer keeps a 100x50 terminal at 20 repaints a second off the main thread; the DOM renderer cannot on a laptop
      if (typeof WebglAddon !== 'undefined' && !NO_WEBGL) { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => { try { gl.dispose(); } catch (e) { } renderer = 'dom'; }); term.loadAddon(gl); renderer = 'webgl'; }
    } catch (e) { renderer = 'dom'; }
    const rendererOf = () => renderer;
    term.onData(d => handlers.data(pid, d));
    // Programs that use the mouse (Claude Code's fullscreen view scrolls its history with the wheel) get mouse events;
    // Shift+drag still selects text then. Text a program copies itself arrives as OSC 52 and goes to the clipboard.
    try {
      term.parser.registerOscHandler(52, data => {
        const i = data.indexOf(';'), b64 = i >= 0 ? data.slice(i + 1) : data;
        if (!b64 || b64 === '?') return true;   // a request to read the clipboard: never answered
        try { const bin = atob(b64), bytes = Uint8Array.from(bin, c => c.charCodeAt(0)), text = new TextDecoder().decode(bytes); copyText(text).then(ok => handlers.copied(pid, ok, text.length)); } catch (e) { }
        return true;
      });
    } catch (e) { }
    const copySelection = () => { const t = term.getSelection(); if (!t) return false; copyText(t).then(ok => handlers.copied(pid, ok, t.length)); term.clearSelection(); return true; };
    const pasteClipboard = async () => { const t = await readClipboard(); if (t == null) { handlers.copied(pid, null); return; } term.paste(t); term.focus(); };
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return !(ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === 'v' || ev.key === 'V'));
      const k = (ev.key || '').toLowerCase();
      // copy: Ctrl+Shift+C always, Ctrl+C only while text is selected (otherwise it stays the interrupt key)
      if (ev.ctrlKey && !ev.altKey && k === 'c' && (ev.shiftKey || term.hasSelection())) { ev.preventDefault(); copySelection(); return false; }
      if (ev.ctrlKey && ev.shiftKey && k === 'v') { ev.preventDefault(); pasteClipboard(); return false; }
      // Ctrl+V must reach the browser as a real paste (xterm would send \x16 instead); the paste event below then takes images, xterm takes text
      return !(ev.ctrlKey && !ev.altKey && !ev.metaKey && (k === 'v' || (ev.key === 'Insert' && ev.shiftKey)));
    });
    // A plain left drag always selects text, even when the program uses the mouse (Claude Code's fullscreen view):
    // the press is re-sent with the modifier that makes xterm select (Shift, or Option on a Mac). The wheel is untouched.
    const host = el.querySelector('.term-host'), MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    let selecting = false;
    host.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      selecting = true;
      if (!e.isTrusted || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || term.modes.mouseTrackingMode === 'none') return;
      e.stopImmediatePropagation(); e.preventDefault();
      e.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, detail: e.detail, screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY, button: 0, buttons: 1, shiftKey: !MAC, altKey: MAC }));
    }, true);
    // copy on select: done inside the mouse release so every browser allows the clipboard write
    window.addEventListener('mouseup', e => {
      if (!selecting || e.button !== 0) return;
      selecting = false;
      const t = term.getSelection();
      if (t && t.trim()) copyText(t).then(ok => handlers.copied(pid, ok, t.length, e.clientX, e.clientY));
    }, true);
    host.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      handlers.menu(pid, e.clientX, e.clientY, { hasSelection: term.hasSelection(), mouseApp: term.modes.mouseTrackingMode !== 'none', copy: copySelection, paste: pasteClipboard, selectAll: () => term.selectAll(), clear: () => term.clearSelection() });
    });
    // images pasted or dropped into the terminal go to the handler (uploaded and typed in as a path); text keeps xterm's own paste
    el.addEventListener('paste', e => { const f = imageFiles(e.clipboardData); if (f.length) { e.preventDefault(); e.stopPropagation(); handlers.paste(pid, f); } }, true);
    el.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', e => { el.classList.remove('drop'); const f = imageFiles(e.dataTransfer); if (f.length) { e.preventDefault(); e.stopPropagation(); handlers.paste(pid, f); } });
    const cell = { term, fit, el, ser, rendererOf, pid, pinned: false, title: title || pid, history: null, loadingOlder: false, natural: null, pty: null, scaled: false };
    term.onScroll(y => { if (cell.redrawing) return; if (y === 0 && cell.history && term.buffer.active.length > term.rows && !cell.loadingOlder) { cell.loadingOlder = true; handlers.top(pid); } });
    el.querySelector('.pin').onclick = () => { cell.pinned = !cell.pinned; el.classList.toggle('pinned', cell.pinned); if (!cell.pinned && pid !== primary) remove(pid); handlers.change(); };
    el.querySelector('.close').onclick = () => { if (pid === primary) { cell.pinned = false; } remove(pid); if (pid === primary) { primary = [...cells.keys()][0] || null; } handlers.change(); };
    el.querySelector('.term-hist').onclick = e => { e.stopPropagation(); handlers.history(pid); };
    try { term.buffer.onBufferChange(b => handlers.buffer(pid, b.type)); } catch (e) { }   // a program entering or leaving its fullscreen view
    el.querySelector('.term-head').onclick = e => { if (!e.target.classList.contains('term-btn')) { primary = pid; refresh(); handlers.change(); } };
    grid.appendChild(el); cells.set(pid, cell);
    return cell;
  }
  function remove(pid) { const c = cells.get(pid); if (!c) return; c.term.dispose(); c.el.remove(); cells.delete(pid); }
  function refresh() {
    cells.forEach((c, pid) => c.el.classList.toggle('primary', pid === primary));
    grid.classList.toggle('multi', cells.size > 1);
    setTimeout(fitAll, 30);
  }
  function show(pid, title) {
    if (!pid) return;
    if (pid === primary && cells.has(pid)) { if (title) setTitle(pid, title); return; }
    const prev = primary;
    if (prev && prev !== pid) { const pc = cells.get(prev); if (pc && !pc.pinned) remove(prev); }
    primary = pid;
    if (!cells.has(pid)) { if (cells.size >= MAX) { const victim = [...cells.entries()].find(([k, c]) => !c.pinned && k !== pid) || [...cells.entries()][0]; remove(victim[0]); } make(pid, title); }
    else if (title) setTitle(pid, title);
    refresh(); handlers.change();
  }
  function pin(pid, title) {
    if (!cells.has(pid)) { if (cells.size >= MAX) return false; make(pid, title); }
    const c = cells.get(pid); c.pinned = true; c.el.classList.add('pinned'); if (!primary) primary = pid; refresh(); handlers.change(); return true;
  }
  function setTitle(pid, title) { const c = cells.get(pid); if (c) { c.title = title; c.el.querySelector('.term-title').textContent = title; } }
  function fullRedraw(c, grownHint) {
    // The transcript sits entirely in scrollback, the live screen below it: capture the current screen, rebuild the
    // scrollback, push it up with `rows` newlines, then put the screen back at the top.
    const b = c.term.buffer.active, atBottom = b.viewportY >= b.baseY - 1, viewport = b.viewportY, before = b.length;
    const rows = c.term.rows || 24;
    // a raw pty terminal has no newline conversion: each transcript line needs its carriage return, and is cleared to the edge
    const head = c.history ? (c.history + '\n').replace(/\r?\n/g, '\x1b[K\r\n') : '';
    c.redrawing = true;   // reset() clamps the DOM viewport to 0 and that stale scroll event arrives late: ignore scroll events and re-assert the position once settled
    // xterm parses writes asynchronously while reset() is immediate: the replay may still be queued when the transcript
    // arrives, and painting now would reset first, let the replay paint, and drop the transcript at the prompt.
    // An empty write's callback runs once everything queued before it has been parsed: capture the screen and reset only then.
    c.term.write('', () => {
      let screen = '';
      try { screen = c.ser.serialize({ scrollback: 0 }); } catch (e) { screen = ''; }
      c.term.reset();
      c.term.write(head + '\n'.repeat(rows) + '\x1b[1;1H' + screen, () => {
        c.laidOut = true;
        const grown = grownHint == null ? c.term.buffer.active.length - before : grownHint;
        const place = () => { if (atBottom) c.term.scrollToBottom(); else c.term.scrollToLine(Math.max(0, viewport + Math.max(0, grown))); };
        place();
        requestAnimationFrame(() => setTimeout(() => { place(); c.redrawing = false; c.loadingOlder = false; }, 60));
      });
    });
  }
  // new transcript entries go straight into the scrollback above the live screen: write them at the top of the
  // screen followed by the screen itself, so the screen scrolls up by exactly that many lines. Costs the size of the
  // new entries only, instead of rewriting the whole history (which stalled the page for seconds on long sessions).
  function appendHistory(pid, text) {
    const c = cells.get(pid); if (!c || !text) return false;
    if (!c.laidOut || !c.history) return false;
    if (c.term.buffer.active.type === 'alternate') return false;   // a fullscreen program owns the whole buffer
    c.history += '\n' + text;
    let screen = '';
    try { screen = c.ser.serialize({ scrollback: 0 }); } catch (e) { return false; }
    const b = c.term.buffer.active, atBottom = b.viewportY >= b.baseY - 1;
    const lines = text.replace(/\r/g, '').split('\n').map(l => l + '\x1b[K').join('\r\n');
    c.term.write('\x1b[1;1H' + lines + '\r\n' + screen, () => { if (atBottom) c.term.scrollToBottom(); });
    return true;
  }
  function setHistory(pid, text) {
    const c = cells.get(pid); if (!c || c.history === text) return;
    if (c.term.buffer.active.type === 'alternate') return;   // a fullscreen program owns the whole buffer
    c.history = text; fullRedraw(c);
  }
  // bytes go straight into xterm, which parses and paints them on its own schedule
  // ESC c (RIS) is what a restarted process starts with: xterm drops the whole buffer, transcript included, so the
  // cell forgets its history and asks for it again once the reset has been parsed
  function hasReset(bytes) { for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x1b && bytes[i + 1] === 0x63) return true; return false; }
  function raw(pid, bytes) {
    const c = cells.get(pid); if (!c) return;
    if (c.history && hasReset(bytes)) c.term.write(bytes, () => { if (cells.get(pid) === c) { c.history = null; handlers.reset(pid); } });
    else c.term.write(bytes);
  }
  function reset(pid) { const c = cells.get(pid); if (c) { c.term.reset(); c.term.clear(); } }
  function size(pid) { const c = cells.get(pid); if (!c) return { cols: 80, rows: 24 }; return c.natural || naturalOf(c) || { cols: c.term.cols || 80, rows: c.term.rows || 24 }; }
  // the chip on a fullscreen program's cell that opens the conversation as a page (null hides it)
  function setHistoryNote(pid, text) { const c = cells.get(pid); if (!c) return; const n = c.el.querySelector('.term-hist'); n.textContent = text || ''; n.hidden = !text; }
  function bufferType(pid) { const c = cells.get(pid); return c ? c.term.buffer.active.type : null; }
  function doneLoading(pid) { const c = cells.get(pid); if (c) c.loadingOlder = false; }
  function scrollToTop(pid) { const c = cells.get(pid || primary); if (c) c.term.scrollToTop(); }
  // ── a cell renders the pty's real grid ──
  // The server sizes the pty from every viewer: consoles set it (a real terminal has one font size), browsers adapt.
  // This cell reports what fits it at the normal font (its natural size) and renders the pty's grid: at the natural
  // size when they agree, otherwise the bigger grid at a smaller font (never below 9 px), swiping sideways when even
  // that is too wide. Font size instead of a CSS transform, so the text stays crisp on a phone.
  const BASE_FONT = 13;
  let MIN_FONT = 6;   // shrinking on: the text goes as small as the width needs (6 px hard floor); Settings "never shrink" makes it BASE_FONT and the cell scrolls instead
  function setShrink(on) { MIN_FONT = on ? 6 : BASE_FONT; cells.forEach(c => layout(c)); }
  function proposeExact(c) { try { const d = c.fit.proposeDimensions(); if (d && d.cols > 1 && d.rows > 0) return { cols: d.cols, rows: d.rows }; } catch (e) { } return null; }
  function naturalOf(c) {   // what fits this cell at the normal font
    const host = c.el.querySelector('.term-host'), cur = c.term.options.fontSize || BASE_FONT;
    if (cur === BASE_FONT) { const cs = cellSize(c.term); if (cs) c.baseCell = cs; return proposeExact(c); }   // exact: measured at the normal font
    const key = host ? host.clientWidth + 'x' + host.clientHeight : '';
    if (c.natural && c.hostKey === key) return c.natural;   // shrunk font, nothing moved: the fit is what it was
    if (c.baseCell && host) return { cols: Math.max(20, Math.floor((host.clientWidth - 10) / c.baseCell.w)), rows: Math.max(5, Math.floor((host.clientHeight - 6) / c.baseCell.h)) };   // estimate from the normal-font cell size
    return proposeExact(c);
  }
  function layout(c) {
    const host = c.el.querySelector('.term-host'), cur = c.term.options.fontSize || BASE_FONT;
    const nat = naturalOf(c); if (!nat) return;
    c.hostKey = host ? host.clientWidth + 'x' + host.clientHeight : '';
    if (!c.natural || c.natural.cols !== nat.cols || c.natural.rows !== nat.rows) { c.natural = nat; handlers.resize(c.pid, nat.cols, nat.rows); }
    const pty = c.pty, grid = pty ? { cols: Math.max(pty.cols, nat.cols), rows: Math.max(pty.rows, nat.rows) } : nat;
    c.scaled = grid.cols > nat.cols || grid.rows > nat.rows;
    if (!c.scaled) {
      if (host) host.classList.remove('pan');
      if (cur !== BASE_FONT) { c.term.options.fontSize = BASE_FONT; setTimeout(() => { if (cells.get(c.pid) === c) layout(c); }, 60); return; }   // back at the normal font: measure exactly, then size
    }
    if (c.term.cols !== grid.cols || c.term.rows !== grid.rows) { try { c.term.resize(grid.cols, grid.rows); } catch (e) { } }
    if (c.scaled) {   // xterm re-measures its cells asynchronously after a resize or a font change: apply now and again shortly after
      applyScale(c, grid);
      [60, 250, 600, 1200].forEach(ms => setTimeout(() => { if (c.scaled && cells.get(c.pid) === c) applyScale(c, grid); }, ms));
    }
  }
  function cellSize(term) {   // css pixels per character cell, from whichever place this xterm build keeps them
    const rs = term._core && term._core._renderService, d = rs && rs.dimensions;
    if (d && d.css && d.css.cell && d.css.cell.width) return { w: d.css.cell.width, h: d.css.cell.height };
    if (d && d.actualCellWidth) return { w: d.actualCellWidth, h: d.actualCellHeight };
    const el = term.element && term.element.querySelector('.xterm-screen');
    if (el && el.clientWidth && term.cols) return { w: el.clientWidth / term.cols, h: el.clientHeight / term.rows };
    return null;
  }
  function applyScale(c, grid) {
    try {
      const host = c.el.querySelector('.term-host'), term = c.term;
      const availW = host.clientWidth - 10, availH = host.clientHeight - 6;
      if (availW < 40 || availH < 20) return;
      const cur = term.options.fontSize || BASE_FONT;
      const base = c.baseCell || (() => { const cs = cellSize(term); return cs ? { w: cs.w / cur * BASE_FONT, h: cs.h / cur * BASE_FONT } : null; })();
      if (!base) return;
      // base.w / BASE_FONT is pixels per font point, so availW / (that * cols) is the font at which the width fits.
      // The WIDTH always fits (no sideways scrolling, ever); rows that do not fit scroll vertically instead of shrinking the text further.
      let size = MIN_FONT >= BASE_FONT ? BASE_FONT : Math.max(6, Math.min(BASE_FONT, Math.floor(availW / (base.w / BASE_FONT * grid.cols) * 2) / 2));
      const screen = term.element && term.element.querySelector('.xterm-screen');
      // glyph widths round per font size, so check the real rendered width and go down half a point until it truly fits
      if (screen && size === cur && screen.clientWidth > availW + 2 && size > 6 && MIN_FONT < BASE_FONT) size -= 0.5;
      if (Math.abs(size - cur) >= 0.5) term.options.fontSize = size;
      const fitsW = screen && size === cur ? screen.clientWidth <= availW + 2 : (base.w / BASE_FONT * size) * grid.cols <= availW + 2;
      const fitsH = (base.h / BASE_FONT * size) * grid.rows <= availH + 2;
      const wasPan = host.classList.contains('pan');
      host.classList.toggle('pan', !fitsW || !fitsH);   // even at the smallest font the grid is bigger than the cell: it scrolls
      if ((!fitsW || !fitsH) && !wasPan) {   // only when scrolling starts (never yank a viewer who scrolled): show the cursor, where the prompt lives
        // the buffer takes its new height a moment after the resize, so the cursor position is read again once it has settled
        const toCursor = () => { if (cells.get(c.pid) !== c) return; const b = term.buffer.active, cw = base.w / BASE_FONT * size, ch = base.h / BASE_FONT * size, cx = (b.cursorX || 0) * cw, cy = (b.baseY + (b.cursorY || 0)) * ch;
          host.scrollTop = Math.max(0, cy - host.clientHeight + ch * 2); host.scrollLeft = cx > host.clientWidth - 40 ? Math.max(0, cx - host.clientWidth / 2) : 0; };
        [80, 400].forEach(ms => setTimeout(toCursor, ms));
      }
    } catch (e) { }
  }
  function setGrid(pid, cols, rows) {   // the pty's current size, from the server
    const c = cells.get(pid); if (!c) return;
    const pty = cols > 0 && rows > 0 ? { cols: cols | 0, rows: rows | 0 } : null;
    const same = (!c.pty && !pty) || (c.pty && pty && c.pty.cols === pty.cols && c.pty.rows === pty.rows);
    if (same) return;
    c.pty = pty; layout(c);
  }
  function fitAll() { cells.forEach(c => layout(c)); }
  function init(el) { grid = el; new ResizeObserver(() => fitAll()).observe(grid); }
  function setTheme(name) { THEME = THEMES[name] || THEMES.dark; cells.forEach(c => { c.term.options.theme = THEME; }); }
  return { init, show, pin, raw, reset, setHistory, setHistoryNote, bufferType, doneLoading, scrollToTop, setTitle, fitAll, remove, setTheme, size, appendHistory, setGrid, setShrink, renderer: pid => { const c = cells.get(pid || primary); return c ? c.rendererOf() : null; }, cell: pid => cells.get(pid || primary), on(n, f) { handlers[n] = f; }, ids: () => [...cells.keys()], get primary() { return primary; }, has: pid => cells.has(pid), isPinned: pid => !!(cells.get(pid) || {}).pinned, focus: pid => { const c = cells.get(pid || primary); if (c) c.term.focus(); } };
})();
