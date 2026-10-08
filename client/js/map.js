'use strict';
/* ============================================================
   КАРТА (клиент): местность, гексы, туман, точки, фишки частей,
   подсветка ходов и целей, проигрывание событий хода.
   Местность печётся один раз из shared/terrain.js — та же, что в
   «Линии»; поверх — сетка гексов, их тип, реки и мосты на границах.
   ============================================================ */

const PX = 2;
let TER = null, ANIM = 0;

/* ---------- топооснова карты (та же формула, что у правил) ---------- */
function mulberry2(a) { return () => { let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
let TER_ID = null;
function bakeTerrain(id) {
  const T = Terrain.get(id), def = T.def;
  const w = WW * PX, h = WH * PX;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), D = img.data;
  const H = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) H[j * w + i] = T.height((i + .5) / PX, (j + .5) / PX);
  const FLD = def.forest && def.forest.thr > .7
    ? [[62, 60, 38], [70, 66, 40], [58, 56, 36], [74, 68, 44], [66, 62, 40], [60, 58, 34]]     /* степь — выгоревшая трава */
    : [[38, 45, 34], [44, 49, 34], [34, 42, 32], [48, 48, 36], [40, 45, 30], [35, 41, 29], [46, 44, 31]];
  const hasLake = (def.lakes || []).length, hasMarsh = (def.marsh || []).length, hasRidge = (def.ridges || []).length;
  for (let j = 0; j < h; j++) {
    const y = (j + .5) / PX;
    for (let i = 0; i < w; i++) {
      const x = (i + .5) / PX, k = j * w + i;
      let r, gg, b;
      const lk = hasLake ? T.lakeK(x, y) : 0;
      if (lk > 0) { const dp = Math.min(1, lk * 2.2); r = 22 - dp * 10; gg = 62 - dp * 22; b = 84 - dp * 16 }
      else {
        const fv = T.forestV(x, y, H[k]);
        if (fv > T.FOREST_T) { const dn = clamp((fv - T.FOREST_T) * 6, 0, 1); r = 24 - dn * 6; gg = 40 - dn * 6; b = 27 - dn * 4 }
        else { const f = FLD[(Terrain.h2(Math.floor((x * .95 + y * .31) / 2.3), Math.floor((-x * .31 + y * .95) / 1.7), 5) * FLD.length) | 0]; r = f[0]; gg = f[1]; b = f[2] }
        const mk = hasMarsh ? T.marshK(x, y) : 0;
        if (mk > .05) {
          const sp = Terrain.h2(i, j, 9) < .18 ? 1 : 0;
          r = r * .6 + 36 * .4; gg = gg * .6 + 52 * .4; b = b * .6 + 44 * .4;
          if (sp) { r = 30; gg = 58; b = 66 }                 /* окна воды */
        }
        const rk = hasRidge ? T.ridgeK(x, y) : 0;
        if (rk > .25) { const t = Math.min(1, (rk - .25) * 2); r = r * (1 - t) + 92 * t; gg = gg * (1 - t) + 86 * t; b = b * (1 - t) + 76 * t; if (rk > .8) { r += 30; gg += 30; b += 32 } }
      }
      const hl = H[k - 1] || H[k], hr = H[k + 1] || H[k], hu = H[k - w] || H[k], hd = H[k + w] || H[k];
      const sh = clamp(1 + (hl - hr + hu - hd) * 26, .6, 1.4), el = .88 + H[k] * .28, cl = lk > 0 ? 1 : Math.abs((H[k] * 25) % 1 - .5) > .47 ? .9 : 1;
      const o = k * 4; D[o] = r * sh * el * cl; D[o + 1] = gg * sh * el * cl; D[o + 2] = b * sh * el * cl; D[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.scale(PX, PX); g.lineJoin = 'round'; g.lineCap = 'round';
  const rnd = mulberry2(77);
  const block = (x, y, R, n) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, rr = R * Math.sqrt(rnd()), bw = .7 + rnd() * 1.2, bh = .5 + rnd() * .9;
      g.save(); g.translate(x + Math.cos(a) * rr, y + Math.sin(a) * rr); g.rotate(Math.round(rnd() * 4) * .4 + .2);
      g.fillStyle = rnd() < .15 ? 'rgba(120,98,80,.9)' : 'rgba(96,92,82,.9)'; g.fillRect(-bw / 2, -bh / 2, bw, bh); g.restore();
    }
  };
  for (const ct of def.cities || []) { g.fillStyle = 'rgba(70,66,56,.45)'; g.beginPath(); g.arc(ct.x, ct.y, ct.r, 0, 7); g.fill(); block(ct.x, ct.y, ct.r, ct.r * ct.r * 1.6) }
  for (const p of def.points.filter(p => p.city)) block(p.x, p.y, p.w * 2.2 + 1, 16 + p.w * 14);
  const line = pts => { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)) };
  for (const r of T.roads()) { line(r.pts); g.strokeStyle = 'rgba(20,18,14,.55)'; g.lineWidth = r.main ? 1.15 : .8; g.stroke() }
  for (const r of T.roads()) { line(r.pts); g.strokeStyle = r.main ? 'rgba(170,148,100,.9)' : 'rgba(120,108,80,.8)'; g.lineWidth = r.main ? .6 : .4; g.stroke() }
  for (const r of T.rivers()) {
    line(r.pts); g.strokeStyle = '#0d2733'; g.lineWidth = r.w + .7; g.stroke();
    line(r.pts); g.strokeStyle = '#1d4c68'; g.lineWidth = r.w * .75; g.stroke();
  }
  /* гексы: тонировка по типу и сетка */
  const m = Hex.build(id), TINT = { forest: 'rgba(10,40,20,.18)', hill: 'rgba(120,95,60,.16)', city: 'rgba(120,120,120,.16)', marsh: 'rgba(40,90,90,.16)', mount: 'rgba(160,150,140,.16)', lake: null, open: null };
  for (const hx of m.hexes) {
    const cs = Hex.corners(hx.id);
    g.beginPath(); cs.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath();
    if (TINT[hx.t]) { g.fillStyle = TINT[hx.t]; g.fill() }
    g.strokeStyle = hx.t === 'lake' ? 'rgba(120,180,220,.1)' : 'rgba(200,215,225,.13)'; g.lineWidth = .18; g.stroke();
    if (hx.t === 'hill') { g.strokeStyle = 'rgba(200,170,120,.45)'; g.lineWidth = .3; g.beginPath(); g.moveTo(hx.x - 1.4, hx.y + 1.6); g.lineTo(hx.x, hx.y + .4); g.lineTo(hx.x + 1.4, hx.y + 1.6); g.stroke() }
    if (hx.t === 'mount') { g.strokeStyle = 'rgba(230,225,215,.6)'; g.lineWidth = .35; g.beginPath(); g.moveTo(hx.x - 2.2, hx.y + 1.8); g.lineTo(hx.x - .6, hx.y - .8); g.lineTo(hx.x + .4, hx.y + .6); g.lineTo(hx.x + 1.4, hx.y - 1.2); g.lineTo(hx.x + 2.6, hx.y + 1.8); g.stroke() }
    if (hx.t === 'marsh') { g.strokeStyle = 'rgba(140,200,190,.45)'; g.lineWidth = .25; for (let q = -1; q <= 1; q++) { g.beginPath(); g.moveTo(hx.x + q * 1.4 - .8, hx.y + 1); g.lineTo(hx.x + q * 1.4 + .8, hx.y + 1); g.moveTo(hx.x + q * 1.4, hx.y + 1); g.lineTo(hx.x + q * 1.4, hx.y - .4); g.stroke() } }
  }
  g.strokeStyle = 'rgba(80,160,220,.7)'; g.lineWidth = .7;
  for (let id2 = 0; id2 < Hex.NH; id2++) for (let d = 0; d < 3; d++) {
    if (!(m.edge[id2 * 6 + d] & Hex.RIV)) continue;
    const [a, b] = Hex.edgeEnds(id2, d);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  TER = c; TER_ID = id;
}

/* ---------- геометрия экрана ---------- */
const onScreen = (q, m) => q.x > -m && q.x < CW + m && q.y > -m && q.y < CH + m;
function hexPath(id, k) {
  const cs = Hex.corners(id, k).map(w2s);
  cx.beginPath(); cs.forEach((p, i) => i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)); cx.closePath();
}

/* ---------- слои ---------- */
function drawFog() {
  if (!G.vis || G.spec) return;
  cx.save();
  cx.fillStyle = 'rgba(4,8,12,.42)';
  cx.beginPath();
  for (let id = 0; id < Hex.NH; id++) {
    if (G.vis.has(id)) continue;
    const c = w2s(Hex.center(id));
    if (!onScreen(c, 40)) continue;
    const cs = Hex.corners(id, 1.01).map(w2s);
    cs.forEach((p, i) => i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)); cx.closePath();
  }
  cx.fill();
  cx.restore();
}
const DIST_COL = ['108,195,255', '111,209,141', '242,179,61', '200,160,255', '255,138,114', '120,220,220', '230,200,120', '170,190,255'];
function drawSupplyOverlay() {
  if (!G.showSupply || !G.supply) return;
  cx.save(); cx.fillStyle = 'rgba(255,80,60,.14)';
  cx.beginPath();
  for (let id = 0; id < Hex.NH; id++) {
    if (G.supply.has(id)) continue;
    const c = w2s(Hex.center(id));
    if (!onScreen(c, 40)) continue;
    Hex.corners(id).map(w2s).forEach((p, i) => i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)); cx.closePath();
  }
  cx.fill();
  /* округа: лёгкая заливка цветом источника и граница между округами */
  if (G.dist) {
    for (const [h, i] of G.dist) {
      const c = w2s(Hex.center(h));
      if (!onScreen(c, 40)) continue;
      hexPath(h, 1); cx.fillStyle = `rgba(${DIST_COL[i % DIST_COL.length]},.07)`; cx.fill();
      const cs = Hex.corners(h).map(w2s);
      for (let d = 0; d < 6; d++) {
        const b = Hex.nb(h, d);
        if (b >= 0 && G.dist.get(b) === i) continue;
        const [a1, a2] = Hex.edgeEnds ? Hex.edgeEnds(h, d).map(w2s) : [cs[d], cs[(d + 1) % 6]];
        cx.strokeStyle = b >= 0 && G.dist.has(b) ? `rgba(${DIST_COL[i % DIST_COL.length]},.55)` : 'rgba(255,90,70,.7)';
        cx.lineWidth = 1.4; cx.beginPath(); cx.moveTo(a1.x, a1.y); cx.lineTo(a2.x, a2.y); cx.stroke();
      }
    }
    (G.districts || []).forEach((d, i) => {
      if (d.hex < 0) return;
      const q = w2s(Hex.center(d.hex)), txt = `снабж. ${d.used}/${d.cap}`;
      cx.font = '700 11px system-ui'; cx.textAlign = 'center';
      const w = cx.measureText(txt).width + 8, y = q.y + Hex.R * G.view.s * .95;
      cx.fillStyle = 'rgba(6,10,14,.85)'; cx.fillRect(q.x - w / 2, y, w, 15);
      cx.fillStyle = d.used > d.cap ? '#ff8a72' : `rgb(${DIST_COL[i % DIST_COL.length]})`; cx.fillText(txt, q.x, y + 11);
    });
  }
  cx.restore();
}
/** дымовые завесы: клубы серого дыма над клетками */
function drawSmokeScreens() {
  const s = G.view.s;
  for (const h of G.smoke || []) {
    const c = Hex.center(h), q = w2s(c);
    if (!onScreen(q, 80)) continue;
    for (let i = 0; i < 5; i++) {
      const a = ANIM * .3 + i * 1.3 + h, R = Hex.R * s * (.45 + .12 * Math.sin(ANIM * .7 + i));
      const x = q.x + Math.cos(a) * Hex.R * s * .35, y = q.y + Math.sin(a * 1.3) * Hex.R * s * .25;
      const gr = cx.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, 'rgba(205,208,210,.42)'); gr.addColorStop(1, 'rgba(205,208,210,0)');
      cx.fillStyle = gr; cx.beginPath(); cx.arc(x, y, R, 0, 7); cx.fill();
    }
  }
}
function drawFront() {
  if (!G.frontY || !G.frontY.length) return;
  const fy = G.frontY.map(w2s);
  cx.save();
  cx.beginPath(); fy.forEach((p, i) => i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y));
  cx.strokeStyle = 'rgba(242,179,61,.18)'; cx.lineWidth = 7; cx.stroke();
  cx.strokeStyle = 'rgba(242,179,61,.75)'; cx.lineWidth = 1.6; cx.setLineDash([7, 5]); cx.stroke(); cx.setLineDash([]);
  cx.restore();
}
function drawBridges() {
  const br = new Map(G.br || []);
  for (const b of Hex.bridgeList(G.mapId)) {
    const q = w2s(b);
    if (!onScreen(q, 20)) continue;
    const st = br.get(b.key);
    if (st === 'down') {
      const r = 7; cx.strokeStyle = '#ff5b47'; cx.lineWidth = 2.4;
      cx.beginPath(); cx.moveTo(q.x - r, q.y - r); cx.lineTo(q.x + r, q.y + r); cx.moveTo(q.x + r, q.y - r); cx.lineTo(q.x - r, q.y + r); cx.stroke();
    } else { cx.fillStyle = '#d8cba5'; cx.strokeStyle = '#10161a'; cx.lineWidth = 1; cx.fillRect(q.x - 5, q.y - 2.5, 10, 5); cx.strokeRect(q.x - 5, q.y - 2.5, 10, 5) }
  }
  for (const [key, st] of G.br || []) {
    if (st !== 'pontoon') continue;
    const [a, b] = key.split('-').map(Number), A = Hex.center(a), B = Hex.center(b), q = w2s({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    cx.fillStyle = '#c9a54a'; cx.strokeStyle = '#10161a'; cx.lineWidth = 1; cx.fillRect(q.x - 6, q.y - 3, 12, 6); cx.strokeRect(q.x - 6, q.y - 3, 12, 6);
  }
}
function drawMines() {
  for (const m of G.mines || []) {
    const q = w2s(Hex.center(m.hex));
    if (!onScreen(q, 30)) continue;
    const own = G.spec ? m.side === N : m.side === G.side;
    cx.fillStyle = own ? 'rgba(200,170,110,.85)' : 'rgba(255,90,70,.9)';
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + .4, r = G.view.s * 2.2; cx.beginPath(); cx.arc(q.x + Math.cos(a) * r, q.y + Math.sin(a) * r, Math.max(1.6, G.view.s * .35), 0, 7); cx.fill() }
  }
}
function drawPoints() {
  const s = G.view.s;
  for (const p of G.pts) {
    const q = w2s(Hex.center(p.hex));
    if (!onScreen(q, 60)) continue;
    const own = p.owner === (G.spec ? N : G.side), col = !p.owner ? '#c8c8b8' : p.owner === N ? '#6cc3ff' : '#ff8a72';
    hexPath(p.hex, .96);
    cx.strokeStyle = col; cx.lineWidth = p.city ? 2.4 : 1.6; cx.setLineDash(p.city ? [] : [4, 3]); cx.stroke(); cx.setLineDash([]);
    if (G.scen && G.scen.target === p.id) { hexPath(p.hex, 1.08); cx.strokeStyle = `rgba(242,179,61,${.5 + .5 * Math.sin(ANIM * 4)})`; cx.lineWidth = 2; cx.stroke() }
    const ty = q.y - Hex.R * s * .95;
    cx.font = `${p.city ? '600 ' : ''}${p.w >= 2.5 ? 13 : 11}px system-ui,sans-serif`; cx.textAlign = 'center';
    cx.fillStyle = 'rgba(0,0,0,.8)'; cx.fillText(p.n, q.x + 1, ty + 1);
    cx.fillStyle = !p.owner ? '#e8e8da' : own ? '#dcecf6' : '#ffb8a6'; cx.fillText(p.n, q.x, ty);
  }
}

/* ---------- подсветка ходов и целей ---------- */
function drawSelection() {
  const u = selUnit();
  if (!u) return;
  hexPath(u.hex, .98); cx.strokeStyle = '#f2b33d'; cx.lineWidth = 2.5; cx.stroke();
  if (G.reach && G.isMyTurn) {
    for (const [h, r] of G.reach) {
      if (h === u.hex || r.through) continue;
      hexPath(h, .9); cx.fillStyle = r.ford ? 'rgba(80,160,220,.22)' : 'rgba(108,195,255,.16)'; cx.fill();
      cx.strokeStyle = 'rgba(108,195,255,.45)'; cx.lineWidth = 1; cx.stroke();
    }
    /* путь до клетки под курсором */
    if (G.hover >= 0 && G.reach.has(G.hover) && G.hover !== u.hex) {
      const p = Rules.pathTo(G.reach, G.hover).map(h => w2s(Hex.center(h)));
      cx.strokeStyle = 'rgba(255,230,160,.9)'; cx.lineWidth = 3; cx.setLineDash([6, 4]);
      cx.beginPath(); p.forEach((q, i) => i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y)); cx.stroke(); cx.setLineDash([]);
      const e = p[p.length - 1]; cx.fillStyle = '#ffe6a0'; cx.beginPath(); cx.arc(e.x, e.y, 4, 0, 7); cx.fill();
    }
  }
  /* цели: соседние враги (атака) или в дальности (огонь) */
  for (const t of G.targets || []) {
    hexPath(t.hex, .9); cx.strokeStyle = t.col; cx.lineWidth = 2.5; cx.stroke();
    const q = w2s(Hex.center(t.hex));
    cx.font = '700 11px system-ui'; cx.textAlign = 'center';
    const w = cx.measureText(t.lb).width + 8;
    cx.fillStyle = 'rgba(6,10,14,.9)'; cx.fillRect(q.x - w / 2, q.y + Hex.R * G.view.s * .45, w, 15);
    cx.fillStyle = t.col; cx.fillText(t.lb, q.x, q.y + Hex.R * G.view.s * .45 + 11);
  }
  if (UT[u.k].bomb && G.mode === 'bombard') for (const h of Hex.within(u.hex, UT[u.k].bomb.rng)) { hexPath(h, .95); cx.fillStyle = 'rgba(255,140,90,.06)'; cx.fill() }
  if (UT[u.k].cmd) { for (const h of Hex.within(u.hex, UT[u.k].cmd)) { hexPath(h, .97); cx.fillStyle = 'rgba(200,160,255,.05)'; cx.fill() } }
}

/* ---------- фишки ---------- */
function counter(u, q, alpha) {
  const s = G.view.s, W = clamp(Hex.HW * s * .78, 26, 110), H = W * .72;
  const enemy = G.spec ? u.side === S : u.side !== G.side, T = UT[u.k], ghost = u.ghost;
  cx.save();
  if (alpha !== undefined) cx.globalAlpha = alpha;
  rr(cx, q.x - W / 2, q.y - H / 2, W, H, Math.min(8, H * .2));
  cx.fillStyle = ghost ? 'rgba(30,18,14,.45)' : enemy ? 'rgba(52,22,18,.94)' : 'rgba(16,30,42,.94)'; cx.fill();
  cx.lineWidth = u.id === G.sel ? 2.6 : 1.4;
  cx.strokeStyle = u.id === G.sel ? '#f2b33d' : enemy ? '#ff8a72' : '#6cc3ff';
  if (ghost) cx.setLineDash([4, 3]);
  cx.stroke(); cx.setLineDash([]);
  drawIcon(cx, u.k || 'unk', q.x + W * .06, q.y + H * .04, W * .7, ghost ? 'ghost' : enemy ? 'enemy' : 'own', enemy && !G.spec ? true : u.side === S);
  if (!ghost) {
    /* сила — крупно в углу */
    cx.font = `800 ${Math.round(clamp(W * .26, 10, 22))}px system-ui`; cx.textAlign = 'left';
    const str = u.str, col = str <= 3 ? '#ff6b55' : str <= 6 ? '#ffd479' : '#e8f4ea';
    cx.fillStyle = 'rgba(0,0,0,.7)'; cx.fillText(str, q.x - W / 2 + 5, q.y - H / 2 + W * .25);
    cx.fillStyle = col; cx.fillText(str, q.x - W / 2 + 4, q.y - H / 2 + W * .24);
    if (s > 2.2) { cx.font = `600 ${Math.round(clamp(W * .13, 8, 12))}px system-ui`; cx.textAlign = 'right'; cx.fillStyle = 'rgba(230,240,245,.85)'; cx.fillText(T.sh, q.x + W / 2 - 4, q.y - H / 2 + W * .16) }
    /* окоп — точки внизу слева */
    for (let i = 0; i < (u.ent || 0); i++) { cx.fillStyle = '#c9a46a'; cx.fillRect(q.x - W / 2 + 5 + i * 6, q.y + H / 2 - 7, 4, 3) }
    if (!enemy && u.mp !== undefined && G.phase === 'battle') {
      /* очки хода — полоска справа внизу, атака — точка */
      const k = clamp(u.mp / T.mp, 0, 1);
      cx.fillStyle = 'rgba(6,10,14,.8)'; cx.fillRect(q.x + W / 2 - 18, q.y + H / 2 - 7, 14, 3);
      cx.fillStyle = '#6cc3ff'; cx.fillRect(q.x + W / 2 - 18, q.y + H / 2 - 7, 14 * k, 3);
      if (!u.acted && (T.atk.soft || T.bomb) && u.k !== 'hq') { cx.fillStyle = '#ff9f6b'; cx.beginPath(); cx.arc(q.x + W / 2 - 24, q.y + H / 2 - 5.5, 2.5, 0, 7); cx.fill() }
      if (u.org < 50) { cx.fillStyle = 'rgba(6,10,14,.8)'; cx.fillRect(q.x - W / 2 + 4, q.y + H / 2 - 2, W - 8, 2); cx.fillStyle = u.org < 25 ? '#ff5b47' : '#8fb8ff'; cx.fillRect(q.x - W / 2 + 4, q.y + H / 2 - 2, (W - 8) * u.org / 100, 2) }
      if (!u.supplied) { cx.fillStyle = '#ff5b47'; cx.font = '800 13px system-ui'; cx.textAlign = 'center'; cx.fillText('!', q.x + W / 2 - 4, q.y + 4) }
      if (u.exploit && !u.acted) { cx.fillStyle = '#9fe0a8'; cx.font = `800 ${Math.round(clamp(W * .16, 9, 13))}px system-ui`; cx.textAlign = 'center'; cx.fillText('»', q.x + W / 2 - 5, q.y - 2) }
      if (G.isMyTurn && u.mp <= 0 && u.acted && G.phase === 'battle' && !G.spec) { rr(cx, q.x - W / 2, q.y - H / 2, W, H, Math.min(8, H * .2)); cx.fillStyle = 'rgba(0,0,0,.35)'; cx.fill() }
    }
    /* запас снабжения — три деления сверху слева от силы */
    if (u.sp !== undefined && G.phase === 'battle' && (u.sp < 3 || s > 3)) {
      const bw = Math.max(3, W * .07), x0 = q.x - W / 2 + 4, y0 = q.y - H / 2 - 4;
      for (let i = 0; i < 3; i++) { cx.fillStyle = i < u.sp ? (u.sp <= 1 ? '#ff6b55' : u.sp === 2 ? '#ffd479' : '#6fd18d') : 'rgba(20,26,30,.85)'; cx.fillRect(x0 + i * (bw + 2), y0, bw, 3) }
    }
    if (u.hold) { cx.strokeStyle = '#f2b33d'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(q.x - W / 2 - 4, q.y + H / 2 + 3); cx.lineTo(q.x + W / 2 + 4, q.y + H / 2 + 3); cx.stroke(); if (s > 2.5) { cx.fillStyle = '#f2b33d'; cx.font = `700 ${Math.round(clamp(W * .13, 8, 11))}px system-ui`; cx.textAlign = 'left'; cx.fillText('насмерть', q.x - W / 2, q.y + H / 2 + 13) } }
    if (u.mil && s > 2.5) { cx.fillStyle = '#e8d8b0'; cx.font = `700 ${Math.round(clamp(W * .13, 8, 11))}px system-ui`; cx.textAlign = 'right'; cx.fillText('ополч.', q.x + W / 2 - 3, q.y - H / 2 + W * .3) }
    if (u.amb && !enemy) { cx.fillStyle = '#9fe0a8'; cx.font = `700 ${Math.round(clamp(W * .14, 8, 12))}px system-ui`; cx.textAlign = 'right'; cx.fillText('засада', q.x + W / 2 - 3, q.y + H / 2 + 11) }
    if (u.support && !enemy) { cx.strokeStyle = 'rgba(255,170,100,.8)'; cx.setLineDash([3, 3]); cx.lineWidth = 1.4; rr(cx, q.x - W / 2 - 3, q.y - H / 2 - 3, W + 6, H + 6, 9); cx.stroke(); cx.setLineDash([]) }
    if (u.sup) { cx.strokeStyle = `rgba(255,160,60,${.6 + .4 * Math.sin(ANIM * 8)})`; cx.lineWidth = 2; rr(cx, q.x - W / 2 - 2, q.y - H / 2 - 2, W + 4, H + 4, 9); cx.stroke() }
  } else { cx.fillStyle = '#f0d0c0'; cx.font = '600 10px system-ui'; cx.textAlign = 'center'; cx.fillText(u.age ? u.age + ' х. назад' : 'был здесь', q.x, q.y + H / 2 + 11) }
  cx.restore();
}
function drawUnits() {
  for (const g of G.ghosts || []) { const q = w2s(Hex.center(g.hex)); if (onScreen(q, 60)) counter({ ...g, ghost: 1, side: G.side === N ? S : N }, q, .6) }
  for (const u of G.units) {
    const p = ANIMS.pos.get(u.id) || Hex.center(u.hex);
    if (ANIMS.hidden.has(u.id)) continue;
    const q = w2s(p);
    if (onScreen(q, 60)) counter(u, q);
  }
  for (const d of ANIMS.dying) { const q = w2s(d.p); counter(d.u, q, clamp(1 - (RT() - d.t0) / .9, 0, 1)) }
}

/* ---------- эффекты и проигрывание событий ---------- */
const RT = () => performance.now() / 1000;
const ANIMS = { q: [], cur: null, pos: new Map(), hidden: new Set(), fx: [], floats: [], dying: [], banner: null };
const PACE = () => G.spec ? (G.pace || 1) : 1;
/** поставить событие в очередь проигрывания */
function playEvent(e) { ANIMS.q.push(e) }
function animBusy() { return !!ANIMS.cur || ANIMS.q.length > 0 }
function animTick() {
  const now = RT();
  if (ANIMS.cur && now >= ANIMS.cur.end) { ANIMS.cur.done && ANIMS.cur.done(); ANIMS.cur = null }
  while (!ANIMS.cur && ANIMS.q.length) startAnim(ANIMS.q.shift());
  if (ANIMS.cur && ANIMS.cur.step) ANIMS.cur.step(now);
  ANIMS.fx = ANIMS.fx.filter(f => now - f.t0 < f.d);
  ANIMS.floats = ANIMS.floats.filter(f => now - f.t0 < 1.6);
  ANIMS.dying = ANIMS.dying.filter(d => now - d.t0 < .9);
  if (!animBusy() && G.pendingSnap) { const v = G.pendingSnap; G.pendingSnap = null; applySnapshot(v) }
}
function floatText(p, txt, col) { ANIMS.floats.push({ p: { ...p }, txt, col, t0: RT() }) }
function startAnim(e) {
  const now = RT(), k = 1 / PACE();
  const center = Hex.center;
  if (e.e === 'move') {
    const u = G.units.find(x => x.id === e.id);
    const pts = e.path.map(center);
    if (!pts.length) return;
    if (!u) { return }
    const seg = (e.retreat ? .16 : .13) * k, dur = Math.max(.05, seg * (pts.length - 1));
    ANIMS.cur = {
      end: now + dur,
      step(t) {
        const f = clamp((t - now) / dur, 0, 1) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), r = f - i;
        if (pts.length < 2) { ANIMS.pos.set(e.id, pts[0]); return }
        ANIMS.pos.set(e.id, { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r });
      },
      done() { u.hex = e.path[e.path.length - 1]; ANIMS.pos.delete(e.id) }
    };
    if (e.retreat) floatText(pts[pts.length - 1], 'отход', '#ffd479');
    Sound.gun({ ...pts[0], kind: 'mg' });
  } else if (e.e === 'fight') {
    const A = center(e.ah), D = center(e.dh);
    ANIMS.fx.push({ k: 'fire', a: A, b: D, t0: now, d: .7 * k }, { k: 'fire', a: D, b: A, t0: now + .15 * k, d: .6 * k });
    if (e.amb) floatText({ x: D.x, y: D.y - 4 }, 'засада!', '#ffd479');
    for (let i = 0; i < 3; i++) ANIMS.fx.push({ k: 'blast', p: { x: D.x + (Math.random() - .5) * 5, y: D.y + (Math.random() - .5) * 4 }, t0: now + (.2 + i * .12) * k, d: .5, small: 1 });
    ANIMS.fx.push({ k: 'blast', p: D, t0: now + .35 * k, d: .7 }, { k: 'blast', p: A, t0: now + .45 * k, d: .5, small: 1 });
    addCraters(e.dh, 2); if (e.ld >= 2) shake(4);
    ANIMS.cur = { end: now + .95 * k, done() { if (e.ld) floatText(D, '−' + e.ld, '#ff8f80'); else floatText(D, 'без потерь', '#cfe0ea'); if (e.la) floatText({ x: A.x, y: A.y - 2 }, '−' + e.la, '#ffb070'); upd(e.d, -e.ld); upd(e.a, -e.la) } };
    Sound.gun({ ...D, kind: 'tank' }); setTimeout(() => Sound.boom({ ...D, w: 40 }, true), 300 * k);
  } else if (e.e === 'shell') {
    const D = center(e.hex), A = e.from !== null && e.from !== undefined ? center(e.from) : null;
    if (A) ANIMS.fx.push({ k: 'shell', a: A, b: D, t0: now, d: .6 * k });
    ANIMS.cur = { end: now + (A ? .6 : .1) * k };
    if (A) Sound.outgoing(A, e.k === 'mlrs');
  } else if (e.e === 'blast') {
    const D = center(e.hex);
    ANIMS.fx.push({ k: 'blast', p: D, t0: now, d: .9, big: e.big });
    if (e.ld !== undefined) setTimeout(() => { floatText(D, e.ld ? '−' + e.ld : 'мимо', e.ld ? '#ff8f80' : '#cfe0ea'); upd(e.id, -e.ld) }, 250 * k);
    ANIMS.cur = { end: now + .5 * k };
    addCraters(e.hex, e.big ? 4 : 2);
    if (e.hex >= 0 && G.mapId && Hex.build(G.mapId).hexes[e.hex].t === 'city') addFire(e.hex);
    if (e.big) shake(6);
    Sound.boom({ ...D, w: e.big ? 90 : 40 }, false);
  } else if (e.e === 'dead') {
    const u = G.units.find(x => x.id === e.id), p = center(e.hex);
    if (u) { ANIMS.dying.push({ u: { ...u }, p, t0: now }); ANIMS.hidden.add(e.id) }
    ANIMS.fx.push({ k: 'blast', p, t0: now, d: 1.1, big: 1 });
    if (e.how !== 'surrender') { addWreck(e.hex, e.k, e.side); shake(7) }
    floatText({ x: p.x, y: p.y + 2 }, e.how === 'surrender' ? 'сдались' : 'уничтожен', '#ff6b55');
    ANIMS.cur = { end: now + .6 * k };
  } else if (e.e === 'capture') {
    const p = center(e.hex);
    ANIMS.fx.push({ k: 'ring', p, t0: now, d: 1.4, col: e.side === N ? '108,195,255' : '255,110,90' });
    floatText(p, e.n + ' взят', '#ffe6a0');
    ANIMS.cur = { end: now + .5 * k };
  } else if (e.e === 'air') {
    const p = center(e.hex);
    ANIMS.fx.push({ k: 'plane', p, t0: now, d: 1.1 * k, side: e.side });
    if (e.kind === 'drop') floatText(p, 'груз сброшен', '#9fe0a8');
    ANIMS.cur = { end: now + .9 * k };
  } else if (e.e === 'aa') {
    ANIMS.fx.push({ k: 'fire', a: center(e.hex), b: center(e.target), t0: now, d: .7, col: '200,230,255' });
    ANIMS.cur = { end: now + .4 * k };
  } else if (e.e === 'turn') {
    const mine = !G.spec && e.side === G.side;
    ANIMS.banner = { t0: now, txt: `Ход ${e.turn + 1} · ${e.clock}${e.night ? ' · ночь' : ''}`, sub: G.spec ? 'Ходит ' + SIDE_GEN[e.side] : mine ? 'Ваш ход' : 'Ход противника', mine };
    ANIMS.cur = { end: now + (mine ? .9 : .5) * k };
    if (mine) Sound.radio('hq');
  } else if (e.e === 'eng' || e.e === 'spawn' || e.e === 'replace') {
    const p = center(e.hex !== undefined ? e.hex : (G.units.find(x => x.id === e.id) || { hex: 0 }).hex);
    floatText(p, { bridge: 'понтон', mine: 'мины', dig: 'окоп', clear: 'проход', blow: 'взрыв', fort: 'укрепления', obst: 'заграждения', ambush: 'засада' }[e.task] || (e.e === 'replace' ? '+' + e.n : e.militia ? 'ополчение!' : 'прибыл'), '#ffe6a0');
    ANIMS.cur = { end: now + .25 * k };
  } else if (e.e === 'smoke') {
    floatText(center(e.hex), 'дым', '#d8dadc');
    if (!G.smoke.includes(e.hex)) G.smoke = G.smoke.concat(Hex.within(e.hex, 1));
    ANIMS.cur = { end: now + .25 * k };
  }
}
function upd(id, d) { const u = G.units.find(x => x.id === id); if (u && d) u.str = Math.max(0, u.str + d) }

function drawFx() {
  const now = RT();
  for (const f of ANIMS.fx) {
    const t = (now - f.t0) / f.d;
    if (t < 0 || t > 1) continue;
    if (f.k === 'fire') {
      const a = w2s(f.a), b = w2s(f.b);
      cx.strokeStyle = `rgba(${f.col || '255,214,120'},${1 - t})`; cx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const s0 = clamp(t * 1.8 - i * .15, 0, 1), s1 = clamp(s0 + .15, 0, 1);
        if (s0 <= 0) continue;
        cx.beginPath(); cx.moveTo(a.x + (b.x - a.x) * s0, a.y + (b.y - a.y) * s0); cx.lineTo(a.x + (b.x - a.x) * s1, a.y + (b.y - a.y) * s1); cx.stroke();
      }
    } else if (f.k === 'shell') {
      const a = w2s(f.a), b = w2s(f.b), L = Math.hypot(b.x - a.x, b.y - a.y);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * L * .3 };
      cx.fillStyle = '#ffefc0'; cx.beginPath(); cx.arc(p.x, p.y, 3, 0, 7); cx.fill();
    } else if (f.k === 'blast') {
      const q = w2s(f.p), R = (f.big ? 28 : f.small ? 10 : 18) * (.4 + t) * clamp(G.view.s / 3, .7, 2);
      const gr = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, R);
      gr.addColorStop(0, `rgba(255,245,210,${1 - t})`); gr.addColorStop(.4, `rgba(255,150,50,${.8 * (1 - t)})`); gr.addColorStop(1, 'rgba(60,30,10,0)');
      cx.fillStyle = gr; cx.beginPath(); cx.arc(q.x, q.y, R, 0, 7); cx.fill();
    } else if (f.k === 'ring') {
      const q = w2s(f.p); cx.strokeStyle = `rgba(${f.col},${1 - t})`; cx.lineWidth = 3; cx.beginPath(); cx.arc(q.x, q.y, 10 + t * 70, 0, 7); cx.stroke();
    } else if (f.k === 'plane') {
      const q = w2s(f.p), dir = f.side === S ? -1 : 1, x = q.x + (t - .5) * 300 * dir;
      cx.save(); cx.translate(x, q.y - 30); if (dir < 0) cx.scale(-1, 1);
      drawIcon(cx, 'jet', 0, 0, 60, f.side === (G.spec ? S : G.side === N ? S : N) ? 'enemy' : 'own', false);
      cx.restore();
    }
  }
  for (const f of ANIMS.floats) {
    const t = (now - f.t0) / 1.6, q = w2s(f.p);
    cx.font = '800 15px system-ui'; cx.textAlign = 'center';
    cx.fillStyle = `rgba(0,0,0,${.8 * (1 - t)})`; cx.fillText(f.txt, q.x + 1, q.y - 20 - t * 26 + 1);
    cx.globalAlpha = 1 - t; cx.fillStyle = f.col; cx.fillText(f.txt, q.x, q.y - 20 - t * 26); cx.globalAlpha = 1;
  }
  const b = ANIMS.banner;
  if (b) {
    const t = now - b.t0;
    if (t > 1.8) ANIMS.banner = null;
    else {
      const a = t < .2 ? t / .2 : t > 1.4 ? (1.8 - t) / .4 : 1;
      cx.save(); cx.globalAlpha = a;
      cx.fillStyle = 'rgba(8,13,18,.85)'; cx.fillRect(0, CH * .38, CW, 70);
      cx.fillStyle = b.mine ? '#f2b33d' : '#cfe0ea'; cx.font = '800 26px system-ui'; cx.textAlign = 'center'; cx.fillText(b.txt, CW / 2, CH * .38 + 32);
      cx.font = '600 15px system-ui'; cx.fillStyle = b.mine ? '#ffe6a0' : '#9fb3c0'; cx.fillText(b.sub, CW / 2, CH * .38 + 56);
      cx.restore();
    }
  }
}


/* ---------- следы боя: воронки, горящие остовы, пожары в городах ---------- */
const MARKS = { craters: [], wrecks: [], fires: [] };
let SHAKE = 0;
function marksReset() { MARKS.craters.length = 0; MARKS.wrecks.length = 0; MARKS.fires.length = 0 }
function addCraters(hex, n) {
  const c = Hex.center(hex);
  for (let i = 0; i < n; i++) MARKS.craters.push({ x: c.x + (Math.random() - .5) * 6, y: c.y + (Math.random() - .5) * 5, r: .5 + Math.random() * .7, turn: G.turn });
  if (MARKS.craters.length > 500) MARKS.craters.splice(0, MARKS.craters.length - 500);
}
function addWreck(hex, k, side) { const c = Hex.center(hex); MARKS.wrecks.push({ x: c.x + (Math.random() - .5) * 3, y: c.y + (Math.random() - .5) * 2, k, side, turn: G.turn, seed: Math.random() * 9 }) }
function addFire(hex) { if (!MARKS.fires.some(f => f.hex === hex)) MARKS.fires.push({ hex, turn: G.turn, seed: Math.random() * 9 }) }
function shake(k) { SHAKE = Math.max(SHAKE, k) }

function drawMarks() {
  const s = G.view.s;
  MARKS.craters = MARKS.craters.filter(c => G.turn - c.turn < 8);
  for (const c of MARKS.craters) {
    const q = w2s(c);
    if (!onScreen(q, 20)) continue;
    const a = clamp(1 - (G.turn - c.turn) / 8, .2, 1);
    cx.fillStyle = `rgba(16,12,8,${.55 * a})`; cx.beginPath(); cx.ellipse(q.x, q.y, c.r * s, c.r * s * .75, 0, 0, 7); cx.fill();
    cx.strokeStyle = `rgba(120,100,70,${.35 * a})`; cx.lineWidth = 1; cx.stroke();
  }
  MARKS.wrecks = MARKS.wrecks.filter(w => G.turn - w.turn < 6);
  for (const w of MARKS.wrecks) {
    const q = w2s(w);
    if (!onScreen(q, 40)) continue;
    drawIcon(cx, w.k, q.x, q.y, clamp(s * 4, 16, 44), 'dead', w.side === S, .85);
  }
  MARKS.fires = MARKS.fires.filter(f => G.turn - f.turn < 3);
}
/** огонь и дым над остовами и горящими кварталами — поверх фишек */
function drawSmoke() {
  const s = G.view.s, now = ANIM;
  const burn = (x, y, k, seed, big) => {
    const q = w2s({ x, y });
    if (!onScreen(q, 80)) return;
    if (k > .3) {
      const fl = .7 + .3 * Math.sin(now * 13 + seed * 7);
      const R = (big ? 9 : 5) * clamp(s / 3, .7, 2) * fl;
      const gr = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, R);
      gr.addColorStop(0, `rgba(255,210,120,${.9 * k})`); gr.addColorStop(.5, `rgba(255,110,30,${.6 * k})`); gr.addColorStop(1, 'rgba(255,60,10,0)');
      cx.fillStyle = gr; cx.beginPath(); cx.arc(q.x, q.y, R, 0, 7); cx.fill();
    }
    for (let i = 0; i < (big ? 6 : 4); i++) {
      const t = ((now * .25 + i / (big ? 6 : 4) + seed) % 1);
      const px = q.x + Math.sin(seed * 3 + i * 2.1 + t * 2) * 4 * s * .3 + t * 14, py = q.y - t * 40 * clamp(s / 3, .7, 1.8);
      const R = (3 + t * 12) * clamp(s / 3, .7, 1.8) * (big ? 1.4 : 1);
      cx.fillStyle = `rgba(40,38,36,${.35 * (1 - t) * Math.max(.3, k)})`; cx.beginPath(); cx.arc(px, py, R, 0, 7); cx.fill();
    }
  };
  for (const w of MARKS.wrecks) { const age = G.turn - w.turn; if (age < 3) burn(w.x, w.y, age < 1 ? 1 : .5, w.seed, false) }
  for (const f of MARKS.fires) { const c = Hex.center(f.hex); burn(c.x, c.y, 1 - (G.turn - f.turn) / 3, f.seed, true) }
}

/* ---------- укрепления, заграждения ---------- */
function drawWorks() {
  const s = G.view.s;
  for (const [h, lvl] of G.forts || []) {
    const c = Hex.center(h);
    if (!onScreen(w2s(c), 60)) continue;
    /* траншея зигзагом вокруг центра клетки */
    cx.strokeStyle = 'rgba(205,175,120,.85)'; cx.lineWidth = Math.max(1.5, s * .35);
    for (let ring = 0; ring < lvl; ring++) {
      const cs = Hex.corners(h, .78 - ring * .14).map(w2s);
      cx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = cs[i], b = cs[(i + 1) % 6];
        for (let k = 0; k <= 4; k++) {
          const t = k / 4, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, o = k % 2 ? 2.5 : -2.5;
          const nx = -(b.y - a.y), ny = b.x - a.x, L = Math.hypot(nx, ny) || 1;
          const px = x + nx / L * o, py = y + ny / L * o;
          i === 0 && k === 0 ? cx.moveTo(px, py) : cx.lineTo(px, py);
        }
      }
      cx.closePath(); cx.stroke();
    }
  }
  for (const h of G.obst || []) {
    const c = w2s(Hex.center(h));
    if (!onScreen(c, 60)) continue;
    const r = Hex.R * s * .55;
    cx.fillStyle = 'rgba(190,190,180,.9)'; cx.strokeStyle = 'rgba(20,20,18,.8)'; cx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) for (const row of [-1, 1]) {
      const x = c.x + i * r * .4 + row * r * .2, y = c.y + row * r * .3, z = Math.max(3, s * .9);
      cx.beginPath(); cx.moveTo(x, y - z); cx.lineTo(x + z * .8, y + z * .6); cx.lineTo(x - z * .8, y + z * .6); cx.closePath(); cx.fill(); cx.stroke();
    }
  }
}

/* ---------- погода и ночь ---------- */
const DROPS = Array.from({ length: 240 }, () => ({ x: Math.random(), y: Math.random(), z: .5 + Math.random() * .5 }));
function drawWeather() {
  const w = G.weather, t = ANIM;
  if (w === 'fog') { cx.fillStyle = 'rgba(160,168,172,.22)'; cx.fillRect(0, 0, CW, CH) }
  if (w === 'cloud' || w === 'rain' || w === 'storm' || w === 'snow') {
    for (let i = 0; i < 9; i++) {
      const x = ((i * 173 + t * 6) % (CW + 400)) - 200, y = (i * 97) % CH, R = 160 + (i % 3) * 60;
      const gr = cx.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, `rgba(8,12,16,${w === 'cloud' ? .12 : .18})`); gr.addColorStop(1, 'rgba(8,12,16,0)');
      cx.fillStyle = gr; cx.beginPath(); cx.arc(x, y, R, 0, 7); cx.fill();
    }
  }
  if (w === 'rain' || w === 'storm') {
    cx.strokeStyle = 'rgba(170,190,210,.3)'; cx.lineWidth = 1; cx.beginPath();
    for (const d of DROPS) { const y = ((d.y + t * 1.5 * d.z) % 1) * CH, x = ((d.x + t * .2 * d.z) % 1) * CW; cx.moveTo(x, y); cx.lineTo(x - 4 * d.z, y + 13 * d.z) }
    cx.stroke();
    if (w === 'storm' && Math.random() < .004) { cx.fillStyle = 'rgba(220,230,255,.25)'; cx.fillRect(0, 0, CW, CH); Sound.thunder() }
  }
  if (w === 'snow') { cx.fillStyle = 'rgba(235,240,245,.7)'; for (const d of DROPS) { const y = ((d.y + t * .1 * d.z) % 1) * CH, x = ((d.x + Math.sin(t + d.y * 9) * .01) % 1) * CW; cx.fillRect(x, y, 1.6 * d.z, 1.6 * d.z) } }
}
function drawNight() {
  if (!G.night) return;
  cx.fillStyle = 'rgba(4,10,26,.36)'; cx.fillRect(0, 0, CW, CH);
  cx.save(); cx.globalCompositeOperation = 'lighter';
  for (const p of G.pts) {
    if (!p.city) continue;
    const q = w2s(Hex.center(p.hex)), R = (p.w * 5 + 8) * G.view.s;
    if (!onScreen(q, R)) continue;
    const gr = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, R);
    gr.addColorStop(0, 'rgba(255,190,110,.22)'); gr.addColorStop(1, 'rgba(255,190,110,0)');
    cx.fillStyle = gr; cx.beginPath(); cx.arc(q.x, q.y, R, 0, 7); cx.fill();
  }
  cx.restore();
}

/* ---------- кадр ---------- */
function draw(dt) {
  if (!G.mapId) { cx.setTransform(DPR, 0, 0, DPR, 0, 0); cx.fillStyle = '#04070a'; cx.fillRect(0, 0, CW, CH); return }
  if (!TER || TER_ID !== G.mapId) bakeTerrain(G.mapId);
  ANIM += dt;
  animTick();
  const sx = SHAKE > .3 ? (Math.random() - .5) * SHAKE : 0, sy = SHAKE > .3 ? (Math.random() - .5) * SHAKE : 0;
  SHAKE *= .88;
  cx.setTransform(DPR, 0, 0, DPR, sx * DPR, sy * DPR);
  cx.fillStyle = '#04070a'; cx.fillRect(-20, -20, CW + 40, CH + 40);
  cx.save(); cx.translate(CW / 2, CH / 2); cx.scale(G.view.s, G.view.s); cx.translate(-G.view.x, -G.view.y);
  cx.imageSmoothingEnabled = true; cx.drawImage(TER, 0, 0, WW, WH); cx.restore();
  drawMarks();
  drawNight();
  drawFog();
  drawSupplyOverlay();
  drawFront();
  drawBridges();
  drawMines();
  drawWorks();
  drawPoints();
  if (G.phase === 'deploy' && G.deploy) for (const h of G.deploy) { hexPath(h, .95); cx.fillStyle = 'rgba(242,179,61,.07)'; cx.fill() }
  if (G.spawn) for (const h of G.spawn) { hexPath(h, .92); cx.fillStyle = 'rgba(111,209,141,.16)'; cx.fill(); cx.strokeStyle = 'rgba(111,209,141,.6)'; cx.lineWidth = 1.2; cx.stroke() }
  drawSelection();
  drawUnits();
  drawSmokeScreens();
  drawSmoke();
  drawFx();
  drawWeather();
  if (G.hover >= 0 && !animBusy()) { hexPath(G.hover, 1); cx.strokeStyle = 'rgba(255,255,255,.35)'; cx.lineWidth = 1; cx.stroke() }
  drawMini();
}

function miniRect() { const h = clamp(CH * .24, 110, 200), w = h * WW / WH, left = document.getElementById('left'); const lx = left && !left.classList.contains('col') ? left.getBoundingClientRect().right + 10 : 10; return { x: lx, y: CH - h - 12, w, h } }
function drawMini() {
  if (!TER || !G.roomId) return;
  const m = miniRect(), k = m.w / WW;
  cx.fillStyle = 'rgba(4,7,10,.85)'; cx.fillRect(m.x - 3, m.y - 3, m.w + 6, m.h + 6);
  cx.globalAlpha = .9; cx.drawImage(TER, m.x, m.y, m.w, m.h); cx.globalAlpha = 1;
  if (G.frontY) { cx.strokeStyle = '#f2b33d'; cx.lineWidth = 1.2; cx.beginPath(); G.frontY.forEach((p, i) => i ? cx.lineTo(m.x + p.x * k, m.y + p.y * k) : cx.moveTo(m.x + p.x * k, m.y + p.y * k)); cx.stroke() }
  for (const u of G.units) { const c = Hex.center(u.hex); cx.fillStyle = (G.spec ? u.side === S : u.side !== G.side) ? '#ff5b47' : '#bfe6ff'; cx.fillRect(m.x + c.x * k - 1.5, m.y + c.y * k - 1.5, 3, 3) }
  const a = s2w({ x: 0, y: 0 }), b = s2w({ x: CW, y: CH });
  cx.strokeStyle = 'rgba(255,255,255,.7)'; cx.lineWidth = 1; cx.strokeRect(m.x + a.x * k, m.y + a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
}
