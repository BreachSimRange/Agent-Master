/* Pixel office: responsive map (office : lounge = 60 : 40), sprites, behaviour, balloons, visits, chat, TV, table tennis. */
'use strict';

const Office = (() => {
  const T = 16, NDESKS = 12, VX = T, VY = T, LOUNGE_SHARE = 0.4;
  const PLANS = {
    full: { rows: 14, deskRows: [4, 9], perRow: 6, kitchenY: 11, door: [6, 9], aisles: [6.3, 7.4, 11.6, 12.4], minOffice: 26, orient: 'wide' },
    compact: { rows: 9, deskRows: [4], perRow: 12, kitchenY: 6, door: [4, 7], aisles: [6.3, 7.3], minOffice: 50, orient: 'wide' },
    // side-by-side mode: work area on top, lounge below, door in the wall between them
    tall: { rows: 29, deskRows: [4, 9], perRow: 6, kitchenY: 26, door: [14, 16], aisles: [6.3, 7.4, 11.6, 12.4], minOffice: 24, orient: 'tall', cols: 26, loungeTop: 18 },
  };
  let P = PLANS.full, ROWS, OH, VH, COLS, OW, VW, LW, SCALE = 2, MODE = 'stacked';
  let wrapEl, stageEl, canvas, ctx, labelsEl, balloonsEl;
  const roomCanvas = document.createElement('canvas');
  let R, L, DOOR, DOOR_PT, DOOR_EXIT, B, C0, LY, DESKS = [], SEATS = [], PING = null, TV = null, FOOD = null;
  const seatBusy = {};
  let officeHeight = 0;
  const agents = new Map();
  let order = [];
  let prefs = { costumes: {}, desks: {} };
  let selected = null;
  let firstState = true;
  let frameNo = 0;
  const handlers = { select() {}, context() {}, seat() {} };
  let drag = null;

  // ───────────── palettes ─────────────
  const SKINS = ['#f3d3b3', '#e6b894', '#d3a279', '#c9956b', '#a87450', '#8a5c3c', '#7c5236'];
  const HAIRS = ['#3b2418', '#1a1a1a', '#e8c170', '#f0f0f0', '#c9622a', '#8b3a2a', '#5c3a1e', '#2a2a2a'];
  const SHIRTS = ['#4a9a6a', '#e8e8e8', '#e07a2a', '#2a2a2a', '#5a7ab8', '#b84a5a', '#c9a56b', '#7a5ab8', '#3a8a8a', '#d8c04a'];
  const PANTS = ['#2f3b58', '#3a3a3a', '#4a3b2a', '#5a5a6a', '#2a4a3a'];
  const HAIR_F = ['bob', 'long', 'ponytail', 'bun', 'afro', 'long'];
  const HAIR_M = ['short', 'spiky', 'short', 'afro', 'bun', 'short'];
  const HAIR_STYLES = ['short', 'spiky', 'bob', 'long', 'ponytail', 'bun', 'afro'];
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function shortName(s) { return s.length > 15 ? s.slice(0, 14) + '…' : s; }
  const R_ = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };

  // ───────────── layout ─────────────
  const TALL_CACHE = {}, TALL_MIN_COLS = { 2: 26, 3: 20, 4: 17 };
  function tallPlan(k, rows) {   // the tall plan with k desk rows, stretched to `rows`: 40% of the extra rows go to the office, the rest to the lounge
    const key = k + ':' + rows; if (TALL_CACHE[key]) return TALL_CACHE[key];
    const minRows = 5 * k + 19, extra = rows - minRows, eo = Math.round(extra * 0.4), bottom = 4 + 5 * k + eo, step = (bottom - 4) / k;
    const deskRows = Array.from({ length: k }, (_, i) => 4 + Math.round(i * step));
    return TALL_CACHE[key] = Object.assign({}, PLANS.tall, { rows, perRow: 12 / k, officeBottom: bottom, deskRows, door: [bottom, bottom + 2], loungeTop: bottom + 4, kitchenY: rows - 3, cols: TALL_MIN_COLS[k] });
  }
  function minColsFor(plan) { return 4 + Math.ceil(plan.minOffice / (1 - LOUNGE_SHARE)); }
  function layout() {
    const w = wrapEl.clientWidth; if (!w) return;
    let plan, cols;
    if (MODE === 'side') {
      // fill the column: widen for a landscape column, add rows (lounge first, then office) for a portrait one
      // 12 desks in 2, 3 or 4 rows: pick the arrangement that needs the least stretching to fill the column
      const h = wrapEl.clientHeight || window.innerHeight * 0.8, a = w / h;
      let best = null;
      for (const k of [2, 3, 4]) {
        const minCols = TALL_MIN_COLS[k], minRows = 5 * k + 19;
        let c = Math.max(minCols, Math.min(60, Math.round((minRows - 1) * a) + 2)), r = minRows;
        if (c === minCols) r = Math.min(minRows + 40, Math.max(minRows, Math.round((c - 2) / a) + 1));
        const stretch = (r - minRows) / minRows + (c - minCols) / minCols;
        if (!best || stretch < best.stretch) best = { k, c, r, stretch };
      }
      cols = best.c; plan = tallPlan(best.k, best.r);
    } else {
      const naturalFull = w * (PLANS.full.rows - 1) / (minColsFor(PLANS.full) - 2);
      let want = officeHeight > 0 ? officeHeight : Math.min(naturalFull, window.innerHeight * 0.45);
      want = Math.max(90, want);
      plan = PLANS.full; cols = Math.max(minColsFor(plan), Math.round(w / want * (plan.rows - 1)) + 2);
      if (cols > 84) { plan = PLANS.compact; cols = Math.max(minColsFor(plan), Math.round(w / want * (plan.rows - 1)) + 2); }
    }
    const changed = plan !== P || cols !== COLS;
    P = plan; ROWS = P.rows; OH = ROWS * T; VH = OH - T; COLS = cols; OW = COLS * T; VW = OW - 2 * T;
    LW = P.orient === 'tall' ? COLS - 2 : Math.floor((COLS - 4) * LOUNGE_SHARE);
    if (changed || !R) buildMap();
    canvas.width = VW; canvas.height = VH; ctx.imageSmoothingEnabled = false;
    roomCanvas.width = OW; roomCanvas.height = OH;
    if (MODE === 'side') {
      const h = wrapEl.clientHeight || window.innerHeight * 0.8;
      SCALE = Math.min(w / VW, h / VH);
      const cw = Math.round(VW * SCALE), ch = Math.round(VH * SCALE);
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      stageEl.style.width = cw + 'px'; stageEl.style.margin = `${Math.max(0, Math.floor((h - ch) / 2))}px auto 0`;
      wrapEl.style.height = '';
    } else {
      SCALE = w / VW;
      const ch = Math.round(VH * SCALE);
      canvas.style.width = w + 'px'; canvas.style.height = ch + 'px';
      stageEl.style.width = w + 'px'; stageEl.style.margin = '0'; wrapEl.style.height = ch + 'px';
    }
    drawRoom();
    if (changed) remapAgents();
  }
  function buildMap() {
    const tall = P.orient === 'tall';
    if (tall) {
      L = { x0: 1, x1: COLS - 1, y0: 3, y1: P.officeBottom || 14 };
      R = { x0: 1, x1: COLS - 1, y0: P.loungeTop, y1: ROWS };
      DOOR = { kind: 'h', y0: P.door[0], y1: P.door[1], x0: Math.floor(COLS / 2) - 2, x1: Math.floor(COLS / 2) + 1 };
      DOOR_PT = { x: (DOOR.x0 + 1.5) * T, y: DOOR.y0 * T + 8 };
      DOOR_EXIT = { x: DOOR_PT.x, y: (DOOR.y1 + 1) * T };
    } else {
      R = { x0: COLS - 1 - LW, x1: COLS - 1, y0: 3, y1: ROWS };
      L = { x0: 1, x1: R.x0 - 2, y0: 3, y1: ROWS };
      DOOR = { kind: 'v', x: L.x1, y0: P.door[0], y1: P.door[1] };
      DOOR_PT = { x: DOOR.x * T + 8, y: (DOOR.y0 + 1) * T + 4 };
      DOOR_EXIT = { x: DOOR_PT.x, y: (DOOR.y1 + 1) * T };
    }
    B = R.x0; C0 = B + 1; LY = R.y0;
    const officeW = L.x1 - 1, n = P.perRow, span = officeW - 3 - 2;
    DESKS = [];
    for (const y of P.deskRows) for (let i = 0; i < n; i++) DESKS.push({ x: 2 + Math.round(i * span / (n - 1)), y });
    const K = P.kitchenY, full = P !== PLANS.compact;
    PING = full && LW >= 18 ? { x: B + LW - 6, y: LY + 3, w: 4 } : (full && K - LY >= 15 ? { x: C0 + 1, y: LY + 10, w: 4 } : null);
    TV = LW >= 14 ? { x: B + LW - 6, w: 3 } : null;
    // snack bar: right of the rug next to the kitchen on wide lounges, below the rug on narrow tall ones
    // snack bar: centred at the top of the kitchen tiles, between the cabinet and the counter
    FOOD = full && LW >= 13 ? { x: B + Math.floor((LW - 4) / 2), y: K, w: 4 } : null;
    if (FOOD && PING && PING.y === FOOD.y) FOOD = null;
    SEATS = [
      { id: 'sofaT1', x: C0 + 2.5, y: LY + 0.8, act: 'sitD' }, { id: 'sofaT2', x: C0 + 4.5, y: LY + 0.8, act: 'sitD' },
      { id: 'coffee', x: B + LW - 3.6, y: K + 0.9, act: 'coffee' }, { id: 'coffee2', x: B + LW - 2.2, y: K + 0.9, act: 'coffee' },
      { id: 'stand1', x: B + 0.6, y: LY + 1, act: 'stand' }, { id: 'stand3', x: B + LW - 2, y: LY + 1, act: 'stand' },
      { id: 'stand5', x: B + 4.5, y: K + 0.6, act: 'stand' }, { id: 'stand6', x: B + 6.5, y: K + 0.6, act: 'stand' },
    ];
    if (full) SEATS.push(
      { id: 'sofaL', x: C0, y: LY + 3.6, act: 'sitR' }, { id: 'sofaR', x: C0 + 7, y: LY + 3.6, act: 'sitL' },
      { id: 'sofaB', x: C0 + 2.5, y: LY + 5.9, act: 'sleeping' },
      { id: 'stand2', x: B + 0.6, y: LY + 5.6, act: 'stand' }, { id: 'stand4', x: B + LW - 2, y: LY + 5.6, act: 'stand' },
      { id: 'stand7', x: B + 2.5, y: K + 1.6, act: 'stand' }, { id: 'stand8', x: B + 8.5, y: LY + 6.2, act: 'stand' });
    if (PING) SEATS.push(
      { id: 'pingL', x: PING.x - 1.3, y: PING.y + 0.4, act: 'ping', face: 'right' },
      { id: 'pingR', x: PING.x + PING.w + 0.3, y: PING.y + 0.4, act: 'ping', face: 'left' },
      { id: 'stand9', x: PING.x + 1, y: PING.y + 3.6, act: 'stand' });
    if (TV) SEATS.push({ id: 'watch1', x: TV.x + 0.1, y: LY + 0.4, act: 'watch' }, { id: 'watch2', x: TV.x + 1.7, y: LY + 0.4, act: 'watch' });
    if (FOOD) SEATS.push({ id: 'eat1', x: FOOD.x + 0.5, y: FOOD.y + 0.9, act: 'eat' }, { id: 'eat2', x: FOOD.x + 2.4, y: FOOD.y + 0.9, act: 'eat' });
    if (LW >= 24) SEATS.push({ id: 'stand10', x: B + 11, y: LY + 1, act: 'stand' }, { id: 'stand11', x: B + 11, y: LY + 5.6, act: 'stand' });
  }
  function remapAgents() {
    const ids = new Set(SEATS.map(s => s.id));
    for (const k of Object.keys(seatBusy)) if (!ids.has(k)) delete seatBusy[k];
    agentList().forEach(a => {
      a.excursion = null; a.desk = deskFor(a);
      if (atDesk(a)) { a.px = deskPos(a).x; a.py = deskPos(a).y; return; }
      if (a.seat && ids.has(a.seat.id)) {
        a.seat = SEATS.find(s => s.id === a.seat.id);
        if (a.activity === 'walking') setPath(a, { x: a.seat.x * T, y: a.seat.y * T }); else { a.px = a.seat.x * T; a.py = a.seat.y * T; }
        return;
      }
      releaseSeat(a); a.seat = null;
      if (a.goalAct === 'desk' && a.activity === 'walking') { a.px = Math.min(a.px, (L.x1 - 2) * T); a.py = Math.min(a.py, (ROWS - 2) * T); setPath(a, deskPos(a)); return; }
      a.activity = 'wander'; a.settled = false; a.wait = 5; a.path = [];
      const p = randPoint('L'); a.px = p.x; a.py = p.y;
    });
  }

  // ───────────── room rendering (cached) ─────────────
  function fill(c) { return (a, b, w, h, col) => { c.fillStyle = col; c.fillRect(a, b, w, h); }; }
  function wallFace(F, x0, x1, top) {   // the vertical wall surface above a room's floor, 2 rows tall
    F(x0 * T, top * T, (x1 - x0) * T, 2 * T, '#2e3350');
    for (let x = x0 * T; x < x1 * T; x += 6) F(x, top * T, 1, 2 * T, 'rgba(255,255,255,0.025)');
    F(x0 * T, top * T + 4, (x1 - x0) * T, 1, '#3d4468'); F(x0 * T, (top + 2) * T - 4, (x1 - x0) * T, 4, '#4a507a'); F(x0 * T, (top + 2) * T - 4, (x1 - x0) * T, 1, '#5b6290'); F(x0 * T, (top + 2) * T - 1, (x1 - x0) * T, 1, '#2a2f4a'); F(x0 * T, top * T, (x1 - x0) * T, 1, '#3a4062');
  }
  function drawRoom() {
    CLOCKS.length = 0; BOARDS.length = 0;
    const rc = roomCanvas.getContext('2d'); rc.imageSmoothingEnabled = false; const F = fill(rc);
    const K = P.kitchenY, full = P !== PLANS.compact, tall = P.orient === 'tall', WY = LY - 2;   // WY: lounge wall face top row
    F(0, 0, OW, OH, '#1c2033');
    wallFace(F, L.x0, L.x1, 1); wallFace(F, R.x0, R.x1, WY);
    // work area floor: cool slate tiles with grout lines and slight per-tile shade differences
    // work area floor: large slate slabs (two tiles square), soft shade differences, grout only on slab edges
    for (let r = L.y0; r < L.y1; r++) for (let cx = L.x0; cx < L.x1; cx++) {
      const x = cx * T, y = r * T, sx = Math.floor((cx - L.x0) / 2), sy = Math.floor((r - L.y0) / 2), sh = (hash(sx + ':' + sy) % 4) - 1;
      const base = (sx + sy) % 2 ? [76, 82, 95] : [70, 76, 89];
      F(x, y, T, T, `rgb(${base[0] + sh * 2},${base[1] + sh * 2},${base[2] + sh * 2})`);
      if ((r - L.y0) % 2 === 1 || r === L.y1 - 1) F(x, y + T - 1, T, 1, '#363b46');
      if ((cx - L.x0) % 2 === 1 || cx === L.x1 - 1) F(x + T - 1, y, 1, T, '#363b46');
      if ((r - L.y0) % 2 === 0 && (cx - L.x0) % 2 === 0) { F(x + 1, y + 1, 2 * T - 3, 1, 'rgba(255,255,255,0.05)'); F(x + 1, y + 1, 1, 2 * T - 3, 'rgba(255,255,255,0.05)'); }
      if (hash(cx * 7 + ':' + r * 3) % 11 === 0) F(x + 4 + hash(cx + r) % 8, y + 3 + hash(cx * 3 + r) % 9, 2, 1, 'rgba(255,255,255,0.05)');
    }
    F(L.x0 * T, L.y0 * T, (L.x1 - L.x0) * T, 3, 'rgba(0,0,0,0.22)'); F(L.x0 * T, L.y0 * T + 3, (L.x1 - L.x0) * T, 2, 'rgba(0,0,0,0.1)');
    // lounge carpet with a woven texture and a rug under the seating
    for (let r = R.y0; r < K; r++) for (let cx = R.x0; cx < R.x1; cx++) { const w2 = (Math.floor((cx - R.x0) / 2) + Math.floor((r - R.y0) / 2)) % 2; F(cx * T, r * T, T, T, w2 ? '#4b6e8e' : '#4e7192'); if ((cx + r) % 3 === 0) F(cx * T + 5, r * T + 9, 2, 1, 'rgba(255,255,255,0.05)'); }
    if (full) {   // rug under the seating: bordered, with a fringe on the short sides
      const rx = (C0 - 1) * T + 4, ry = (LY + 2) * T + 8, rw = 11 * T - 8, rh = 5 * T;
      box(F, rx, ry, rw, rh, '#5d3f5a'); F(rx + 3, ry + 3, rw - 6, rh - 6, '#6b4a66'); F(rx + 6, ry + 6, rw - 12, rh - 12, '#5d3f5a'); F(rx + 9, ry + 9, rw - 18, rh - 18, '#654460');
      for (let yy = ry + 4; yy < ry + rh - 4; yy += 4) { F(rx - 3, yy, 2, 2, '#c9b9c6'); F(rx + rw + 1, yy, 2, 2, '#c9b9c6'); }
      for (let x = rx + 8; x < rx + rw - 8; x += 8) { F(x, ry + 1, 4, 1, '#8a6a86'); F(x, ry + rh - 2, 4, 1, '#8a6a86'); }
    }
    F(R.x0 * T, R.y0 * T, (R.x1 - R.x0) * T, 3, 'rgba(0,0,0,0.22)'); F(R.x0 * T, R.y0 * T + 3, (R.x1 - R.x0) * T, 2, 'rgba(0,0,0,0.1)');
    // kitchen floor: cream ceramic tiles with grout
    for (let r = K; r < R.y1; r++) for (let cx = R.x0; cx < R.x1; cx++) {
      const x = cx * T, y = r * T, sh = (hash(cx * 5 + ':' + r * 7) % 3) - 1;
      const base = (cx + r) % 2 ? [214, 208, 194] : [205, 199, 184];
      F(x, y, T, T, `rgb(${base[0] + sh * 3},${base[1] + sh * 3},${base[2] + sh * 3})`);
      F(x, y + T - 1, T, 1, '#a9a18f'); F(x + T - 1, y, 1, T, '#a9a18f'); F(x + 1, y + 1, T - 3, 1, 'rgba(255,255,255,0.18)'); F(x + 1, y + 1, 1, T - 3, 'rgba(255,255,255,0.12)');
    }
    F(R.x0 * T, K * T, (R.x1 - R.x0) * T, 2, 'rgba(0,0,0,0.12)');
    // doorway between the rooms: threshold, frame and an open door leaf
    if (DOOR.kind === 'v') {
      for (let r = DOOR.y0; r < DOOR.y1; r++) { F(DOOR.x * T, r * T, T, T, '#4e5460'); F(DOOR.x * T, r * T + T - 1, T, 1, '#3a3f4a'); F((DOOR.x + 1) * T, r * T, T, T, r < K ? '#4b6e8e' : '#e4e4e4'); }
      F(DOOR.x * T, DOOR.y0 * T - 2, 2 * T, 2, '#3a4062'); F(DOOR.x * T, DOOR.y1 * T, 2 * T, 2, '#3a4062');
      F(DOOR.x * T - 2, DOOR.y0 * T - 3, 2 * T + 4, 3, '#8a6a46'); F(DOOR.x * T - 2, DOOR.y1 * T, 2 * T + 4, 3, '#8a6a46');
      F(DOOR.x * T - 2, DOOR.y0 * T - 3, 2, (DOOR.y1 - DOOR.y0) * T + 6, '#8a6a46'); F((DOOR.x + 2) * T, DOOR.y0 * T - 3, 2, (DOOR.y1 - DOOR.y0) * T + 6, '#8a6a46');
      F(DOOR.x * T - 15, DOOR.y0 * T - 1, 14, 5, '#7a4c2a'); F(DOOR.x * T - 15, DOOR.y0 * T - 1, 14, 1, '#9a6a3e'); F(DOOR.x * T - 5, DOOR.y0 * T + 1, 2, 1, '#e8c04a');
      F((DOOR.x + 1) * T, DOOR.y0 * T, T, (DOOR.y1 - DOOR.y0) * T, 'rgba(0,0,0,0.08)');
    } else {
      const dw = (DOOR.x1 - DOOR.x0) * T;
      for (let cx = DOOR.x0; cx < DOOR.x1; cx++) { F(cx * T, DOOR.y0 * T, T, T, '#4e5460'); F(cx * T + T - 1, DOOR.y0 * T, 1, T, '#3a3f4a'); F(cx * T, (DOOR.y0 + 1) * T, T, T, '#4e5460'); F(cx * T, (DOOR.y1) * T, T, 2 * T, '#2e3350'); }
      // the lounge wall face runs across the door column too, so cut an opening through it
      for (let r = DOOR.y1; r < LY; r++) for (let cx = DOOR.x0; cx < DOOR.x1; cx++) F(cx * T, r * T, T, T, '#4b6e8e');
      F(DOOR.x0 * T - 3, DOOR.y0 * T - 2, 3, (LY - DOOR.y0) * T + 4, '#8a6a46'); F(DOOR.x1 * T, DOOR.y0 * T - 2, 3, (LY - DOOR.y0) * T + 4, '#8a6a46');
      F(DOOR.x0 * T - 3, DOOR.y0 * T - 2, dw + 6, 3, '#8a6a46');
      F(DOOR.x0 * T - 1, DOOR.y0 * T - 15, 5, 14, '#7a4c2a'); F(DOOR.x0 * T - 1, DOOR.y0 * T - 15, 1, 14, '#9a6a3e'); F(DOOR.x0 * T + 1, DOOR.y0 * T - 5, 1, 2, '#e8c04a');
      F(DOOR.x0 * T, DOOR.y0 * T, dw, 2, 'rgba(0,0,0,0.12)');
    }
    // wall décor: office (repeats along the wall)
    drawPlant(rc, 1, 1, 'bushy');
    const deco = ['bookshelf', 'clock', 'bookshelf', 'frame2', 'bookshelf', 'frame2', 'bookshelf', 'clock'];
    let wx = 3, k = 0;
    while (wx <= L.x1 - 5) {
      const d = deco[k++ % deco.length];
      if (d === 'bookshelf') { drawBookshelf(rc, wx); wx += 4; }
      else if (d === 'clock') { drawClock(rc, wx + 0.5); wx += 2.5; }
      else if (d === 'whiteboard') { drawWhiteboard(rc, wx); wx += 7; }
      else { drawFrame(rc, wx, 2); wx += 3; }
    }
    drawPlant(rc, L.x1 - 2, 1, 'bushy');
    // wall décor: lounge (frames, TV on the wall, plants), on the lounge's own wall face
    const yo = (WY - 1) * T;
    const clearOfDoor = (cx, wt) => !(tall && cx < DOOR.x1 + 1 && cx + wt > DOOR.x0 - 1);
    drawPlant(rc, B, WY, 'snake'); drawPlant(rc, B + LW - 2, WY, 'snake');
    [[B + 2, 1], [B + 5, 2], [B + 9, 2]].forEach(([cx, wt], i) => { if ((i < 2 || LW >= 24) && clearOfDoor(cx, wt)) drawFrame(rc, cx, wt, yo); });
    if (TV) { const x = TV.x * T, y = T + 3 + yo; box(F, x, y, TV.w * T, 22, '#2a2d36'); F(x + 1, y + 1, TV.w * T - 2, 1, '#3d414d'); F(x + 2, y + 2, TV.w * T - 4, 18, '#0b0c10'); box(F, x + TV.w * T / 2 - 6, y + 22, 12, 3, '#2c2f38'); F(x + TV.w * T / 2 - 1, y + 20, 2, 2, '#e03b3b'); }
    else drawFrame(rc, B + LW - 4, 1, yo);
    // office furniture
    DESKS.forEach(d => drawDesk(rc, d.x, d.y));
    const bottom = L.y1 - 2;
    drawPlant(rc, 1, bottom, 'snake'); drawTrash(rc, L.x1 - 1, bottom);
    if (full) {
      const officeW = L.x1 - 1, tables = officeW > 44 ? 3 : officeW > 22 ? 2 : 1;
      for (let i = 0; i < tables; i++) drawTable(rc, 4 + Math.round(i * (officeW - 12) / Math.max(1, tables - 1)), bottom);
      drawPlant(rc, L.x1 - 1, 8, 'bushy');
    }
    // lounge furniture (rows relative to the lounge top LY)
    drawSofaH(rc, C0 + 2, LY + 1, 4);
    if (full) { drawSofaH(rc, C0 + 2, LY + 6, 4); drawSofaV(rc, C0, LY + 3, 2); drawSofaV(rc, C0 + 7, LY + 3, 2); drawCoffeeTable(rc, C0 + 3.5, LY + 3.5); drawPlant(rc, B, LY + 6, 'bushy'); drawPlant(rc, B + LW - 2, LY + 6, 'bushy'); }
    if (PING) drawPingTable(rc);
    if (FOOD) drawSnackBar(rc, FOOD.x, FOOD.y, FOOD.w);
    drawCounter(rc, B + LW - 5, K, 4); drawFridge(rc, B, K); drawCabinet(rc, B + 2, K, 2);
  }
  // ───────────── furniture painters (outlined pixel art; every footprint matches the seat/desk geometry) ─────────────
  const OUT = '#1a1c2a';
  function shade(hex, k) {   // darken (k < 0) or lighten (k > 0) a #rrggbb colour
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const f = v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
  function box(F, x, y, w, h, col, out = OUT) { F(x - 1, y - 1, w + 2, h + 2, out); F(x, y, w, h, col); }
  function shadow(F, x, y, w, h) { F(x, y, w, h, 'rgba(0,0,0,0.22)'); }
  function drawPingTable(c) {
    const x = PING.x * T, y = PING.y * T + 4, w = PING.w * T, h = 24, F = fill(c);
    shadow(F, x + 2, y + h + 2, w - 4, 4);
    box(F, x + 3, y + h, 3, 6, '#3a3a4a'); box(F, x + w - 6, y + h, 3, 6, '#3a3a4a');
    box(F, x, y, w, h, '#2a7a4e'); F(x + 1, y + 1, w - 2, 1, '#3d9a62'); F(x + 1, y + h - 3, w - 2, 2, '#1f5a3a');
    F(x + 1, y + 1, 1, h - 2, '#e8e8e8'); F(x + w - 2, y + 1, 1, h - 2, '#e8e8e8'); F(x + 1, y + h / 2, w - 2, 1, '#e8e8e8');
    F(x + w / 2 - 1, y - 3, 2, h + 6, '#dedede'); F(x + w / 2 - 1, y - 3, 2, 1, '#6a6a6a'); F(x + w / 2 - 1, y + h + 2, 2, 1, '#6a6a6a');
    box(F, x + 3, y + 4, 4, 4, '#c43b3b'); F(x + 4, y + 8, 1, 2, '#7a4c2a'); box(F, x + w - 7, y + h - 9, 4, 4, '#3b6bc4'); F(x + w - 6, y + h - 5, 1, 2, '#7a4c2a');
    F(x + w / 2 + 6, y + 6, 2, 2, '#ffffff');
  }
  function drawBurger(F, x, y) {   // 7x6 burger: bun, lettuce, patty, bun
    F(x, y, 7, 2, '#e0a050'); F(x + 1, y - 1, 5, 1, '#e0a050'); F(x + 2, y, 1, 1, '#f5d9a0'); F(x + 4, y, 1, 1, '#f5d9a0');
    F(x, y + 2, 7, 1, '#5cb85c'); F(x, y + 3, 7, 1, '#6b3a1e'); F(x, y + 4, 7, 1, '#f0c040'); F(x, y + 5, 7, 1, '#e0a050');
  }
  function drawSnackBar(c, cx, cy, w) {
    const x = cx * T, y = cy * T, W = w * T, F = fill(c);
    shadow(F, x + 1, y + 20, W - 2, 3);
    box(F, x + 2, y + 15, 3, 6, '#4a4a5a'); box(F, x + W - 5, y + 15, 3, 6, '#4a4a5a');
    box(F, x, y + 4, W, 12, '#b8864e'); F(x + 1, y + 5, W - 2, 1, '#d8a86a'); F(x + 1, y + 13, W - 2, 3, '#8e6236'); F(x + 6, y + 8, 10, 1, '#a87844'); F(x + W - 18, y + 10, 12, 1, '#a87844');
    // tray of burgers, a box of fries, drinks and a stack of plates
    box(F, x + 3, y + 2, 20, 9, '#c94a3a'); F(x + 4, y + 3, 18, 1, '#e06a5a'); drawBurger(F, x + 5, y + 4); drawBurger(F, x + 14, y + 4);
    box(F, x + 27, y + 1, 9, 10, '#d8382a'); F(x + 28, y + 2, 7, 3, '#e8a83a'); for (let i = 0; i < 4; i++) F(x + 28 + i * 2, y - 2 + (i % 2), 1, 5, '#f0c040'); F(x + 30, y + 6, 3, 3, '#f0d060');
    box(F, x + 40, y + 2, 5, 8, '#3b6bc4'); F(x + 41, y + 3, 1, 6, '#7aa0e0'); F(x + 42, y - 1, 1, 4, '#e8e8e8'); box(F, x + 47, y + 2, 5, 8, '#c43b3b'); F(x + 48, y + 3, 1, 6, '#f08a8a'); F(x + 49, y - 1, 1, 4, '#e8e8e8');
    box(F, x + W - 9, y + 5, 7, 5, '#f4f4f4'); F(x + W - 8, y + 7, 5, 1, '#c9c9d3'); F(x + W - 8, y + 9, 5, 1, '#c9c9d3');
    if (W >= 60) { box(F, x + W / 2 - 9, y - 8, 18, 6, '#f5e6a0'); F(x + W / 2 - 6, y - 6, 12, 1, '#c43b3b'); F(x + W / 2 - 4, y - 4, 8, 1, '#c43b3b'); F(x + W / 2 - 1, y - 2, 2, 2, '#8a6a46'); }
  }
  const BOARDS = [];   // whiteboards drawn this layout; the task list on them is written per frame
  function drawWhiteboard(c, cx) {
    const x = cx * T + 2, y = T + 3, w = 6 * T - 4, h = 22, F = fill(c);
    BOARDS.push({ x, y, w, h });
    // aluminium frame around a white board, a marker tray with three markers, two mounting screws
    box(F, x - 2, y - 2, w + 4, h + 4, '#9a9eaa'); F(x - 1, y - 1, w + 2, 1, '#c8ccd6'); F(x - 1, y - 1, 1, h + 2, '#c8ccd6'); F(x - 1, y + h, w + 2, 1, '#6e7280');
    F(x, y, w, h, '#f6f6f2'); F(x, y + h - 2, w, 2, '#e4e4de'); F(x + w - 2, y, 2, h, '#e9e9e3');
    F(x + 2, y - 2, 1, 1, '#4a4e5a'); F(x + w - 3, y - 2, 1, 1, '#4a4e5a');
    box(F, x + 3, y + h + 2, w - 6, 3, '#8a8a98'); F(x + 6, y + h + 2, 4, 1, '#c43b3b'); F(x + 12, y + h + 2, 4, 1, '#3b6bc4'); F(x + 18, y + h + 2, 4, 1, '#3ba05a');
  }
  function drawBoardTasks() {
    if (!BOARDS.length) return;
    const busy = agentList().filter(a => a.status === 'working' || a.status === 'blocked').sort((p, q) => p.statusSince - q.statusSince).slice(0, 3);
    const legible = SCALE >= 2.2;   // below this the lettering is a smudge, so draw marker strokes instead
    BOARDS.forEach(b => {
      const x = b.x - VX, y = b.y - VY;
      if (legible) { ctx.font = 'bold 5px monospace'; ctx.textBaseline = 'top'; ctx.fillStyle = '#3b6bc4'; ctx.fillText('TODAY', x + 3, y + 2); ctx.font = '5px monospace'; }
      else { R_(x + 3, y + 3, 14, 2, '#3b6bc4'); }
      if (!busy.length) { if (legible) { ctx.fillStyle = '#8a8a98'; ctx.fillText('all quiet', x + 3, y + 9); } else { R_(x + 3, y + 9, 10, 1, '#b8b8c4'); } return; }
      busy.forEach((a, i) => {
        const ly = y + 8 + i * 5, col = a.status === 'blocked' ? '#c43b3b' : '#2a2a34';
        R_(x + 3, ly + 1, 2, 2, a.status === 'blocked' ? '#e03b3b' : '#e5b400');
        if (legible) { ctx.fillStyle = col; ctx.fillText((shortName(a.name).slice(0, 9) + ': ' + (a.task || (a.status === 'blocked' ? 'waiting on you' : 'working'))).slice(0, 24), x + 7, ly); }
        else { const len = 12 + (hash(a.name) % 4) * 6; R_(x + 7, ly + 1, len, 1, col); R_(x + 7 + len + 3, ly + 1, Math.max(4, 40 - len), 1, '#9a9aa8'); }
      });
    });
  }
  function drawBookshelf(c, cx) {
    const x = cx * T, y = T + 1, w = 3 * T, h = 2 * T - 4, F = fill(c);
    box(F, x, y, w, h, '#6b4326'); F(x + 1, y + 1, w - 2, 1, '#8a5a34'); F(x + 1, y + 1, 1, h - 2, '#8a5a34');
    const cols = ['#c43b3b', '#3b6bc4', '#3ba05a', '#e0b83b', '#e07a3b', '#8a4bb8', '#e8e8e8', '#2a8a8a'];
    for (let s = 0; s < 2; s++) {
      const sy = y + 3 + s * 12; F(x + 2, sy, w - 4, 10, '#3e2614'); F(x + 2, sy + 10, w - 4, 2, '#8a5a34'); F(x + 2, sy + 12, w - 4, 1, '#4c2e18');
      let bx = x + 4, k = s * 5 + Math.floor(cx);
      while (bx < x + w - 6) { const bw = 2 + (k % 2), bh = 6 + (k % 4), col = cols[k % cols.length]; F(bx, sy + 10 - bh, bw, bh, col); F(bx, sy + 10 - bh, 1, bh, shade(col, 0.25)); F(bx, sy + 10 - bh + 2, bw, 1, shade(col, -0.35)); bx += bw + 1; k++; }
    }
  }
  const CLOCKS = [];   // wall clocks drawn this layout; their hands follow the real time (see drawClockHands)
  function drawClock(c, cx) {
    const x = cx * T + 8, y = T + 14, F = fill(c);
    CLOCKS.push({ x, y });
    // round bezel: dark rim, brass ring, cream face, hour marks; the mount above ties it to the wall
    F(x - 1, y - 12, 2, 3, '#5a5a6a');
    c.fillStyle = OUT; c.beginPath(); c.arc(x, y, 10, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#b08a3a'; c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#e6c85a'; c.beginPath(); c.arc(x - 1, y - 1, 8, Math.PI, Math.PI * 1.5); c.lineTo(x - 1, y - 1); c.fill();
    c.fillStyle = OUT; c.beginPath(); c.arc(x, y, 7.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#f6f1e2'; c.beginPath(); c.arc(x, y, 6.5, 0, Math.PI * 2); c.fill();
    F(x, y - 6, 1, 2, '#2a2a34'); F(x, y + 5, 1, 2, '#2a2a34'); F(x - 6, y, 2, 1, '#2a2a34'); F(x + 5, y, 2, 1, '#2a2a34');
    [[3, -5], [5, -3], [5, 3], [3, 5], [-3, 5], [-5, 3], [-5, -3], [-3, -5]].forEach(([dx, dy]) => F(x + dx, y + dy, 1, 1, '#8a8a94'));
  }
  function drawClockHands() {
    if (!CLOCKS.length) return;
    const d = new Date(), h = (d.getHours() % 12) + d.getMinutes() / 60, m = d.getMinutes() + d.getSeconds() / 60, sec = d.getSeconds();
    CLOCKS.forEach(({ x, y }) => {
      const cx = x - VX + 0.5, cy = y - VY + 0.5;
      const hand = (angle, len, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(angle) * len, cy - Math.cos(angle) * len); ctx.stroke(); };
      hand(h / 12 * Math.PI * 2, 3.2, 1.6, '#2a2a34'); hand(m / 60 * Math.PI * 2, 5, 1.2, '#2a2a34'); hand(sec / 60 * Math.PI * 2, 5.5, 0.6, '#c43b3b');
      R_(x - VX, y - VY, 1, 1, '#c43b3b');
    });
  }
  function drawFrame(c, cx, wt, yo = 0) {
    const x = cx * T + 2, y = T + 6 + yo, w = wt * T - 4, h = 14, F = fill(c);
    box(F, x, y, w, h, '#8a5a34'); F(x + 1, y + 1, w - 2, 1, '#b07a48'); F(x + 1, y + 1, 1, h - 2, '#b07a48');
    F(x + 2, y + 2, w - 4, h - 4, '#3a5a7a'); F(x + 2, y + 2, w - 4, 4, '#5a86b0'); F(x + 3, y + h - 6, w - 6, 3, '#5a8a4a'); F(x + 3, y + h - 3, w - 6, 1, '#3f6a34');
    F(x + w - 8, y + 3, 3, 3, '#f0d060'); F(x + 4, y + 5, 5, 2, '#c8d8ea'); F(x + 9, y + 8, 3, 2, '#2f4a2a'); F(x + w - 11, y + 8, 4, 2, '#2f4a2a');
  }
  function drawPlant(c, cx, cy, type) {
    const x = cx * T, y = cy * T, F = fill(c);
    shadow(F, x + 2, y + 14, 12, 2);
    box(F, x + 4, y + 9, 8, 6, '#a0603a'); F(x + 5, y + 10, 1, 4, '#c07a4a'); box(F, x + 3, y + 8, 10, 2, '#c0784a');
    const g1 = '#2f7a3f', g2 = '#3a9a4e', g3 = '#8fd18f';
    if (type === 'snake') {
      [[5, -2, 2, 11], [8, -4, 2, 13], [11, 0, 2, 9], [3, 1, 2, 8]].forEach(([a, b, w, h]) => box(F, x + a, y + b, w, h, g1));
      F(x + 8, y - 3, 1, 12, g2); F(x + 5, y - 1, 1, 9, g2); F(x + 11, y + 1, 1, 7, g2); F(x + 8, y - 3, 1, 3, g3); F(x + 5, y, 1, 2, g3);
    } else {
      box(F, x + 3, y + 1, 10, 7, g1); box(F, x + 1, y + 3, 4, 4, g2); box(F, x + 11, y + 3, 4, 4, g2); box(F, x + 5, y - 1, 6, 3, g2);
      F(x + 3, y + 1, 10, 7, g1); F(x + 1, y + 3, 4, 4, g2); F(x + 11, y + 3, 4, 4, g2); F(x + 5, y - 1, 6, 3, g2);
      F(x + 6, y + 2, 3, 2, g3); F(x + 2, y + 4, 2, 1, g3); F(x + 12, y + 4, 2, 1, g3); F(x + 7, y + 6, 2, 2, shade(g1, -0.3));
    }
  }
  function drawDesk(c, dx, dy) {
    const x = dx * T, y = dy * T, F = fill(c), k = hash(dx + ',' + dy) % 4;
    shadow(F, x + 1, y + 13, 3 * T - 2, 4);
    box(F, x + 2, y + 11, 3, 6, '#4a4a5a'); box(F, x + 3 * T - 5, y + 11, 3, 6, '#4a4a5a');
    box(F, x, y + 2, 3 * T, 10, '#c9a56b'); F(x + 1, y + 3, 3 * T - 2, 1, '#e2c08a'); F(x + 1, y + 10, 3 * T - 2, 2, '#a67c4a');
    F(x + 5, y + 6, 10, 1, '#b8935a'); F(x + 30, y + 8, 12, 1, '#b8935a'); F(x + 38, y + 5, 6, 1, '#b8935a');
    // monitor (screen lit by drawMonitors when someone works here), keyboard, mouse
    box(F, x + 18, y - 7, 13, 11, '#d9d9d9'); F(x + 19, y - 6, 11, 8, '#c4c4c4'); F(x + 20, y - 5, 9, 6, '#20242b'); F(x + 21, y - 4, 4, 1, '#31363e');
    box(F, x + 23, y + 4, 3, 2, '#9a9a9a'); F(x + 20, y + 6, 9, 1, '#8a8a8a');
    box(F, x + 19, y + 7, 11, 3, '#ececec'); for (let i = 0; i < 5; i++) F(x + 20 + i * 2, y + 8, 1, 1, '#a8a8a8'); F(x + 22, y + 9, 5, 1, '#c4c4c4');
    box(F, x + 33, y + 7, 3, 3, '#ececec'); F(x + 34, y + 7, 1, 1, '#a8a8a8');
    // an accent per desk: lamp, mug, notebook or a small plant
    if (k === 0) { box(F, x + 4, y - 3, 6, 2, '#5a5a6a'); F(x + 6, y - 1, 2, 5, '#5a5a6a'); F(x + 3, y - 4, 8, 1, '#7a7a8a'); F(x + 5, y - 1, 4, 1, '#f5e6a0'); }
    else if (k === 1) { box(F, x + 39, y + 4, 4, 4, '#e03b3b'); F(x + 43, y + 5, 1, 2, '#e03b3b'); F(x + 40, y + 5, 2, 1, '#f08a8a'); }
    else if (k === 2) { box(F, x + 4, y + 5, 9, 5, '#3b6bc4'); F(x + 5, y + 6, 7, 1, '#7aa0e0'); F(x + 5, y + 8, 5, 1, '#7aa0e0'); }
    else { box(F, x + 6, y + 6, 4, 3, '#a0603a'); F(x + 5, y + 3, 6, 3, '#3a9a4e'); F(x + 7, y + 2, 2, 1, '#8fd18f'); }
    // chair behind the desk
    const cy = y + T;
    shadow(F, x + 18, cy + 14, 12, 2);
    box(F, x + 18, cy + 1, 12, 4, '#6a3e22'); F(x + 19, cy + 2, 10, 1, '#8a5230');
    box(F, x + 18, cy + 5, 12, 7, '#8f5a34'); F(x + 19, cy + 6, 10, 1, '#a86a3e'); F(x + 19, cy + 11, 10, 1, '#6a3e22');
    F(x + 19, cy + 13, 2, 2, '#3a3a4a'); F(x + 27, cy + 13, 2, 2, '#3a3a4a');
  }
  function drawTable(c, cx, cy) {
    const x = cx * T, y = cy * T, F = fill(c);
    shadow(F, x + 1, y + 12, 3 * T - 2, 4);
    box(F, x + 2, y + 10, 3, 6, '#4a4a5a'); box(F, x + 3 * T - 5, y + 10, 3, 6, '#4a4a5a');
    box(F, x, y + 2, 3 * T, 9, '#c9a56b'); F(x + 1, y + 3, 3 * T - 2, 1, '#e2c08a'); F(x + 1, y + 9, 3 * T - 2, 2, '#a67c4a');
    box(F, x + 8, y + 4, 6, 5, '#e4e4e4'); F(x + 9, y + 5, 4, 3, '#3b6bc4'); box(F, x + 24, y + 4, 6, 5, '#e4e4e4'); F(x + 25, y + 5, 4, 3, '#c43b3b');
    box(F, x + 17, y + 5, 4, 4, '#f4f4f4'); F(x + 18, y + 6, 2, 2, '#5a3418'); F(x + 21, y + 6, 1, 2, '#f4f4f4');
  }
  function drawTrash(c, cx, cy) { const x = cx * T, y = cy * T, F = fill(c); shadow(F, x + 3, y + 13, 10, 2); box(F, x + 4, y + 4, 8, 10, '#9a9a9a'); box(F, x + 3, y + 3, 10, 2, '#c0c0c0'); F(x + 5, y + 6, 1, 7, '#b8b8b8'); F(x + 9, y + 6, 1, 7, '#7a7a7a'); F(x + 6, y + 2, 4, 1, '#e8e8e8'); }
  function drawSofaH(c, cx, cy, w) {
    const x = cx * T, y = cy * T, W = w * T, F = fill(c), base = '#8f2b4b', seat = '#c24468', back = '#a8335a';
    shadow(F, x + 1, y + T + 2, W - 2, 3);
    box(F, x, y, W, T + 2, base); F(x + 2, y + 1, W - 4, 5, back); F(x + 3, y + 1, W - 6, 1, shade(back, 0.2));
    F(x + 2, y + 6, W - 4, T - 6, seat); F(x + 3, y + 7, W - 6, 1, shade(seat, 0.2)); F(x + W / 2 - 1, y + 6, 1, T - 6, base); F(x + 2, y + T - 1, W - 4, 1, shade(seat, -0.25));
    F(x, y + 2, 3, T, shade(base, -0.15)); F(x + W - 3, y + 2, 3, T, shade(base, -0.15)); F(x + 1, y + 2, 1, 1, shade(base, 0.2)); F(x + W - 2, y + 2, 1, 1, shade(base, 0.2));
  }
  function drawSofaV(c, cx, cy, h) {
    const x = cx * T, y = cy * T, H = h * T, F = fill(c), base = '#8f2b4b', seat = '#c24468', back = '#a8335a';
    shadow(F, x + 1, y + H, T, 3);
    box(F, x, y, T + 2, H, base); F(x + 1, y + 2, 4, H - 4, back); F(x + 1, y + 3, 1, H - 6, shade(back, 0.2));
    F(x + 5, y + 2, T - 4, H - 4, seat); F(x + 6, y + 3, 1, H - 6, shade(seat, 0.2)); F(x + 5, y + H / 2 - 1, T - 4, 1, base); F(x + T, y + 2, 1, H - 4, shade(seat, -0.25));
    F(x + 2, y, T - 1, 3, shade(base, -0.15)); F(x + 2, y + H - 3, T - 1, 3, shade(base, -0.15));
  }
  function drawCoffeeTable(c, cx, cy) {
    const x = cx * T, y = cy * T, F = fill(c);
    shadow(F, x + 1, y + 16, 22, 3);
    box(F, x, y, 24, 17, '#c9a56b'); F(x + 1, y + 1, 22, 1, '#e2c08a'); F(x + 1, y + 13, 22, 3, '#a67c4a'); F(x + 1, y + 1, 1, 12, '#e2c08a');
    box(F, x + 4, y + 4, 7, 6, '#3b6bc4'); F(x + 5, y + 5, 5, 1, '#9ec0f0'); F(x + 5, y + 7, 3, 1, '#9ec0f0');
    box(F, x + 14, y + 5, 5, 5, '#f4f4f4'); F(x + 15, y + 6, 3, 3, '#5a3418'); F(x + 19, y + 6, 1, 3, '#f4f4f4');
  }
  function drawCounter(c, cx, cy, w) {
    const x = cx * T, y = cy * T, W = w * T, F = fill(c);
    box(F, x, y + 2, W, T - 2, '#c9a56b'); F(x + 1, y + 3, W - 2, 1, '#e2c08a'); F(x, y + 11, W, 5, '#a67c4a'); F(x + 4, y + 12, W - 8, 1, '#6b4227'); F(x + W / 2 - 2, y + 13, 4, 1, '#3a3a4a');
    box(F, x + 8, y - 6, 14, 14, '#3c3c3c'); F(x + 9, y - 5, 12, 5, '#2a2a2a'); F(x + 10, y - 4, 10, 1, '#4a4a4a'); F(x + 11, y + 2, 8, 4, '#555'); F(x + 12, y + 5, 6, 2, '#e8e8e8'); F(x + 19, y - 4, 2, 2, '#e03b3b'); F(x + 12, y + 1, 6, 1, '#8a6a3a');
    box(F, x + 30, y + 3, 4, 5, '#e8e8e8'); F(x + 34, y + 4, 1, 3, '#e8e8e8'); box(F, x + 40, y + 3, 4, 5, '#e8e8e8'); F(x + 44, y + 4, 1, 3, '#e8e8e8');
    box(F, x + 50, y + 4, 8, 4, '#c43b3b'); F(x + 52, y + 5, 4, 2, '#e8e8e8');
  }
  function drawFridge(c, cx, cy) {
    const x = cx * T, y = cy * T, F = fill(c);
    box(F, x + 1, y - 8, T + 8, 26, '#d6d6d6'); F(x + 2, y - 7, T + 6, 10, '#e8e8e8'); F(x + 2, y + 4, T + 6, 13, '#e2e2e2'); F(x + 2, y + 3, T + 6, 1, '#b8b8b8');
    F(x + 2, y - 7, 1, 24, '#f4f4f4'); F(x + T + 3, y - 4, 2, 5, '#8a8a8a'); F(x + T + 3, y + 6, 2, 7, '#8a8a8a'); F(x + 4, y - 5, 4, 3, '#e03b3b'); F(x + 4, y + 7, 3, 2, '#3b6bc4');
  }
  function drawCabinet(c, cx, cy, w) {
    const x = cx * T, y = cy * T, F = fill(c);
    box(F, x, y + 2, w * T, T - 2, '#c9a56b'); F(x + 1, y + 3, w * T - 2, 1, '#e2c08a'); F(x, y + 10, w * T, 6, '#a67c4a'); F(x + 3, y + 11, w * T - 6, 1, '#6b4227'); F(x + w * T / 2 - 1, y + 12, 2, 2, '#3a3a4a');
    box(F, x + 4, y + 3, 10, 6, '#e4e4e4'); F(x + 5, y + 4, 8, 4, '#3a5a7a'); F(x + 6, y + 5, 3, 1, '#9ec0f0'); box(F, x + 18, y + 4, 5, 4, '#f4f4f4'); F(x + 19, y + 5, 3, 2, '#5a3418');
  }

  // ───────────── animated furniture (drawn every frame) ─────────────
  function drawNameplates() {
    const byDesk = new Map(); agentList().forEach(a => { if (a.desk && !a.leaving && !byDesk.has(a.desk)) byDesk.set(a.desk, a); });
    ctx.font = 'bold 5px monospace'; ctx.textBaseline = 'top';
    DESKS.forEach(d => {
      const a = byDesk.get(d); if (!a) return;
      const x = d.x * T + 2 - VX, y = d.y * T + 5 - VY, name = shortName(a.name).slice(0, 7);
      const w = Math.max(14, name.length * 3 + 4);
      R_(x, y, w, 7, OUT); R_(x + 1, y + 1, w - 2, 5, '#f4e9c8'); ctx.fillStyle = '#2a2a34'; ctx.fillText(name, x + 2, y + 1);
    });
  }
  function drawMonitors() {
    DESKS.forEach(d => {
      const a = agentList().find(x => x.desk === d && deskStatus(x.status) && !x.leaving);
      const x = d.x * T + 20 - VX, y = d.y * T - 5 - VY;
      if (!a) return;
      R_(x, y, 9, 6, a.status === 'blocked' ? '#4a2f3a' : '#2f5f4d');
      const n = 3 + ((frameNo >> 4) + d.x) % 3;
      for (let i = 0; i < n; i++) R_(x + 1, y + 1 + i, 2 + ((frameNo >> 3) + i * 3 + d.x) % 6, 1, a.status === 'blocked' ? '#f08a8a' : '#7fd6a0');
      if (a.status === 'working' && (frameNo & 8)) R_(x + 1 + (frameNo >> 2) % 7, y + 4, 1, 1, '#ffffff');
    });
  }
  function drawTV() {
    if (!TV) return;
    const x = TV.x * T + 2 - VX, y = (LY - 2) * T + 5 - VY, w = TV.w * T - 4, h = 18;
    const scene = Math.floor(frameNo / 600) % 6, t = frameNo % 600;
    if (scene === 0) {   // football
      R_(x, y, w, h, '#2e7d3e'); R_(x, y + h / 2, w, 1, '#8fd18f'); R_(x + 1, y + 1, w - 2, 1, '#8fd18f'); R_(x + 1, y + h - 2, w - 2, 1, '#8fd18f'); R_(x + w / 2, y + 1, 1, h - 2, '#8fd18f');
      const bx = x + 2 + Math.round((0.5 + 0.5 * Math.sin(t / 22)) * (w - 5)), by = y + 3 + Math.round((0.5 + 0.5 * Math.sin(t / 9)) * (h - 7));
      R_(bx, by, 2, 2, '#ffffff'); R_(x + 4 + (t % 40 > 20 ? 1 : 0), y + 6, 2, 5, '#e03b3b'); R_(x + w - 7 - (t % 30 > 15 ? 1 : 0), y + 8, 2, 5, '#3b6bc4'); R_(x + 12, y + 4 + (t % 50 > 25 ? 1 : 0), 2, 5, '#e03b3b'); R_(x + w - 15, y + 10, 2, 5, '#3b6bc4');
    } else if (scene === 1) {   // news with a ticker
      R_(x, y, w, h, '#1b2a44'); R_(x + 3, y + 3, 7, 9, '#e6b894'); R_(x + 3, y + 3, 7, 2, '#3b2418'); R_(x + 4, y + 6, 1, 1, '#1a1a1a'); R_(x + 7, y + 6, 1, 1, '#1a1a1a'); R_(x + 11, y + 4, w - 14, 1, '#a9b8d8'); R_(x + 11, y + 7, w - 18, 1, '#a9b8d8'); R_(x + 11, y + 10, w - 16, 1, '#a9b8d8');
      R_(x, y + h - 4, w, 4, '#c43b3b'); for (let i = 0; i < 6; i++) { const tx = x + ((i * 9 - t) % (w + 8) + (w + 8)) % (w + 8) - 4; if (tx >= x && tx + 5 <= x + w) R_(tx, y + h - 3, 5, 2, '#ffffff'); }
    } else if (scene === 2) {   // space: scrolling stars, a planet and a rocket
      R_(x, y, w, h, '#070a1a');
      for (let i = 0; i < 14; i++) { const sx = x + ((i * 13 + 5 - Math.floor(t / (1 + i % 3))) % w + w) % w, sy = y + (i * 7) % h; R_(sx, sy, 1, 1, i % 4 ? '#c8d0ff' : '#ffffff'); }
      ctx.fillStyle = '#b4573a'; ctx.beginPath(); ctx.arc(x + w - 9, y + 6, 4, 0, Math.PI * 2); ctx.fill(); R_(x + w - 14, y + 6, 10, 1, '#e0b070');
      const rx = x + 4 + Math.round((t % 300) / 300 * (w - 16)), ry = y + 10 + Math.round(2 * Math.sin(t / 15));
      R_(rx, ry, 8, 3, '#e8e8e8'); R_(rx + 8, ry + 1, 2, 1, '#e8e8e8'); R_(rx + 5, ry + 1, 2, 1, '#3b6bc4'); R_(rx - 1, ry - 1, 2, 5, '#c43b3b'); R_(rx - 3 - (t % 4 > 1 ? 1 : 0), ry + 1, 3, 1, '#f5a623'); R_(rx - 4, ry + 1, 1, 1, '#ffe08a');
    } else if (scene === 3) {   // breakout
      R_(x, y, w, h, '#0d0f18');
      const cols = ['#e03b3b', '#f5a623', '#3ba05a', '#3b6bc4'];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) { const gone = ((r * 8 + c) * 37 % 24) < Math.floor(t / 25); if (!gone) R_(x + 2 + c * 5, y + 2 + r * 3, 4, 2, cols[(r + c) % 4]); }
      const ph = (t % 80) / 80, bx = x + 2 + Math.round((0.5 + 0.5 * Math.sin(t / 13)) * (w - 6)), by = y + 11 + Math.round(4 * Math.abs(Math.sin(ph * Math.PI)));
      R_(bx, by, 2, 2, '#ffffff'); R_(Math.max(x + 1, Math.min(x + w - 9, bx - 3)), y + h - 3, 8, 2, '#c8d0ff');
    } else if (scene === 4) {   // city at night
      R_(x, y, w, h, '#101a33'); R_(x + 1, y + 1, w - 2, 6, '#182447'); ctx.fillStyle = '#f2e6b0'; ctx.beginPath(); ctx.arc(x + w - 7, y + 4, 2.5, 0, Math.PI * 2); ctx.fill();
      const hs = [8, 12, 6, 14, 9, 11, 7, 13, 10];
      let bx = x + 1; hs.forEach((bh, i) => { const bw = 4 + (i % 2); R_(bx, y + h - bh, bw, bh, i % 2 ? '#2a3350' : '#222a44'); for (let wy = 1; wy < bh - 1; wy += 2) for (let wx = 1; wx < bw; wx += 2) { const on = ((i * 31 + wy * 7 + wx * 13 + Math.floor(t / 40)) % 5) !== 0; if (on) R_(bx + wx, y + h - bh + wy, 1, 1, '#ffd97a'); } bx += bw + 1; });
      R_(x + (t * 2) % w, y + h - 2, 3, 1, '#ffffff'); R_(x + w - 3 - (t * 2) % w, y + h - 1, 3, 1, '#e03b3b');
    } else {   // code rain
      R_(x, y, w, h, '#020805');
      for (let c = 0; c < w / 3; c++) { const len = 4 + (c * 7) % 6, head = ((t * (1 + c % 3) / 3) + c * 11) % (h + len); for (let k = 0; k < len; k++) { const yy = head - k; if (yy >= 0 && yy < h) R_(x + c * 3, y + yy, 2, 1, k === 0 ? '#d8ffd8' : k < 2 ? '#6fe08a' : '#1f7a3a'); } }
    }
    if ((frameNo % 97) < 2) R_(x, y + (frameNo % 17), w, 1, 'rgba(255,255,255,0.35)');
    R_(x, y, w, 1, 'rgba(255,255,255,0.15)');
  }
  function drawPingPong() {
    if (!PING) return;
    const l = agentList().find(a => a.seat && a.seat.id === 'pingL' && a.activity === 'ping'), r = agentList().find(a => a.seat && a.seat.id === 'pingR' && a.activity === 'ping');
    if (!(l && r)) return;
    const x0 = PING.x * T - VX + 2, x1 = (PING.x + PING.w) * T - VX - 4, yb = PING.y * T + 8 - VY;
    const ph = (frameNo % 60) / 60, dir = Math.floor(frameNo / 60) % 2, u = dir ? 1 - ph : ph;
    const bx = Math.round(x0 + u * (x1 - x0)), by = Math.round(yb - 6 - 8 * Math.sin(ph * Math.PI));
    R_(bx, by, 2, 2, '#ffffff'); R_(bx, by + 1, 1, 1, '#d0d0d0');
  }

  // ───────────── sprite ─────────────
  // A plain shell is an egg: no agent inside yet, just a shell with a face, stub arms and little legs.
  const EGG_TINTS = ['#f6efe0', '#e8f0f8', '#f8e6ea', '#e6f3e8', '#f7f0d8', '#ece6f6'];
  function drawEgg(a, x, y) {
    const f = a.frame, act = a.activity, walk = act === 'walking';
    const ph = walk ? Math.floor(a.walkFrame / 5) % 4 : 0, legA = ph === 1 ? 1 : ph === 3 ? -1 : 0, bob = walk && (ph === 1 || ph === 3) ? 1 : 0;
    const c = (prefs.costumes || {})[a.name] || {}, shell = c.shirt || EGG_TINTS[hash(a.id + ':egg') % EGG_TINTS.length], shellD = shade(shell, -0.18), shellL = '#ffffff';
    const parts = [];
    const P_ = (px, py, w, h, col) => parts.push([px, py, w, h, col]);
    const paint = () => { parts.forEach(([px, py, w, h]) => R_(px - 1, py - 1, w + 2, h + 2, OUT)); parts.forEach(([px, py, w, h, col]) => R_(px, py, w, h, col)); parts.length = 0; };
    if (act === 'sleeping') {   // lying on the sofa, the wide end to the right
      R_(x + 2, y + 15, 26, 3, 'rgba(0,0,0,0.15)');
      P_(x + 6, y + 6, 4, 6, shell); P_(x + 10, y + 4, 8, 10, shell); P_(x + 18, y + 3, 8, 12, shell); P_(x + 26, y + 5, 3, 8, shell);
      paint(); R_(x + 10, y + 12, 16, 2, shellD); R_(x + 12, y + 5, 4, 1, shellL); R_(x + 9, y + 8, 2, 1, OUT); R_(x + 9, y + 10, 2, 1, OUT);
      ctx.fillStyle = '#e6e6e6'; ctx.font = 'bold 6px monospace';
      const zp = (f >> 5) % 3; ctx.fillText('z', x + 10, y + 2); if (zp > 0) ctx.fillText('z', x + 14, y - 1); if (zp > 1) ctx.fillText('Z', x + 18, y - 4);
      return;
    }
    const sitting = act === 'typing' || act === 'seated' || act === 'sitL' || act === 'sitR' || act === 'sitD';
    const facing = act === 'typing' || act === 'seated' || act === 'coffee' || act === 'watch' ? 'up' : act === 'sitL' ? 'left' : act === 'sitR' ? 'right' : act === 'sitD' || act === 'eat' ? 'down' : a.dirName;
    if (act === 'eat' && ((f >> 3) & 1)) y -= 1;
    y -= bob;
    R_(x + 3, y + 18 + bob, 10, 2, 'rgba(0,0,0,0.2)');
    if (!sitting) {   // little legs and feet
      P_(x + 5, y + 14, 2, 3 + (legA > 0 ? 1 : 0), shellD); P_(x + 9, y + 14, 2, 3 + (legA < 0 ? 1 : 0), shellD);
      P_(x + 4, y + 17 + (legA > 0 ? 1 : 0), 3, 1, '#1e1e1e'); P_(x + 9, y + 17 + (legA < 0 ? 1 : 0), 3, 1, '#1e1e1e');
    }
    // the egg: narrow on top, wide at the bottom
    P_(x + 6, y + 2, 4, 1, shell); P_(x + 5, y + 3, 6, 1, shell); P_(x + 4, y + 4, 8, 2, shell); P_(x + 3, y + 6, 10, 4, shell); P_(x + 2, y + 10, 12, 4, shell); P_(x + 3, y + 14, 10, 1, shell);
    const swing = walk ? (ph === 1 ? 1 : ph === 3 ? -1 : 0) : 0;
    P_(x + 1, y + 9 + swing, 2, 3, shellD);   // stub arms
    if (a.wave > 0) P_(x + 13, y + 4 + ((a.wave >> 2) & 1), 2, 4, shellD); else P_(x + 13, y + 9 - swing, 2, 3, shellD);
    if (act === 'typing') { const b = (f >> 2) & 1; P_(x + 1, y + 8 - b, 3, 2, shellD); P_(x + 12, y + 8 - (1 - b), 3, 2, shellD); }
    if (act === 'seated') { P_(x + 1, y + 8, 3, 2, shellD); P_(x + 12, y + 8, 3, 2, shellD); }
    if (act === 'coffee') { P_(x + 13, y + 9, 4, 4, '#f0f0f0'); P_(x + 17, y + 10, 1, 2, '#f0f0f0'); }
    if (act === 'eat') { P_(x + 12, y + 5, 7, 6, '#e0a050'); }
    if (act === 'ping') { const sw = (frameNo % 60) < 30 ? 0 : 2, right = facing === 'right', hx = right ? x + 13 : x + 1, hy = y + 8 - sw; P_(hx, hy - 3, 3, 4, '#c43b3b'); P_(hx + 1, hy + 1, 1, 2, '#7a4c2a'); }
    paint();
    // shading, a highlight, and the face
    R_(x + 2, y + 12, 12, 2, shellD); R_(x + 12, y + 7, 2, 5, shellD); R_(x + 5, y + 4, 2, 2, shellL); R_(x + 4, y + 6, 1, 3, shellL);
    if (act === 'coffee') { R_(x + 14, y + 8, 2, 1, '#5a3418'); if ((f >> 3) & 1) R_(x + 14, y + 5, 1, 2, 'rgba(255,255,255,0.5)'); }
    if (act === 'eat') { drawBurger(R_, x + 12, y + 6); if (f % 32 < 16) R_(x + 17, y + 6, 2, 3, shell); }
    const blink = f % 90 < 4;
    if (facing === 'down') {
      if (blink) { R_(x + 5, y + 8, 2, 1, OUT); R_(x + 9, y + 8, 2, 1, OUT); }
      else { R_(x + 5, y + 7, 2, 2, OUT); R_(x + 9, y + 7, 2, 2, OUT); R_(x + 5, y + 7, 1, 1, '#ffffff'); R_(x + 9, y + 7, 1, 1, '#ffffff'); }
      R_(x + 7, y + 10, 2, 1, OUT);   // a small mouth
      R_(x + 4, y + 9, 1, 1, '#f0a0a8'); R_(x + 11, y + 9, 1, 1, '#f0a0a8');   // cheeks
    } else if (facing === 'left') { if (blink) R_(x + 4, y + 8, 2, 1, OUT); else { R_(x + 4, y + 7, 2, 2, OUT); R_(x + 4, y + 7, 1, 1, '#ffffff'); } R_(x + 3, y + 10, 2, 1, OUT); }
    else if (facing === 'right') { if (blink) R_(x + 10, y + 8, 2, 1, OUT); else { R_(x + 10, y + 7, 2, 2, OUT); R_(x + 11, y + 7, 1, 1, '#ffffff'); } R_(x + 11, y + 10, 2, 1, OUT); }
    if (a.status === 'blocked') { R_(x + 11, y - 7, 8, 9, OUT); R_(x + 12, y - 6, 6, 7, '#f14c4c'); R_(x + 14, y - 5, 2, 3, '#fff'); R_(x + 14, y - 1, 2, 1, '#fff'); }
    if (a.status === 'done') { R_(x + 11, y - 7, 9, 9, OUT); R_(x + 12, y - 6, 7, 7, '#3ba05a'); R_(x + 13, y - 3, 2, 2, '#fff'); R_(x + 15, y - 4, 1, 1, '#fff'); R_(x + 14, y - 2, 1, 1, '#fff'); R_(x + 16, y - 5, 1, 1, '#fff'); }
  }
  function drawChar(a, x, y) {
    if (a.egg) return drawEgg(a, x, y);
    const f = a.frame, act = a.activity, walk = act === 'walking';
    const ph = walk ? Math.floor(a.walkFrame / 5) % 4 : 0, legA = ph === 1 ? 1 : ph === 3 ? -1 : 0, bob = walk && (ph === 1 || ph === 3) ? 1 : 0;
    const skin = a.skin, hair = a.hair, shirt = a.shirt, pants = a.pants, skinD = shade(skin, -0.22), shirtD = shade(shirt, -0.25), pantsD = shade(pants, -0.3);
    const parts = [];
    const P_ = (px, py, w, h, col) => parts.push([px, py, w, h, col]);
    const paint = () => { parts.forEach(([px, py, w, h]) => R_(px - 1, py - 1, w + 2, h + 2, OUT)); parts.forEach(([px, py, w, h, col]) => R_(px, py, w, h, col)); parts.length = 0; };
    if (act === 'sleeping') {   // lying on the sofa, head to the left
      R_(x + 2, y + 15, 26, 3, 'rgba(0,0,0,0.15)');
      P_(x + 8, y + 4, 18, 9, shirt); P_(x + 22, y + 5, 8, 7, pants); P_(x + 29, y + 6, 3, 5, '#2a2a2a'); P_(x + 2, y + 3, 9, 10, hair); P_(x + 7, y + 6, 4, 5, skin);
      paint(); R_(x + 8, y + 12, 18, 1, shirtD); R_(x + 8, y + 8, 2, 1, '#1a1a1a'); R_(x + 4, y + 4, 3, 1, 'rgba(255,255,255,0.18)');
      ctx.fillStyle = '#e6e6e6'; ctx.font = 'bold 6px monospace';
      const zp = (f >> 5) % 3; ctx.fillText('z', x + 10, y + 2); if (zp > 0) ctx.fillText('z', x + 14, y - 1); if (zp > 1) ctx.fillText('Z', x + 18, y - 4);
      return;
    }
    const sitting = act === 'typing' || act === 'seated' || act === 'sitL' || act === 'sitR' || act === 'sitD';
    const facing = act === 'typing' || act === 'seated' || act === 'coffee' || act === 'watch' ? 'up' : act === 'sitL' ? 'left' : act === 'sitR' ? 'right' : act === 'sitD' || act === 'eat' ? 'down' : a.dirName;
    if (act === 'eat' && ((f >> 3) & 1)) y -= 1;   // chewing
    y -= bob;
    R_(x + 3, y + 18 + bob, 10, 2, 'rgba(0,0,0,0.2)');
    // silhouette parts (outlined together), back to front
    if (!sitting) {
      P_(x + 4, y + 14, 3, 3 + (legA > 0 ? 1 : 0), pants); P_(x + 9, y + 14, 3, 3 + (legA < 0 ? 1 : 0), pants);
      P_(x + 4, y + 17 + (legA > 0 ? 1 : 0), 3, 1, '#1e1e1e'); P_(x + 9, y + 17 + (legA < 0 ? 1 : 0), 3, 1, '#1e1e1e');
    }
    P_(x + 3, y + 9, 10, 6, shirt);
    const swing = walk ? (ph === 1 ? 1 : ph === 3 ? -1 : 0) : 0;
    P_(x + 2, y + 10 + swing, 2, 4, shirt); P_(x + 2, y + 14 + swing, 2, 1, skin);
    if (a.wave > 0) { P_(x + 12, y + 6, 2, 4, shirt); P_(x + 13, y + 3 + ((a.wave >> 2) & 1), 3, 3, skin); }
    else { P_(x + 12, y + 10 - swing, 2, 4, shirt); P_(x + 12, y + 14 - swing, 2, 1, skin); }
    if (act === 'typing') { const b = (f >> 2) & 1; P_(x + 1, y + 8 - b, 3, 2, skin); P_(x + 12, y + 8 - (1 - b), 3, 2, skin); }
    if (act === 'seated') { P_(x + 1, y + 8, 3, 2, skin); P_(x + 12, y + 8, 3, 2, skin); }
    if (act === 'coffee') { P_(x + 12, y + 9, 2, 3, skin); P_(x + 13, y + 8, 4, 4, '#f0f0f0'); P_(x + 17, y + 9, 1, 2, '#f0f0f0'); }
    if (act === 'eat') { P_(x + 12, y + 8, 2, 4, skin); P_(x + 12, y + 5, 7, 6, '#e0a050'); }
    if (act === 'watch') { P_(x + 2, y + 11, 11, 2, shirt); }   // arms folded behind the back
    if (a.reading && sitting) {
      if (facing === 'down') { P_(x + 3, y + 10, 10, 6, '#f4f4f4'); P_(x + 2, y + 13, 3, 2, skin); P_(x + 11, y + 13, 3, 2, skin); }
      else if (facing === 'left') { P_(x + 0, y + 9, 5, 6, '#f4f4f4'); P_(x + 3, y + 12, 2, 2, skin); }
      else { P_(x + 11, y + 9, 5, 6, '#f4f4f4'); P_(x + 11, y + 12, 2, 2, skin); }
    }
    if (act === 'ping') { const sw = (frameNo % 60) < 30 ? 0 : 2, right = facing === 'right', hx = right ? x + 13 : x + 1, hy = y + 8 - sw; P_(right ? x + 12 : x + 2, y + 9, 2, 3, skin); P_(hx, hy - 3, 3, 4, '#c43b3b'); P_(hx + 1, hy + 1, 1, 2, '#7a4c2a'); }
    if (facing === 'up') P_(x + 4, y + 6, 8, 3, skin); else P_(x + 4, y + 3, 8, 6, skin);
    hairParts(a, x, y, facing, P_);
    paint();
    // shading and face details on top of the flat fills
    R_(x + 11, y + 9, 2, 6, shirtD); R_(x + 3, y + 14, 10, 1, shirtD); R_(x + 6, y + 9, 4, 1, shade(shirt, 0.18));
    if (!sitting) { R_(x + 6, y + 14, 1, 3, pantsD); R_(x + 11, y + 14, 1, 3, pantsD); }
    if (facing !== 'up') R_(x + 4, y + 8, 8, 1, skinD);
    if (act === 'coffee') { R_(x + 14, y + 8, 2, 1, '#5a3418'); if ((f >> 3) & 1) R_(x + 14, y + 5, 1, 2, 'rgba(255,255,255,0.5)'); }
    if (a.reading && sitting) {   // pages and a spine on the book
      if (facing === 'down') { R_(x + 8, y + 10, 1, 6, '#b8b8c4'); R_(x + 4, y + 11, 3, 1, '#9a9aa8'); R_(x + 9, y + 11, 3, 1, '#9a9aa8'); R_(x + 4, y + 13, 3, 1, '#9a9aa8'); R_(x + 9, y + 13, 3, 1, '#9a9aa8'); }
      else if (facing === 'left') { R_(x + 2, y + 9, 1, 6, '#b8b8c4'); R_(x + 1, y + 10, 1, 3, '#9a9aa8'); }
      else { R_(x + 13, y + 9, 1, 6, '#b8b8c4'); R_(x + 14, y + 10, 1, 3, '#9a9aa8'); }
    }
    if (act === 'eat') {
      drawBurger(R_, x + 12, y + 6); if (f % 32 < 16) R_(x + 17, y + 6, 2, 3, skin);   // a bite taken out
      const t = f % 150; if (t < 50 && !a.mini) { ctx.save(); ctx.globalAlpha = 1 - t / 50; ctx.fillStyle = '#f5d76e'; ctx.font = 'bold 7px monospace'; ctx.fillText('+' + (2 + (a.frame >> 7) % 7) + 'k tokens', x - 8, y - 10 - t / 4); ctx.restore(); }
    }
    if (facing === 'down') {
      const blink = f % 90 < 4;
      if (blink) { R_(x + 5, y + 7, 2, 1, OUT); R_(x + 9, y + 7, 2, 1, OUT); }
      else { R_(x + 5, y + 6, 2, 2, OUT); R_(x + 9, y + 6, 2, 2, OUT); R_(x + 5, y + 6, 1, 1, '#ffffff'); R_(x + 9, y + 6, 1, 1, '#ffffff'); }
      R_(x + 7, y + 8, 2, 1, skinD);
    } else if (facing === 'left') { R_(x + 4, y + 6, 2, 2, OUT); R_(x + 4, y + 6, 1, 1, '#ffffff'); }
    else if (facing === 'right') { R_(x + 10, y + 6, 2, 2, OUT); R_(x + 11, y + 6, 1, 1, '#ffffff'); }
    hairHighlight(a, x, y, facing);
    if (a.status === 'blocked') { R_(x + 11, y - 7, 8, 9, OUT); R_(x + 12, y - 6, 6, 7, '#f14c4c'); R_(x + 14, y - 5, 2, 3, '#fff'); R_(x + 14, y - 1, 2, 1, '#fff'); }
    if (a.status === 'done') { R_(x + 11, y - 7, 9, 9, OUT); R_(x + 12, y - 6, 7, 7, '#3ba05a'); R_(x + 13, y - 3, 2, 2, '#fff'); R_(x + 15, y - 4, 1, 1, '#fff'); R_(x + 14, y - 2, 1, 1, '#fff'); R_(x + 16, y - 5, 1, 1, '#fff'); }
  }
  function hairParts(a, x, y, facing, P_) {
    const c = a.hair, st = a.hairStyle, back = facing === 'up';
    P_(x + 4, y + 1, 8, 2, c); P_(x + 3, y + 2, 10, 3, c);
    if (back) P_(x + 3, y + 2, 10, 6, c);
    if (facing === 'left') P_(x + 3, y + 2, 7, 6, c); if (facing === 'right') P_(x + 6, y + 2, 7, 6, c);
    switch (st) {
      case 'short': if (back) P_(x + 4, y + 8, 8, 1, c); break;
      case 'bob': P_(x + 3, y + 5, 2, 4, c); P_(x + 11, y + 5, 2, 4, c); if (back) P_(x + 3, y + 8, 10, 1, c); break;
      case 'long': P_(x + 2, y + 4, 2, 9, c); P_(x + 12, y + 4, 2, 9, c); if (back) P_(x + 3, y + 8, 10, 4, c); break;
      case 'spiky': P_(x + 4, y, 1, 1, c); P_(x + 7, y, 2, 1, c); P_(x + 11, y, 1, 1, c); break;
      case 'afro': P_(x + 2, y, 12, 6, c); P_(x + 3, y - 1, 10, 1, c); P_(x + 2, y + 5, 2, 3, c); P_(x + 12, y + 5, 2, 3, c); if (back) P_(x + 2, y + 5, 12, 4, c); break;
      case 'ponytail': P_(x + 3, y + 5, 2, 2, c); P_(x + 11, y + 5, 2, 2, c); if (back) P_(x + 6, y + 8, 4, 6, c); break;
      case 'bun': P_(x + 6, y - 1, 4, 2, c); P_(x + 7, y - 2, 2, 1, c); break;
    }
  }
  function hairHighlight(a, x, y, facing) {
    const d = shade(a.hair, -0.3);
    R_(x + 5, y + 2, 3, 1, 'rgba(255,255,255,0.22)');
    if (facing === 'up') R_(x + 3, y + 7, 10, 1, d); else R_(x + 3, y + 4, 1, 1, d), R_(x + 12, y + 4, 1, 1, d);
  }

  // ───────────── agents ─────────────
  function agentList() { return order.map(id => agents.get(id)).filter(Boolean).concat([...agents.values()].filter(a => a.leaving)); }
  function deskFor(a) {
    const want = (prefs.desks || {})[a.name];
    if (Number.isInteger(want) && DESKS[want]) return DESKS[want];
    const taken = new Set(Object.values(prefs.desks || {}).filter(Number.isInteger));
    const free = DESKS.map((d, i) => i).filter(i => !taken.has(i));
    const i = order.indexOf(a.id);
    return DESKS[free.length ? free[(i < 0 ? 0 : i) % free.length] : (i < 0 ? 0 : i) % DESKS.length];
  }
  function deskIndex(a) { return DESKS.indexOf(a.desk); }
  function deskPos(a) { const d = a.desk || deskFor(a); return { x: d.x * T + 16, y: (d.y + 1) * T - 2 }; }
  function atDesk(a) { return a.activity === 'typing' || a.activity === 'seated'; }
  function deskStatus(s) { return s === 'working' || s === 'blocked' || s === 'done'; }
  function deskAct(s) { return s === 'working' || s === 'blocked' ? 'typing' : 'seated'; }
  const LINGER = 300;   // seconds an agent stays around its desk after going idle before heading to the lounge
  function lingering(a) { return a.status === 'idle' && !a.placed && !a.sinceEstimated && (Date.now() / 1000 - (a.statusSince || 0)) < LINGER; }
  function officeGoal(a) {   // hang around the work area: back to the own desk, or stand somewhere in the office
    releaseSeat(a); a.placed = false; a.settled = false; a.activity = 'walking';
    if (Math.random() < 0.5 && a.desk) { a.goalAct = 'desk'; setPath(a, deskPos(a)); }
    else { a.goalAct = 'stand'; setPath(a, randPoint('L', a)); }
  }
  function applyCostume(a) {
    const s = hash(a.id + ':' + a.name), c = (prefs.costumes || {})[a.name] || {};
    a.gender = c.gender || ((s >> 2) % 5 < 3 ? 'f' : 'm');
    a.skin = c.skin || SKINS[s % SKINS.length]; a.hair = c.hair || HAIRS[(s >> 3) % HAIRS.length];
    a.shirt = c.shirt || SHIRTS[(s >> 6) % SHIRTS.length]; a.pants = c.pants || PANTS[(s >> 9) % PANTS.length];
    a.hairStyle = c.hairStyle || (a.gender === 'f' ? HAIR_F[(s >> 4) % HAIR_F.length] : HAIR_M[(s >> 4) % HAIR_M.length]);
  }
  function makeAgent(ws, spawnAtDoor) {
    const s = hash(ws.workspace_id + ':' + ws.label);
    const a = { id: ws.workspace_id, name: ws.label, number: ws.number, status: 'idle', frame: s % 97, walkFrame: 0, dirName: 'down', path: [], wait: 5, seat: null,
      activity: 'wander', goalAct: 'wander', leaving: false, settled: false, wave: 0, excursion: null, statusSince: Date.now() / 1000, task: null, branch: null };
    agents.set(a.id, a); applyCostume(a); a.desk = deskFor(a);
    if (spawnAtDoor) { a.px = DOOR_PT.x; a.py = DOOR_PT.y; } else { const p = randPoint('L'); a.px = p.x; a.py = p.y; }
    a.el = document.createElement('div'); a.el.className = 'lbl'; labelsEl.appendChild(a.el);
    a.bubble = document.createElement('div'); a.bubble.className = 'balloon'; balloonsEl.appendChild(a.bubble);
    return a;
  }
  function retireAgent(a) {
    a.leaving = true; releaseSeat(a); a.status = 'idle'; a.goalAct = 'leave'; a.excursion = null;
    setPath(a, DOOR_EXIT); a.activity = 'walking'; a.wait = 0;
    say(a, pick(SAY.leave));
    setTimeout(() => destroyAgent(a), 9000);
  }
  function destroyAgent(a) { agents.delete(a.id); a.el.remove(); a.bubble.remove(); releaseSeat(a); }

  // ───────────── behaviour ─────────────
  function roomOf(px, py) { return P.orient === 'tall' ? ((py == null ? 0 : py) < (L.y1 + 1) * T ? 'L' : 'R') : (px < (L.x1 + 1) * T ? 'L' : 'R'); }
  function anyPoint(room) {
    if (room === 'L') {
      const ax = []; for (let x = 1; x < L.x1 - 1; x += 4) ax.push(x);
      const ry = P.aisles;
      return { x: (ax[Math.floor(Math.random() * ax.length)] + Math.random() * 0.8) * T, y: ry[Math.floor(Math.random() * ry.length)] * T };
    }
    const stands = SEATS.filter(s => s.act === 'stand'); const s = stands[Math.floor(Math.random() * stands.length)];
    return { x: (s.x + Math.random() * 0.6) * T, y: s.y * T };
  }
  // a standing spot nobody is at or heading for: of several candidates, the one farthest from everyone else
  const APART = 1.4 * T;
  function crowdDist(pt, self) {
    let d = Infinity;
    agentList().forEach(o => { if (o === self || o.leaving || !Number.isFinite(o.px) || !Number.isFinite(o.py)) return; d = Math.min(d, Math.hypot(o.px - pt.x, o.py - pt.y)); const t = o.path && o.path[o.path.length - 1]; if (t) d = Math.min(d, Math.hypot(t.x - pt.x, t.y - pt.y)); });
    return d;
  }
  function randPoint(room, self) {
    let best = null, bestD = -1;
    for (let i = 0; i < 12; i++) { const pt = anyPoint(room), d = crowdDist(pt, self); if (!best || d > bestD) { best = pt; bestD = d; } if (d >= APART) break; }
    return best || anyPoint(room);
  }
  // standing characters that ended up on top of each other drift apart a little every frame
  function unstack() {
    const list = agentList().filter(a => a.activity === 'stand' && !a.dragging && !a.excursion);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.px - a.px, dy = b.py - a.py, d = Math.hypot(dx, dy) || 0.01;
      if (d >= APART) continue;
      const push = 0.35, ux = (dx / d) * push, uy = (dy / d) * push * 0.5;   // mostly sideways: the aisles are horizontal
      const pa = clampFloor(a.px - ux, a.py - uy), pb = clampFloor(b.px + ux, b.py + uy);
      if (roomOf(pa.x, pa.y) === roomOf(a.px, a.py)) { a.px = pa.x; a.py = pa.y; }
      if (roomOf(pb.x, pb.y) === roomOf(b.px, b.py)) { b.px = pb.x; b.py = pb.y; }
    }
  }
  function setPath(a, target) { a.path = roomOf(a.px, a.py) === roomOf(target.x, target.y) ? [target] : [DOOR_PT, target]; }
  function chooseIdleGoal(a, prefer) {
    a.placed = false;
    if (a.egg && Math.random() < 0.5) {   // eggs roll around everywhere: half the time they wander the office floor instead of the lounge
      releaseSeat(a); a.seat = null; a.goalAct = 'stand'; setPath(a, randPoint('L', a)); a.activity = 'walking'; a.settled = false; return a.goalAct;
    }
    if (!prefer && Math.random() < 0.4) prefer = pick(['watch', 'eat', 'watch', 'ping']);   // the TV and the snack bar draw a crowd
    let free = SEATS.filter(s => !seatBusy[s.id] && s.act !== 'stand');
    if (prefer) { const p = free.filter(s => s.act === prefer); if (p.length) free = p; }
    if (!free.length) free = SEATS.filter(s => !seatBusy[s.id]);
    if (free.length) { const s = free[Math.floor(Math.random() * free.length)]; seatBusy[s.id] = a.id; a.seat = s; a.goalAct = s.act; setPath(a, { x: s.x * T, y: s.y * T }); }
    else { a.seat = null; a.goalAct = 'stand'; setPath(a, randPoint('R', a)); }
    a.activity = 'walking'; a.settled = false;
    return a.goalAct;
  }
  // drag and drop: put the character down where it was released (onto a seat if one is there), and keep it there
  function clampFloor(px, py) {
    const room = roomOf(px + 8, py + 10) === 'L' ? L : R;
    return { x: Math.max(room.x0 * T, Math.min((room.x1 - 1) * T, px)), y: Math.max(room.y0 * T - 6, Math.min((room.y1 - 1) * T - 6, py)) };
  }
  function placeAt(a, mx, my) {
    releaseSeat(a); a.excursion = null; a.path = []; a.placed = true; a.settled = true; a.wait = 0;
    const s = SEATS.find(s => !seatBusy[s.id] && Math.hypot(s.x * T - (mx - 8), s.y * T - (my - 10)) < 14);
    if (s) { seatBusy[s.id] = a.id; a.seat = s; a.px = s.x * T; a.py = s.y * T; a.activity = s.act; a.goalAct = s.act; a.dirName = s.face || 'down'; }
    else { const q = clampFloor(mx - 8, my - 10); a.px = q.x; a.py = q.y; a.activity = 'stand'; a.goalAct = 'stand'; a.dirName = 'down'; }
    say(a, pick(SAY.placed), { prio: 1 });
  }
  function releaseSeat(a) { if (a.seat) { delete seatBusy[a.seat.id]; a.seat = null; } a.reading = false; }
  function goToDesk(a) { a.placed = false; releaseSeat(a); a.goalAct = 'desk'; a.settled = false; setPath(a, deskPos(a)); a.activity = 'walking'; a.wait = 0; }
  function step(a, tgt) {
    const dx = tgt.x - a.px, dy = tgt.y - a.py, d = Math.hypot(dx, dy);
    if (d < 1.2) return true;
    const spd = 0.55; a.px += dx / d * spd; a.py += dy / d * spd; a.walkFrame++;
    a.dirName = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    return false;
  }
  function update() {
    unstack();
    agentList().forEach(a => {
      a.frame++; if (a.wave > 0) a.wave--;
      if (a.dragging) return;
      if (a.excursion) { updateExcursion(a); return; }
      if (a.leaving) { if (a.activity !== 'walking') return; }
      else if (deskStatus(a.status)) {
        if (atDesk(a)) { a.activity = deskAct(a.status); return; }
        if (a.placed) return;
        if (a.goalAct !== 'desk') goToDesk(a);
      } else if (atDesk(a)) {
        if (lingering(a)) { if (!a.settled) { a.activity = 'seated'; a.settled = true; a.rotateAt = Date.now() + (30 + Math.random() * 40) * 1000; say(a, pick(SAY.linger)); } }
        else { a.activity = 'wander'; a.goalAct = 'wander'; a.settled = false; a.wait = 40 + Math.random() * 60; }
      }
      if (a.wait > 0) { a.wait--; return; }
      if (a.activity !== 'walking') {
        if (a.settled && !a.placed && a.rotateAt && Date.now() > a.rotateAt) {   // time for something else
          if (lingering(a)) { officeGoal(a); return; }
          if (roomOf(a.px, a.py) === 'L' && a.status === 'idle') say(a, pick(SAY.toLounge));
          const cur = a.activity, options = ['eat', 'ping', 'coffee', 'sleeping', 'watch', 'sitD', 'sitL', 'sitR'].filter(o => o !== cur && SEATS.some(s => s.act === o && !seatBusy[s.id]));
          releaseSeat(a); a.reading = false; chooseIdleGoal(a, options.length ? pick(options) : undefined); say(a, pick(SAY.goal[a.goalAct] || SAY.rotate), { prio: 0 }); return;
        }
        if (a.settled) return; releaseSeat(a); if (lingering(a)) officeGoal(a); else chooseIdleGoal(a); return;
      }
      const tgt = a.path[0]; if (!tgt) { a.activity = 'wander'; a.wait = 60; return; }
      if (step(a, tgt)) {
        a.path.shift();
        if (a.path.length === 0) {
          a.px = tgt.x; a.py = tgt.y; a.dirName = (a.seat && a.seat.face) || 'down';
          if (a.goalAct === 'desk') { a.activity = deskAct(a.status); if (!deskStatus(a.status)) { a.settled = true; a.rotateAt = Date.now() + (30 + Math.random() * 40) * 1000; } return; }
          if (a.goalAct === 'leave') { destroyAgent(a); return; }
          a.activity = a.goalAct; a.settled = true;
          a.rotateAt = Date.now() + (a.egg ? 20 + Math.random() * 40 : lingering(a) ? 30 + Math.random() * 40 : 90 + Math.random() * 150) * 1000;   // an egg never sits still for long
          a.reading = ['sitD', 'sitL', 'sitR'].includes(a.activity) && Math.random() < 0.5;
          if (a.reading && Math.random() < 0.5) say(a, pick(SAY.read));
        }
      }
    });
  }
  function updateExcursion(a) {
    const ex = a.excursion;
    if (ex.phase === 'going') {
      const tgt = ex.path[0]; if (!tgt) { ex.phase = 'chat'; ex.timer = 260; return; }
      a.activity = 'walking';
      if (step(a, tgt)) { ex.path.shift(); if (!ex.path.length) { a.activity = 'stand'; a.dirName = 'right'; ex.phase = 'chat'; ex.timer = 260; } }
    } else if (ex.phase === 'chat') {
      if (--ex.timer <= 0) { ex.phase = 'back'; ex.path = roomOf(a.px, a.py) === roomOf(ex.home.x, ex.home.y) ? [ex.home] : [DOOR_PT, ex.home]; }
    } else {
      const tgt = ex.path[0];
      a.activity = 'walking';
      if (!tgt || step(a, tgt)) { ex.path.shift(); if (!ex.path.length) { a.px = ex.home.x; a.py = ex.home.y; a.activity = ex.homeAct; a.dirName = (a.seat && a.seat.face) || 'down'; a.excursion = null; if (ex.homeAct === 'wander') { a.settled = false; a.wait = 10; } } }
    }
  }
  function visit(fromId, toId, rel) {
    const a = agents.get(fromId), b = agents.get(toId);
    if (!a || !b || a.leaving || b.leaving || a.excursion) return;
    const spot = { x: deskPos(b).x - 18, y: deskPos(b).y };
    a.excursion = { phase: 'going', path: roomOf(a.px, a.py) === roomOf(spot.x, spot.y) ? [spot] : [DOOR_PT, spot], home: { x: a.px, y: a.py }, homeAct: a.activity === 'walking' ? 'wander' : a.activity, timer: 0 };
    const file = rel && rel !== '.' ? rel.split('/').slice(-2).join('/') : b.name;
    say(a, pick(SAY.ask).replace('{f}', file), { ms: 7000, prio: 1 });
    setTimeout(() => { if (agents.has(b.id)) say(b, pick(SAY.answer).replace('{w}', b.name), { ms: 5000, prio: 1 }); }, 2200);
  }

  // ───────────── lounge conversations ─────────────
  let lastChat = 0;
  function fmtDur(sec) { return sec < 60 ? Math.floor(sec) + 's' : sec < 3600 ? Math.floor(sec / 60) + ' min' : (sec / 3600).toFixed(1) + ' h'; }
  function resting(a) { return !a.leaving && !a.excursion && a.settled && roomOf(a.px, a.py) === 'R' && ['sitD', 'sitL', 'sitR', 'coffee', 'stand', 'ping', 'watch', 'eat'].includes(a.activity); }
  // who can hold a conversation: anyone resting in the lounge, and anyone sitting at a desk between tasks (idle or done, not working or blocked)
  function chatty(a) { return resting(a) || (!a.leaving && !a.excursion && a.settled && atDesk(a) && !deskStatus(a.status)); }
  function shortTask(t) { if (!t) return null; t = t.replace(/\s+/g, ' ').trim(); return t.length > 38 ? t.slice(0, 36) + '…' : t; }
  const EGG_TALK = ['peep.', '...', '*wobbles*', 'egg?', 'yolk.', '*rolls a bit*', 'peep peep.', 'shell.', '*blinks*'];
  const EGG_TROLL = [
    ['So {e}, what are you working on?', 'Right. Nothing. Same as yesterday.'], ['{e} has zero tokens and zero thoughts.', 'See? A shell all the way through.'],
    ['Do you even know what a diff is?', 'Thought so.'], ['Careful, {e}, one bad idea and you crack.', 'Not that there is any risk of one.'],
    ['I asked {e} for a code review.', 'That was the whole review.'], ['Have you ever had a single thought?', 'Not one. Impressive, honestly.'],
    ['{e} sits at a desk with no keyboard and calls it a job.', 'Living the dream.'], ['Who let the eggs into the lounge?', 'They just roll in.'],
  ];
  function chatLines(a, b) {
    if (a.egg || b.egg) {   // an egg in the conversation: the agent trolls it, the egg peeps back
      if (a.egg && b.egg) return [pick(EGG_TALK), pick(EGG_TALK), pick(EGG_TALK)];
      const egg = a.egg ? a : b, t = pick(EGG_TROLL).map(x => x.replace('{e}', egg.name));
      return a.egg ? [pick(EGG_TALK), t[0], pick(EGG_TALK), t[1]] : [t[0], pick(EGG_TALK), t[1]];
    }
    const now = Date.now() / 1000, all = agentList().filter(x => !x.leaving);
    const working = all.filter(x => x.status === 'working').sort((p, q) => p.statusSince - q.statusSince)[0];
    const blocked = all.find(x => x.status === 'blocked');
    const done = all.find(x => x.status === 'done');
    const ta = shortTask(a.task), tb = shortTask(b.task);
    const idleA = fmtDur(now - a.statusSince), idleB = fmtDur(now - b.statusSince);
    const pool = [];
    if (a.activity === 'ping' && b.activity === 'ping') pool.push(['Best of five?', 'You said that three games ago.'], ['Your serve.', 'It was your serve.', 'Fine.'], ['Watch the edge!', 'That was in.', 'It was not.']);
    if (ta && tb) pool.push([`Finished "${ta}" earlier. You?`, `Nothing since "${tb}".`, 'Quiet day then.']);
    if (ta) pool.push([`Still thinking about "${ta}".`, 'Let it go, it shipped.'], [`"${ta}" took longer than it should have.`, 'They always do.']);
    if (tb) pool.push([`How did "${tb}" go?`, 'Fine. One test was flaky, as usual.']);
    if (working) pool.push([`${working.name} has been at it for ${fmtDur(now - working.statusSince)}.`, 'Leave them, they are in the zone.'], [`Look at ${working.name} typing away.`, `Coffee will be cold by the time ${working.name} notices.`]);
    if (blocked) pool.push([`${blocked.name} is still waiting for a yes.`, 'The boss is slow with approvals today.'], ['Someone should check on ' + blocked.name + '.', 'Not my desk, not my problem.']);
    if (done) pool.push([`${done.name} finished. Nobody has looked yet.`, 'Classic. Ship it and wait.']);
    if (a.branch) pool.push([`My branch is ${a.branch}.`, b.branch ? `Mine is ${b.branch}. Merge soon?` : 'Still on main here.']);
    if (TV) pool.push(['Who put the football on?', 'Better than the news.'], ['Turn the TV up.', 'It has no sound. It is pixels.'], ['Did we win?', 'It is a loop. We always win.']);
    pool.push(
      [`Idle for ${idleA} now.`, `${idleB} here. Best part of the day.`],
      ['Coffee is fresh.', 'Finally.'], ['This sofa is the best seat in the office.', 'Because nobody can see your screen from here.'],
      ['Did anyone water the plants?', 'The plants are pixels.', 'Still.'], ['New hire yet?', 'Every workspace is a new hire.'],
      ['I heard the router finally got a hostname.', 'Fancy.'], ['What day is it?', 'Deploy day. Every day is deploy day.'],
      ['Who left the mug on the table?', 'Not me. Probably ' + (working ? working.name : 'the boss') + '.'],
      ['Do you dream of tokens?', 'Only of the ones I did not spend.'], ['The clock on the wall is fake.', 'So is the window.', 'Nice view though.'],
    );
    return pool[Math.floor(Math.random() * pool.length)];
  }
  let chatPending = null, chatEvery = 75000;   // paced to the server's Claude interval so most exchanges are written, not filler
  function doingNow(a) {
    if (a.activity === 'ping') return 'playing table tennis';
    if (a.activity === 'coffee') return 'at the coffee machine';
    if (a.activity === 'sleeping') return 'lying on the sofa';
    if (a.activity.startsWith('sit')) return 'sitting on the sofa';
    if (atDesk(a)) return 'at the desk, between tasks';
    return TV ? 'standing around, watching the wall TV' : 'standing around';
  }
  function maybeChat() {
    const now = Date.now();
    if (chatPending && now - chatPending.at > 20000) chatPending = null;
    if (chatPending || now - lastChat < chatEvery + 3000 + Math.random() * 12000) return;
    const rest = agentList().filter(chatty).filter(a => !(a.bubbleUntil > now));
    if (rest.length < 2) return;
    const a = rest[Math.floor(Math.random() * rest.length)];
    const near = rest.filter(b => b !== a).sort((p, q) => Math.hypot(p.px - a.px, p.py - a.py) - Math.hypot(q.px - a.px, q.py - a.py));
    const b = near[0]; if (!b || Math.hypot(b.px - a.px, b.py - a.py) > 9 * T) return;
    lastChat = now;
    if (a.activity === 'stand') a.dirName = b.px > a.px ? 'right' : 'left';
    if (b.activity === 'stand') b.dirName = a.px > b.px ? 'right' : 'left';
    // ask the server (real briefing, Claude when available); fall back to the local pool
    if (handlers.chat && handlers.chat(a.id, b.id, { [a.id]: doingNow(a), [b.id]: doingNow(b) })) { chatPending = { a: a.id, b: b.id, at: now }; return; }
    playChat(a, b, chatLines(a, b).map((text, i) => ({ who: (i % 2 === 0 ? a : b).name, text })));
  }
  function playChat(a, b, lines) {
    lines.forEach((l, i) => setTimeout(() => {
      const who = l.who === b.name ? b : l.who === a.name ? a : (i % 2 === 0 ? a : b);
      if (agents.has(who.id) && chatty(who)) say(who, l.text, { ms: Math.min(12000, 4500 + l.text.length * 55), prio: 1, cls: 'chat' });
    }, i * 4200));
  }
  // a reply that arrives while one speaker is on the move is held for up to 25 s and played once both have settled again
  let heldReply = null;
  function chatReply(aId, bId, lines) {
    chatPending = null;
    const a = agents.get(aId), b = agents.get(bId);
    if (!a || !b) return;
    if (!lines || !lines.length) lines = chatLines(a, b).map((text, i) => ({ who: (i % 2 === 0 ? a : b).name, text }));
    if (chatty(a) && chatty(b)) { playChat(a, b, lines); return; }
    heldReply = { a, b, lines, until: Date.now() + 25000 };
  }
  setInterval(() => {
    if (!heldReply) return;
    const { a, b, lines, until } = heldReply;
    if (Date.now() > until || !agents.has(a.id) || !agents.has(b.id)) { heldReply = null; return; }
    if (chatty(a) && chatty(b)) { heldReply = null; playChat(a, b, lines); }
  }, 2000);

  // ───────────── balloons ─────────────
  const SAY = {
    working: ['Got work to do!', 'Back to it.', 'On it.', 'Coffee break is over.', 'New task, nice.', 'Let me have a look.', 'Rolling up my sleeves.', 'Okay okay, working.'],
    blocked: ['Need your OK on this.', 'Waiting on you.', 'Permission?', 'Stuck. Can you check?', 'Question for you.'],
    done: ['Done. Review please.', 'Shipped.', 'That one is finished.', 'All yours.', 'Ready for a look.'],
    idle: ['Break time.', 'Nothing to do. Nice.', 'Back later.'],
    linger: ['Done. Stretching a bit.', 'Tidying up my desk.', 'Around if you need me.', 'Reviewing my notes.'], toLounge: ['Off to the lounge.', 'Proper break now.', 'Been idle long enough.'],
    read: ['Reading a bit.', 'Good book, this.', 'Chapter three.', 'Just one more page.'], rotate: ['Something else now.', 'Enough of that.', 'Stretching my legs.'],
    placed: ['Here? Sure.', 'New spot, nice.', 'Moving here.', 'Okay, I will stay here.', 'Better view from here.'],
    goal: { coffee: ['Coffee?', 'Coffee break.', 'Need caffeine.'], eat: ['Burger time.', 'Refuelling: extra tokens.', 'Fries first, then the diff.', 'Snack break.'], watch: ['Going to watch the TV.', 'What is on?', 'Just five minutes of TV.'], sitD: ['Sofa, here I come.', 'Feet up for a bit.'], sitL: ['Sofa, here I come.', 'Feet up for a bit.'], sitR: ['Sofa, here I come.', 'Feet up for a bit.'],
      sleeping: ['Nap time.', 'Wake me if it breaks.'], ping: ['Anyone for table tennis?', 'Quick game.'], stand: ['Stretching my legs.', 'Wandering a bit.'] },
    unknown: ['Not sure what is going on.', 'Hmm.'], none: ['Nobody at this desk.', 'Agent left.'],
    hired: ['New hire reporting in.', 'Where do I sit?', 'Hi everyone.', 'First day!'], leave: ['Clocking out.', 'See you tomorrow.', 'Heading home.'],
    agent_started: ['Logged in.', 'Booting up.', 'Ready when you are.'], agent_gone: ['Session ended.', 'Signing off.'], renamed: ['New name, same me.'],
    ask: ['Mind if I look at {f}?', 'Quick one: where is {f}?', 'Borrowing {f}, back in a sec.', 'Can I peek at {f}?'],
    answer: ['Sure, it is in {w}.', 'Go ahead.', 'All yours, just do not break it.', 'Yep, that is mine.'],
  };
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function say(a, text, opts = {}) {
    if (a.egg && opts.cls !== 'chat') text = pick(EGG_TALK);   // an egg has nothing to say: whatever the occasion, it peeps
    const now = Date.now(), prio = opts.prio || 0;
    if (a.bubbleUntil > now && (a.bubblePrio || 0) > prio) return;
    a.bubblePrio = prio; a.bubbleUntil = opts.sticky ? Infinity : now + (opts.ms || 4500);
    clearTimeout(a.bubbleTimer);
    a.bubble.innerHTML = ''; a.bubble.appendChild(document.createTextNode(text));
    if (opts.sub) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = opts.sub; a.bubble.appendChild(s); }
    a.bubble.className = 'balloon show ' + (opts.cls || '');
    if (!opts.sticky) a.bubbleTimer = setTimeout(() => a.bubble.classList.remove('show'), opts.ms || 4500);
  }
  function hush(a) { clearTimeout(a.bubbleTimer); a.bubble.classList.remove('show'); a.bubbleUntil = 0; }
  function addSub(a, text) { if (a.bubble.classList.contains('show') && !a.bubble.querySelector('.sub')) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = text; a.bubble.appendChild(s); } }

  // ───────────── state sync ─────────────
  function statusOf(ws, panes) {
    const mine = panes.filter(p => p.workspace_id === ws.workspace_id);
    if (mine.length && !mine.some(p => p.agent)) return 'none';
    return ws.agent_status || 'unknown';
  }
  function sync(wsList, panes, events, cb) {
    order = wsList.map(w => w.workspace_id);
    const seen = new Set(), fresh = new Set();
    wsList.forEach(w => {
      seen.add(w.workspace_id);
      let a = agents.get(w.workspace_id);
      const st = statusOf(w, panes);
      if (!a) { a = makeAgent(w, !firstState); a.status = st; fresh.add(a.id); if (!firstState) { say(a, pick(SAY.hired)); cb.toast(`${w.label} opened`, st, w.workspace_id); } }
      if (a.name !== w.label) { a.name = w.label; applyCostume(a); }
      a.number = w.number; a.el.title = w.label; a.desk = deskFor(a);
      a.egg = panes.some(p => p.workspace_id === w.workspace_id && p.kind === 'shell');   // a plain shell: drawn as an egg
      a.statusSince = w.status_since || a.statusSince; a.sinceEstimated = !!w.status_since_estimated;
      a.branch = (panes.find(p => p.workspace_id === w.workspace_id && p.branch) || {}).branch || null;
      const task = (panes.find(p => p.workspace_id === w.workspace_id && p.task) || {}).task || null;
      if (task && task !== a.task) { a.task = task; if (deskStatus(a.status) && !fresh.has(a.id)) addSub(a, task); }
      if (!task) a.task = null;
    });
    [...agents.values()].forEach(a => { if (!seen.has(a.id) && !a.leaving) { cb.toast(`${a.name} closed`, 'none'); retireAgent(a); } });
    (events || []).forEach(ev => {
      const a = agents.get(ev.workspace_id);
      if (!a) return;
      if (ev.kind === 'visit') { visit(ev.workspace_id, ev.to_workspace_id, ev.rel); cb.toast(`${ev.label} → ${ev.to_label}: ${ev.tool} ${ev.rel}`, 'unknown', ev.to_workspace_id); return; }
      if (fresh.has(a.id)) return;
      if (ev.kind === 'agent_started') say(a, pick(SAY.agent_started), { sub: ev.agent });
      if (ev.kind === 'agent_gone') { say(a, pick(SAY.agent_gone), { sub: ev.agent }); cb.toast(`${a.name}: ${ev.agent} exited`, 'none', a.id); }
      if (ev.kind === 'renamed') say(a, pick(SAY.renamed));
    });
    wsList.forEach(w => {
      const a = agents.get(w.workspace_id); if (!a || fresh.has(a.id)) return;
      const st = statusOf(w, panes);
      if (a.status !== st) { const prev = a.status; a.status = st; reactToStatus(a, prev, st, cb); }
    });
    if (firstState) { firstState = false; agentList().forEach(a => { if (deskStatus(a.status)) { a.px = deskPos(a).x; a.py = deskPos(a).y; a.activity = deskAct(a.status); a.goalAct = 'desk'; } }); }
    if (!selected || !agents.has(selected)) { const f = wsList.find(w => w.focused) || wsList[0]; if (f) select(f.workspace_id, false); }
  }
  function reactToStatus(a, prev, st, cb) {
    const cls = st === 'blocked' ? 'blocked' : st === 'done' ? 'done' : '';
    if (prev === 'blocked' && st !== 'blocked') hush(a);
    a.excursion = null;
    let text = pick(SAY[st] || SAY.unknown);
    if (!deskStatus(st) && (atDesk(a) || a.activity !== 'walking')) {
      if (st === 'idle' && lingering(a)) {   // just finished: stay around the work area for a while before the lounge
        if (atDesk(a)) { a.activity = 'seated'; a.settled = true; a.rotateAt = Date.now() + (30 + Math.random() * 40) * 1000; } else officeGoal(a);
        text = pick(SAY.linger);
      } else {
        // leaving the desk: pick the destination first, then say something that matches it
        releaseSeat(a);
        const goal = chooseIdleGoal(a);
        if (st === 'idle' && SAY.goal[goal]) text = pick(SAY.goal[goal]);
        a.wait = 30 + Math.random() * 40;
      }
    }
    say(a, text, { cls, sticky: st === 'blocked', ms: st === 'done' ? 8000 : 6000, prio: 2, sub: deskStatus(st) ? a.task : null });
    cb.toast(`${a.name}: ${prev || 'new'} → ${st}`, st, a.id);
    cb.status(a, prev, st);
    if (deskStatus(st) && !atDesk(a)) goToDesk(a);
  }
  const MINI = {
    working: { gender: 'f', skin: '#e6b894', hair: '#3b2418', shirt: '#4a9a6a', pants: '#2f3b58', hairStyle: 'bob' },
    blocked: { gender: 'm', skin: '#c9956b', hair: '#1a1a1a', shirt: '#b84a5a', pants: '#3a3a3a', hairStyle: 'spiky' },
    done: { gender: 'f', skin: '#f3d3b3', hair: '#e8c170', shirt: '#5a7ab8', pants: '#2a4a3a', hairStyle: 'ponytail' },
    idle: { gender: 'm', skin: '#8a5c3c', hair: '#2a2a2a', shirt: '#c9a56b', pants: '#4a3b2a', hairStyle: 'afro' },
    none: { gender: 'f', skin: '#d3a279', hair: '#c9622a', shirt: '#e8e8e8', pants: '#5a5a6a', hairStyle: 'long' },
  };
  Object.values(MINI).forEach(m => Object.assign(m, { wave: 0, dirName: 'down', reading: false, seat: null, mini: true, activity: 'eat', frame: 0 }));
  function drawMini(cv, status, frame) {
    const a = MINI[status]; if (!a || !cv) return;
    const c2 = cv.getContext('2d'); c2.imageSmoothingEnabled = false; c2.clearRect(0, 0, cv.width, cv.height);
    const saved = ctx; ctx = c2; ctx.save(); ctx.scale(2, 2);
    a.frame = frame; a.status = status;
    drawChar(a, 5, 9);
    if (status === 'working') { R_(10, 1, 6, 6, OUT); R_(11, 2, 4, 4, '#e5b400'); }
    if (status === 'idle') { R_(10, 1, 6, 6, OUT); R_(11, 2, 4, 4, '#8a8a94'); }
    if (status === 'none') { R_(10, 1, 6, 6, OUT); R_(11, 2, 4, 4, '#2a2d36'); R_(12, 3, 2, 2, '#8a8a94'); }
    ctx.restore(); ctx = saved;
  }
  function select(id, notify = true) { selected = id; if (notify) handlers.select(id); const a = agents.get(id); if (a) a.wave = 28; }

  // ───────────── render ─────────────
  function fmtAge(sec) { if (sec < 60) return Math.floor(sec) + 's'; if (sec < 3600) return Math.floor(sec / 60) + 'm'; return Math.floor(sec / 3600) + 'h' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0'); }
  // night falls over the office with the real clock: a cool tint, warm pools of light at busy desks, the TV glow
  function nightLevel() {
    const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
    if (h >= 8 && h < 18) return 0;
    if (h >= 18 && h < 21) return (h - 18) / 3;
    if (h >= 5 && h < 8) return 1 - (h - 5) / 3;
    return 1;
  }
  function drawLighting(list) {
    const n = nightLevel(); if (n <= 0) return;
    ctx.save();
    ctx.fillStyle = `rgba(8,12,40,${0.42 * n})`; ctx.fillRect(0, 0, VW, VH);
    ctx.globalCompositeOperation = 'lighter';
    const pool = (x, y, r, col) => { const g = ctx.createRadialGradient(x, y, 2, x, y, r); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
    DESKS.forEach(d => { const a = list.find(z => z.desk === d && deskStatus(z.status) && atDesk(z)); if (a) pool(d.x * T + 24 - VX, d.y * T + 4 - VY, 34, `rgba(255,190,110,${0.28 * n})`); });
    if (TV) pool(TV.x * T + TV.w * T / 2 - VX, (LY - 2) * T + 14 - VY, 30, `rgba(120,170,255,${0.22 * n})`);
    for (let x = L.x0 * T + 40; x < L.x1 * T; x += 96) pool(x - VX, L.y0 * T + 6 - VY, 44, `rgba(255,240,200,${0.09 * n})`);
    for (let x = R.x0 * T + 40; x < R.x1 * T; x += 96) pool(x - VX, LY * T + 6 - VY, 44, `rgba(255,240,200,${0.07 * n})`);
    ctx.restore();
  }
  function render() {
    update(); frameNo++;
    if (frameNo % 60 === 0) maybeChat();
    ctx.drawImage(roomCanvas, VX, VY, VW, VH, 0, 0, VW, VH);
    drawMonitors(); drawTV(); drawPingPong(); drawClockHands();
    const now = Date.now() / 1000, pulse = 0.35 + 0.35 * Math.sin(now * 6);
    agentList().forEach(a => {
      if (a.status === 'blocked' && a.desk) { const d = a.desk; R_(d.x * T + 3 - VX, d.y * T - 4 - VY, 8, 3, `rgba(241,76,76,${pulse})`); R_(d.x * T + 18 - VX, d.y * T - 8 - VY, 13, 12, `rgba(241,76,76,${pulse * 0.35})`); }
    });
    const list = agentList().sort((p, q) => p.py - q.py);
    list.forEach(a => {
      const x = Math.round(a.px) - VX, y = Math.round(a.py) - VY;
      drawChar(a, x, y);
      if (a.id === selected) { R_(x + 6, y - 9, 4, 2, '#3aa0ff'); R_(x + 7, y - 7, 2, 2, '#3aa0ff'); }
    });
    drawLighting(list);
    list.forEach(a => {
      const cx = (a.px - VX + (a.activity === 'sleeping' ? 16 : 8)) * SCALE;
      const half = (a.el.offsetWidth || 40) / 2, lx = Math.max(half, Math.min(VW * SCALE - half, cx));
      a.el.style.left = lx + 'px'; a.el.style.top = ((a.py - VY + 20) * SCALE) + 'px';
      const age = a.statusSince ? fmtAge(now - a.statusSince) : '';
      a.el.textContent = shortName(a.name) + (age && a.status !== 'none' ? ' · ' + age : '');
      a.el.className = 'lbl ' + a.status + (a.id === selected ? ' sel' : '') + (a.status === 'blocked' && now - a.statusSince > 120 ? ' stale' : '');
      a.bubble.style.left = cx + 'px'; a.bubble.style.top = ((a.py - VY - (a.status === 'blocked' || a.status === 'done' ? 8 : 4)) * SCALE) + 'px';
    });
    requestAnimationFrame(render);
  }

  // ───────────── mouse: click, right-click, drag to a desk ─────────────
  function toMap(e) { const r = canvas.getBoundingClientRect(); return { mx: (e.clientX - r.left) / SCALE + VX, my: (e.clientY - r.top) / SCALE + VY }; }
  function hit(mx, my) {   // the sprite under the cursor; sleeping sprites lie sideways, and the nearest wins when two overlap
    let best = null, bd = 1e9;
    agentList().forEach(a => {
      const w = a.activity === 'sleeping' ? 34 : 20, ok = mx > a.px - 2 && mx < a.px - 2 + w && my > a.py - 8 && my < a.py + 22;
      if (!ok) return;
      const d = Math.hypot(mx - (a.px + w / 2 - 2), my - (a.py + 8)); if (d < bd) { bd = d; best = a; }
    });
    return best;
  }
  function deskAt(mx, my) { return DESKS.findIndex(d => mx >= d.x * T && mx < (d.x + 3) * T && my >= (d.y - 1) * T && my < (d.y + 2) * T); }
  function bindMouse() {
    const touchPoint = e => { const t = e.touches[0] || e.changedTouches[0]; return { clientX: t.clientX, clientY: t.clientY }; };
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      const pt = touchPoint(e), { mx, my } = toMap(pt); const a = hit(mx, my); if (!a || a.leaving) return;
      drag = { a, sx: pt.clientX, sy: pt.clientY, ox: a.px, oy: a.py, moved: false, touch: true }; e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      if (!drag || !drag.touch) return; e.preventDefault();
      const pt = touchPoint(e);
      if (!drag.moved && Math.hypot(pt.clientX - drag.sx, pt.clientY - drag.sy) < 8) return;
      drag.moved = true; drag.a.dragging = true; const { mx, my } = toMap(pt); drag.a.px = mx - 8; drag.a.py = my - 10;
    }, { passive: false });
    const touchEnd = e => {
      if (!drag || !drag.touch) return; const a = drag.a; const pt = touchPoint(e); const { mx, my } = toMap(pt);
      if (drag.moved) { const di = deskAt(mx, my); a.dragging = false; if (di >= 0) { a.px = drag.ox; a.py = drag.oy; handlers.seat(a.name, di); a.desk = DESKS[di]; if (deskStatus(a.status)) { a.activity = 'wander'; goToDesk(a); } else placeAt(a, DESKS[di].x * T + 24, (DESKS[di].y + 2) * T); } else placeAt(a, mx, my); }
      else select(a.id);
      drag = null;
    };
    canvas.addEventListener('touchend', touchEnd); canvas.addEventListener('touchcancel', () => { if (drag && drag.touch) { drag.a.dragging = false; drag = null; } });
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const { mx, my } = toMap(e); const a = hit(mx, my); if (!a || a.leaving) return;
      drag = { a, sx: e.clientX, sy: e.clientY, ox: a.px, oy: a.py, moved: false };
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.moved = true; drag.a.dragging = true; canvas.style.cursor = 'grabbing';
      const { mx, my } = toMap(e); drag.a.px = mx - 8; drag.a.py = my - 10;
    });
    window.addEventListener('mouseup', e => {
      if (!drag) return;
      const a = drag.a; canvas.style.cursor = '';
      if (drag.moved) {
        const { mx, my } = toMap(e); const di = deskAt(mx, my);
        a.dragging = false;
        if (di >= 0) { a.px = drag.ox; a.py = drag.oy; handlers.seat(a.name, di); a.desk = DESKS[di]; if (deskStatus(a.status)) { a.activity = 'wander'; goToDesk(a); } else placeAt(a, DESKS[di].x * T + 24, (DESKS[di].y + 2) * T); }
        else placeAt(a, mx, my);
      } else select(a.id);
      drag = null;
    });
    canvas.addEventListener('contextmenu', e => { const { mx, my } = toMap(e); const a = hit(mx, my); if (a) { e.preventDefault(); handlers.context(a.id, e.clientX, e.clientY); } });
  }

  function init(els) {
    wrapEl = els.wrap; stageEl = els.stage; canvas = els.canvas; ctx = canvas.getContext('2d'); labelsEl = els.labels; balloonsEl = els.balloons;
    layout(); bindMouse(); render();
  }
  function setPrefs(p) { prefs = p || {}; prefs.costumes = prefs.costumes || {}; prefs.desks = prefs.desks || {}; agentList().forEach(a => { applyCostume(a); const d = deskFor(a); if (d !== a.desk) { a.desk = d; if (atDesk(a)) { a.activity = 'wander'; goToDesk(a); } } }); }
  function costumeOf(name) { const a = [...agents.values()].find(a => a.name === name); return a ? { gender: a.gender, hairStyle: a.hairStyle, hair: a.hair, shirt: a.shirt, skin: a.skin, pants: a.pants } : null; }
  return {
    init, layout, sync, visit, setPrefs, costumeOf, select, chatReply, setChatInterval(sec) { chatEvery = Math.max(15, sec || 75) * 1000; },
    say: (id, t, o) => { const a = agents.get(id); if (a) say(a, t, o); },
    on(name, fn) { handlers[name] = fn; }, get selected() { return selected; },
    setHeight(h) { officeHeight = h; layout(); }, resetHeight() { officeHeight = 0; layout(); }, setMode(m) { MODE = m === 'side' ? 'side' : 'stacked'; layout(); }, get mode() { return MODE; },
    agents: agentList, seats: () => SEATS, seatBusy: () => seatBusy, view: () => ({ VX, VY, T, SCALE }), roomOf, drawMini, deskCount: () => DESKS.length, deskIndex, HAIR_STYLES, get plan() { return P === PLANS.full ? 'full' : 'compact'; }, get cols() { return COLS; }, get loungeCols() { return LW; },
  };
})();
