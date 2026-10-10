'use strict';
/* ============================================================
   КАРТА (клиент): слои поверх подложки и проигрывание событий.
   Подложка — render/base.js (местность, реки, дороги, сетка),
   эффекты — render/fx.js, фишки — render/units.js, погода и
   огни — render/atmos.js. Здесь: туман войны, снабжение, фронт,
   точки, укрепления, подсветка ходов и целей, очередь событий хода,
   мини-карта и кадр целиком.
   ============================================================ */

let ANIM = 0;

/* ---------- геометрия ---------- */
function hexPath(id, k) {
  const cs = H.corners(id, k);
  cx.beginPath();
  for (let i = 0; i < 6; i++) { const p = w2s(cs[i]); i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y) }
  cx.closePath();
}
function addHex(id, k) {
  const cs = H.corners(id, k);
  for (let i = 0; i < 6; i++) { const p = w2s(cs[i]); i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y) }
  cx.closePath();
}
const EDGE_V = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
/** контур области: рёбра клеток, за которыми клетка не из области */
function regionEdges(has, list) {
  cx.beginPath();
  for (const h of list) {
    const c = H.center(h), q = w2s(c);
    if (!onScreen(q, 60)) continue;
    const cs = H.corners(h);
    for (let d = 0; d < 6; d++) {
      const n = H.nb(h, d);
      if (n >= 0 && has(n)) continue;
      const [i, j] = EDGE_V[d], a = w2s(cs[i]), b = w2s(cs[j]);
      cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y);
    }
  }
}

/* ---------- территория и туман войны: один слой в координатах карты ----------
   Подкраска своей и чужой земли и туман войны печатаются вместе в один холст
   (1,5 пикс. на км) и перестраиваются только с новым снимком; в кадре — одно
   копирование с текущим преобразованием. Раньше в каждом кадре заливались
   два пути из всех клеток карты (территория) и отдельно копировался туман.
   Маска тумана размыта, поэтому низкого разрешения хватает. Граница обзора —
   готовый Path2D в координатах карты. */
let OVL = null, ovlKey = '', FOG_EDGE = null;
const FK = 1.5;
function overlayLayer() {
  const fogOn = !!(G.vis && !G.spec && G.phase === 'battle');
  const own = G.spec ? 1 : G.side === N ? 1 : 2;
  const key = G.mapId + '|' + own + '|' + (fogOn ? G.visV : '-') + '|' + G.terrStr;
  if (key === ovlKey && OVL) return OVL;
  ovlKey = key;
  const w = Math.ceil(H.WW * FK), h = Math.ceil(H.WH * FK);
  if (!OVL || OVL.width !== w || OVL.height !== h) { OVL = document.createElement('canvas'); OVL.width = w; OVL.height = h }
  const o = OVL.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, w, h);
  /* земля сторон */
  const F = buildFront();
  OVL.empty = !F && !fogOn;
  if (F) {
    o.save(); o.scale(FK, FK);
    o.fillStyle = 'rgba(108,195,255,.05)'; o.fill(F.fill[own]);
    o.fillStyle = 'rgba(255,91,71,.07)'; o.fill(F.fill[3 - own]);
    o.restore();
  }
  FOG_EDGE = null;
  if (fogOn) {
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const g = t.getContext('2d');
    g.scale(FK, FK); g.fillStyle = 'rgb(5,9,14)'; g.beginPath();
    for (let id = 0; id < H.NH; id++) {
      if (G.vis.has(id)) continue;
      const cs = H.corners(id, 1.04);
      cs.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath();
    }
    g.fill();
    o.globalAlpha = .64;
    o.filter = `blur(${(Hex.R * FK * .22).toFixed(2)}px)`; o.drawImage(t, 0, 0); o.filter = 'none';
    o.globalAlpha = 1;
    /* граница обзора: рёбра видимых клеток, за которыми не видно */
    FOG_EDGE = typeof Path2D === 'function' ? new Path2D() : null;
    if (FOG_EDGE) for (const hx of G.vis) {
      const cs = H.corners(hx);
      for (let d = 0; d < 6; d++) {
        const n = H.nb(hx, d);
        if (n >= 0 && G.vis.has(n)) continue;
        const [i, j] = EDGE_V[d];
        FOG_EDGE.moveTo(cs[i].x, cs[i].y); FOG_EDGE.lineTo(cs[j].x, cs[j].y);
      }
    }
  }
  return OVL;
}
function drawFog() {
  const L = overlayLayer();
  if (!L || L.empty) return;
  const s = G.view.s, fogOn = !!(G.vis && !G.spec && G.phase === 'battle');
  cx.save();
  cx.translate(CW / 2, CH / 2); cx.scale(s, s); cx.translate(-G.view.x, -G.view.y);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'low';
  /* только видимый кусок слоя: меньше работы при растягивании */
  const hw = CW / 2 / s + 2, hh = CH / 2 / s + 2;
  const x0 = clamp(G.view.x - hw, 0, H.WW), x1 = clamp(G.view.x + hw, 0, H.WW), y0 = clamp(G.view.y - hh, 0, H.WH), y1 = clamp(G.view.y + hh, 0, H.WH);
  if (x1 - x0 > .01 && y1 - y0 > .01) cx.drawImage(L, x0 * FK, y0 * FK, (x1 - x0) * FK, (y1 - y0) * FK, x0, y0, x1 - x0, y1 - y0);
  /* граница обзора — в координатах карты, толщина и штрих в пикселях экрана */
  if (FOG_EDGE) {
    cx.setLineDash([2 / s, 5 / s]); cx.strokeStyle = 'rgba(190,210,220,.22)'; cx.lineWidth = 1 / s;
    cx.stroke(FOG_EDGE);
  }
  cx.restore();
  if (fogOn && !FOG_EDGE) { cx.save(); cx.setLineDash([2, 5]); cx.strokeStyle = 'rgba(190,210,220,.22)'; cx.lineWidth = 1; regionEdges(n => G.vis.has(n), G.vis); cx.stroke(); cx.restore() }
}

/* ---------- снабжение по дорогам, как в Unity of Command ----------
   Синие линии — дорожная сеть, по которой снабжение доходит без потерь
   (бегущий пунктир показывает, что подвоз идёт), числа — сколько осталось
   в клетке поля, значки — источники. */
const SUP_RGB = { full: '111,209,141', ok: '201,211,107', low: '242,179,61', none: '255,91,71' };
/** Путь линий снабжения в координатах карты: отрезки дорог (MAPGEO.roads),
    у которых обе точки лежат в клетках на линии снабжения. Строится один раз
    на снимок; на стыке с оборванным участком линия доходит до середины шага. */
let NET_PATH = null, NET_KEY = '';
function supplyNetPath() {
  const key = G.mapId + '|' + (G.svStr || '');
  if (key === NET_KEY) return NET_PATH;
  NET_KEY = key; NET_PATH = null;
  if (!G.svNet || typeof Path2D !== 'function') return null;
  const geo = mapGeo(G.mapId), on = p => { const h = H.hexAt(p.x, p.y); return h >= 0 && G.svNet[h] === 1 };
  const path = new Path2D();
  for (const r of geo.roads) {
    const pts = r.pts;
    let open = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], inNet = on(p);
      if (inNet && !open) {
        /* начало участка: от середины шага с предыдущей точкой, чтобы не было зазора */
        const q = i ? { x: (pts[i - 1].x + p.x) / 2, y: (pts[i - 1].y + p.y) / 2 } : p;
        path.moveTo(q.x, q.y); path.lineTo(p.x, p.y); open = true;
      } else if (inNet) path.lineTo(p.x, p.y);
      else if (open) { path.lineTo((pts[i - 1].x + p.x) / 2, (pts[i - 1].y + p.y) / 2); open = false }
    }
  }
  return (NET_PATH = path);
}
/** цвет значения снабжения 0–10: от красного через янтарный к зелёному — без ступеней */
const SUP_STOPS = [[0, 255, 91, 71], [3, 242, 179, 61], [6, 201, 211, 107], [10, 111, 209, 141]];
function supRGB(v) {
  for (let i = 1; i < SUP_STOPS.length; i++) {
    const a = SUP_STOPS[i - 1], b = SUP_STOPS[i];
    if (v <= b[0]) { const k = (v - a[0]) / (b[0] - a[0]); return [1, 2, 3].map(j => Math.round(a[j] + (b[j] - a[j]) * k)).join(',') }
  }
  return SUP_RGB.full;
}
/** Что останется без подвоза, если линию перережут в клетке под курсором: клетки сети,
    до которых от источников уже не дойти, и свои части, которые кормятся только с них.
    Связность — по соседству клеток сети (на глаз, без мостов и зон контроля). */
let CUT = null, CUT_KEY = '';
function supplyCut() {
  const h0 = G.hover;
  if (!(h0 >= 0) || !G.svNet || !G.svNet[h0]) return null;
  const key = h0 + '|' + G.svStr + '|' + G.mapId;
  if (key === CUT_KEY) return CUT;
  CUT_KEY = key;
  const seen = new Uint8Array(H.NH), q = [];
  for (const sr of G.svSrc || []) if (sr.hex !== h0 && !seen[sr.hex]) { seen[sr.hex] = 1; q.push(sr.hex) }
  for (let i = 0; i < q.length; i++) for (const n of H.neighbors(q[i])) if (!seen[n] && n !== h0 && G.svNet[n]) { seen[n] = 1; q.push(n) }
  const hexes = [];
  for (let h = 0; h < H.NH; h++) if (G.svNet[h] && !seen[h] && h !== h0) hexes.push(h);
  if (!hexes.length) return (CUT = null);
  const lost = new Set(hexes); lost.add(h0);
  let units = 0;
  for (const u of G.units) {
    if (u.side !== G.side) continue;
    const near = H.within(u.hex, 3).filter(h => G.svNet[h]);
    if (near.length && near.every(h => lost.has(h))) units++;
  }
  return (CUT = { hexes, units });
}
function drawSupplyOverlay() {
  if (!G.showSupply || !G.sv || !G.terr) return;
  const own = G.spec ? 1 : G.side === N ? 1 : 2, s = G.view.s;
  cx.save();
  /* поле: подкраска клеток по значению — плавно бледнеет с удалением от дороги */
  const by = Array.from({ length: 11 }, () => []);
  for (let h = 0; h < H.NH; h++) {
    if (G.terr[h] !== own) continue;
    const q = w2s(H.center(h));
    if (onScreen(q, 40)) by[Math.min(10, G.sv[h])].push(h);
  }
  for (let v = 0; v <= 10; v++) {
    if (!by[v].length) continue;
    cx.beginPath(); for (const h of by[v]) addHex(h, .96);
    cx.fillStyle = `rgba(${supRGB(v)},${v === 0 ? .2 : .2 - .011 * v})`; cx.fill();
  }
  /* сеть: по самим дорогам карты — те же сглаженные линии, что нарисованы
     на местности; берём участки, чьи точки лежат в клетках на линии снабжения */
  const NET = supplyNetPath();
  if (NET) {
    cx.save();
    cx.translate(CW / 2, CH / 2); cx.scale(s, s); cx.translate(-G.view.x, -G.view.y);
    cx.lineCap = 'round'; cx.lineJoin = 'round';
    cx.strokeStyle = 'rgba(6,16,28,.7)'; cx.lineWidth = clamp(s * 1.1, 4, 11) / s; cx.stroke(NET);
    cx.strokeStyle = 'rgba(90,170,255,.85)'; cx.lineWidth = clamp(s * .6, 2.4, 6.5) / s; cx.stroke(NET);
    cx.strokeStyle = 'rgba(220,240,255,.9)'; cx.lineWidth = clamp(s * .18, 1, 2) / s;
    cx.setLineDash([3 / s, 9 / s]); cx.lineDashOffset = -ANIM * 14 / s; cx.stroke(NET); cx.setLineDash([]);
    cx.restore();
  }
  /* курсор на линии снабжения: что погаснет, если её перережут здесь */
  const cut = G.spec ? null : supplyCut();
  if (cut) {
    const k = .5 + .5 * Math.sin(ANIM * 5);
    cx.beginPath(); for (const h of cut.hexes) { const q = w2s(H.center(h)); if (onScreen(q, 40)) addHex(h, .9) }
    cx.fillStyle = `rgba(255,70,50,${.22 + .14 * k})`; cx.fill();
    cx.strokeStyle = `rgba(255,110,90,${.5 + .4 * k})`; cx.lineWidth = 1.4; cx.stroke();
    hexPath(G.hover, .9); cx.strokeStyle = '#ff5b47'; cx.lineWidth = 3; cx.stroke();
    const q = w2s(H.center(G.hover)), txt = `разрыв здесь: без подвоза ${cut.hexes.length} кл. дороги${cut.units ? ' · частей: ' + cut.units : ''}`;
    cx.font = '700 11px system-ui'; cx.textAlign = 'center';
    const w = cx.measureText(txt).width + 14, y = q.y - Hex.R * s * .9 - 20;
    cx.fillStyle = 'rgba(30,8,6,.94)'; rr(cx, q.x - w / 2, y, w, 18, 5); cx.fill();
    cx.strokeStyle = '#ff6b55'; cx.lineWidth = 1.2; cx.stroke();
    cx.fillStyle = '#ffd2c8'; cx.fillText(txt, q.x, y + 13);
  }
  /* числа в поле — когда клетка достаточно крупная */
  if (s >= 3.2) {
    cx.font = `700 ${Math.round(clamp(s * 1.5, 9, 15))}px system-ui`; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    for (let v = 1; v <= 10; v++) for (const h of by[v]) {
      if (G.svNet && G.svNet[h]) continue;
      const q = w2s(H.center(h));
      cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fillText(v, q.x + 1, q.y + 1);
      cx.fillStyle = `rgb(${supRGB(v)})`; cx.fillText(v, q.x, q.y);
    }
    cx.textBaseline = 'alphabetic';
  }
  /* источники: значок со значением (тыловые станции — один на участок края) */
  const shown = [];
  for (const sr of G.svSrc || []) {
    if (sr.k === 'rear' && shown.some(o => o.k === 'rear' && H.hexDist(o.hex, sr.hex) < 6)) continue;
    shown.push(sr);
    const q = w2s(H.center(sr.hex));
    if (!onScreen(q, 60)) continue;
    const txt = (sr.k === 'rear' ? 'станция' : sr.k === 'fob' ? 'КП' : sr.k === 'depot' ? 'полевой склад' : 'склад') + ' · ' + sr.v;
    cx.font = '700 11px system-ui'; cx.textAlign = 'center';
    const w = cx.measureText(txt).width + 14, y = q.y + Hex.R * s * .9 + 3;   /* под клеткой: сверху — подпись города */
    cx.fillStyle = 'rgba(8,22,40,.92)'; rr(cx, q.x - w / 2, y, w, 17, 5); cx.fill();
    cx.strokeStyle = 'rgba(90,170,255,.9)'; cx.lineWidth = 1.2; cx.stroke();
    cx.fillStyle = '#bfe0ff'; cx.fillText(txt, q.x, y + 12.5);
  }
  cx.restore();
}

/* ---------- секторы командиров (клавиша H) ---------- */
/** у каждого командира свой штаб и свой сектор: видно, кто за какое направление отвечает */
function drawCmdSectors() {
  if (!G.showCmd || G.spec) return;
  /* сектор дают и подвижный штаб, и командный пункт — как в правилах сервера */
  const hqs = (G.units || []).filter(u => UT[u.k] && UT[u.k].cmd && u.side === G.side && !u.ghost);
  if (!hqs.length) return;
  cx.save();
  for (const hq of hqs) {
    const mine = !hq.seat || hq.seat === G.mySeat;
    const col = mine ? '242,179,61' : '111,209,141';
    const list = H.within(hq.hex, UT[hq.k].cmd).filter(h => h >= 0), march = hq.moved && !UT[hq.k].fob;
    const set = new Set(list);
    cx.beginPath();
    for (const h of list) { const c = w2s(H.center(h)); if (onScreen(c, 40)) addHex(h, 1) }
    cx.fillStyle = `rgba(${col},${march ? .04 : .09})`; cx.fill();
    regionEdges(n => set.has(n), list);
    cx.strokeStyle = `rgba(${col},${march ? .35 : .8})`; cx.lineWidth = 1.8;
    if (march) cx.setLineDash([5, 4]);
    cx.stroke(); cx.setLineDash([]);
    /* подпись: чей сектор и держит ли он управление */
    const q = w2s(H.center(hq.hex));
    if (onScreen(q, 60)) {
      const who = (UT[hq.k].fob ? 'пункт · ' : '') + (mine ? 'ваша ставка' : (typeof seatName === 'function' && seatName(hq.seat)) || 'союзник');
      const txt = march ? who + ' · на марше' : who;
      cx.font = '700 11px system-ui'; cx.textAlign = 'center';
      const w = cx.measureText(txt).width + 10, y = q.y - Hex.R * G.view.s * 1.15;
      cx.fillStyle = 'rgba(6,10,14,.9)'; rr(cx, q.x - w / 2, y - 14, w, 16, 4); cx.fill();
      cx.fillStyle = `rgb(${col})`; cx.fillText(txt, q.x, y - 2);
    }
  }
  cx.restore();
}

/* ---------- территория и линия фронта ----------
   Земля каждой стороны чуть подкрашена (общий слой с туманом, overlayLayer).
   Линия фронта — двухцветная лента по границе территорий: со своей стороны
   синяя, со стороны противника красная. Углы клеток сглажены, чтобы лента
   шла плавно, а не пилой. Там, где у линии стоят части, лента толще; где
   части сторон стоят друг против друга — самая толстая и пульсирует.
   Котлы (острова земли без источников снабжения) обведены бегущим пунктиром. */
let FRONT = null, FRONT_KEY = '';
function buildFront() {
  if (FRONT_KEY === G.terrStr + '|' + G.mapId) return FRONT;
  FRONT_KEY = G.terrStr + '|' + G.mapId;
  if (!G.terr || typeof Path2D !== 'function') return (FRONT = null);
  /* line — граница по рёбрам клеток, для мини-карты */
  const fill = { 1: new Path2D(), 2: new Path2D() }, line = new Path2D();
  for (let h = 0; h < H.NH; h++) {
    const t = G.terr[h];
    if (!t) continue;
    const cs = H.corners(h, 1.02);
    fill[t].moveTo(cs[0].x, cs[0].y); for (let i = 1; i < 6; i++) fill[t].lineTo(cs[i].x, cs[i].y); fill[t].closePath();
    const ce = H.corners(h);
    for (let d = 0; d < 6; d++) {
      const n = H.nb(h, d);
      if (n < 0 || n < h || !G.terr[n] || G.terr[n] === t) continue;
      const [i, j] = EDGE_V[d];
      line.moveTo(ce[i].x, ce[i].y); line.lineTo(ce[j].x, ce[j].y);
    }
  }
  return (FRONT = { fill, line });
}
/* полуширина одной полосы ленты, км: тихий участок · части у линии · соприкосновение */
const RIB_OFF = [.26, .4, .62];
let RIBBON = null, RIB_KEY = '';
function buildRibbon() {
  const key = G.terrStr + '|' + G.mapId + '|' + (G.units || []).map(u => u.hex).join(',');
  if (key === RIB_KEY) return RIBBON;
  RIB_KEY = key;
  if (!G.terr || typeof Path2D !== 'function') return (RIBBON = null);
  const occ = new Map();
  for (const u of G.units || []) occ.set(u.hex, u.side === N ? 1 : 2);
  const verts = new Map(), segs = [];
  const vk = p => Math.round(p.x * 8) + ':' + Math.round(p.y * 8);
  const vert = p => { const k = vk(p); if (!verts.has(k)) verts.set(k, { x: p.x, y: p.y, nb: [] }); return k };
  for (let h = 0; h < H.NH; h++) {
    const t = G.terr[h];
    if (!t) continue;
    const ce = H.corners(h), c0 = H.center(h);
    for (let d = 0; d < 6; d++) {
      const n = H.nb(h, d);
      if (n < 0 || n < h || !G.terr[n] || G.terr[n] === t) continue;
      const [i, j] = EDGE_V[d], cn = H.center(n), L = Math.hypot(cn.x - c0.x, cn.y - c0.y) || 1;
      const ka = vert(ce[i]), kb = vert(ce[j]);
      verts.get(ka).nb.push(kb); verts.get(kb).nb.push(ka);
      const uh = occ.get(h), un = occ.get(n);
      segs.push({ ka, kb, nx: (cn.x - c0.x) / L, ny: (cn.y - c0.y) / L, t, tn: G.terr[n], heat: uh === t && un === G.terr[n] ? 2 : uh || un ? 1 : 0 });
    }
  }
  /* сглаживание: вершина на непрерывной линии тянется к середине между соседними */
  const pos = new Map();
  for (const [k, v] of verts) {
    if (v.nb.length !== 2) { pos.set(k, v); continue }
    const a = verts.get(v.nb[0]), b = verts.get(v.nb[1]);
    pos.set(k, { x: v.x * .5 + (a.x + b.x) * .25, y: v.y * .5 + (a.y + b.y) * .25 });
  }
  const band = { 1: [new Path2D(), new Path2D(), new Path2D()], 2: [new Path2D(), new Path2D(), new Path2D()] };
  for (const sg of segs) {
    const A = pos.get(sg.ka), B = pos.get(sg.kb), o = RIB_OFF[sg.heat], ox = sg.nx * o, oy = sg.ny * o;
    band[sg.t][sg.heat].moveTo(A.x - ox, A.y - oy); band[sg.t][sg.heat].lineTo(B.x - ox, B.y - oy);
    band[sg.tn][sg.heat].moveTo(A.x + ox, A.y + oy); band[sg.tn][sg.heat].lineTo(B.x + ox, B.y + oy);
  }
  return (RIBBON = { band });
}
function drawFront() {
  const F = buildRibbon();
  if (F) {
    const s = G.view.s, own = G.spec ? 1 : G.side === N ? 1 : 2;
    cx.save();
    cx.translate(CW / 2, CH / 2); cx.scale(s, s); cx.translate(-G.view.x, -G.view.y);
    cx.lineJoin = 'round'; cx.lineCap = 'round';
    /* тёмная подложка под обе полосы — чтобы лента читалась на любой местности */
    for (const t of [1, 2]) for (let hq = 0; hq < 3; hq++) { cx.strokeStyle = 'rgba(4,8,12,.6)'; cx.lineWidth = Math.max(RIB_OFF[hq] * 2, 2 / s) + 2.2 / s; cx.stroke(F.band[t][hq]) }
    const pulse = .78 + .22 * Math.sin(ANIM * 4);
    for (const t of [1, 2]) for (let hq = 0; hq < 3; hq++) {
      const a = hq === 2 ? pulse : hq === 1 ? .9 : .72;
      cx.strokeStyle = t === own ? `rgba(108,195,255,${a})` : `rgba(255,107,85,${a})`;
      cx.lineWidth = Math.max(RIB_OFF[hq] * 2, 2 / s); cx.stroke(F.band[t][hq]);
    }
    cx.restore();
  }
  drawPockets();
}
/** котлы: пульсирующий контур; свой — тревожно-красный, чужой — золотой */
function drawPockets() {
  for (const p of G.pockets || []) {
    const mine = G.spec ? p.side === N : p.side === G.side;
    const set = p._set || (p._set = new Set(p.hexes)), k = .5 + .5 * Math.sin(ANIM * 4);
    let sx = 0, sy = 0, vis = 0;
    cx.beginPath();
    for (const h of p.hexes) { const c = H.center(h), q = w2s(c); sx += c.x; sy += c.y; if (onScreen(q, 40)) { addHex(h, 1); vis++ } }
    if (!vis) continue;
    cx.fillStyle = mine ? `rgba(255,70,50,${.07 + .06 * k})` : `rgba(242,179,61,${.05 + .05 * k})`; cx.fill();
    regionEdges(n => set.has(n), p.hexes);
    cx.lineWidth = 4.4; cx.strokeStyle = 'rgba(0,0,0,.5)'; cx.stroke();
    cx.lineWidth = 2.4; cx.strokeStyle = mine ? `rgba(255,90,70,${.55 + .45 * k})` : `rgba(255,214,121,${.5 + .5 * k})`;
    cx.setLineDash([8, 5]); cx.lineDashOffset = -ANIM * 12; cx.stroke(); cx.setLineDash([]);
    if (p.hexes.length >= 2 && G.view.s >= 1.6) {
      const q = w2s({ x: sx / p.hexes.length, y: sy / p.hexes.length });
      cx.font = '800 11px system-ui'; cx.textAlign = 'center';
      const w = cx.measureText('КОТЁЛ').width + 12;
      cx.fillStyle = 'rgba(6,10,14,.88)'; rr(cx, q.x - w / 2, q.y + Hex.R * G.view.s * .5, w, 16, 4); cx.fill();
      cx.fillStyle = mine ? '#ff8a72' : '#ffd479'; cx.fillText('КОТЁЛ', q.x, q.y + Hex.R * G.view.s * .5 + 12);
    }
  }
}

/* ---------- понтоны, мины, укрепления, заграждения ---------- */
function drawPontoons() {
  const s = G.view.s;
  for (const [key, st] of G.br || []) {
    if (st !== 'pontoon') continue;
    const [a, b] = key.split('-').map(Number), A = H.center(a), B = H.center(b), q = w2s({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    if (!onScreen(q, 40)) continue;
    const ang = Math.atan2(B.y - A.y, B.x - A.x), L = clamp(s * 2.6, 12, 40), Wd = clamp(s * .8, 4, 11);
    cx.save(); cx.translate(q.x, q.y); cx.rotate(ang);
    cx.fillStyle = 'rgba(0,0,0,.45)'; cx.fillRect(-L / 2 + 1.5, -Wd / 2 + 2, L, Wd);
    for (let i = 0; i < 4; i++) { cx.fillStyle = i % 2 ? '#a88a3c' : '#c9a54a'; cx.fillRect(-L / 2 + i * L / 4, -Wd / 2, L / 4 - 1, Wd) }
    cx.strokeStyle = '#141414'; cx.lineWidth = 1; cx.strokeRect(-L / 2 + .5, -Wd / 2 + .5, L - 1, Wd - 1);
    cx.restore();
  }
}
function drawMines() {
  const s = G.view.s;
  for (const m of G.mines || []) {
    const q = w2s(H.center(m.hex));
    if (!onScreen(q, 30)) continue;
    const own = G.spec ? m.side === N : m.side === G.side, col = own ? '#d8bf88' : '#ff6b55';
    /* условный знак минного поля: ряд «колышков» с проволокой */
    const r = clamp(s * .32, 1.6, 3.2), R0 = Hex.R * s * .62;
    cx.strokeStyle = col; cx.lineWidth = 1; cx.setLineDash([2, 2]);
    cx.beginPath(); cx.arc(q.x, q.y, R0, Math.PI * .1, Math.PI * .9); cx.stroke(); cx.setLineDash([]);
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (.14 + i * .18), x = q.x + Math.cos(a) * R0, y = q.y + Math.sin(a) * R0;
      cx.fillStyle = 'rgba(0,0,0,.6)'; cx.beginPath(); cx.arc(x + .8, y + .8, r, 0, 7); cx.fill();
      cx.fillStyle = col; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill();
    }
    if (s > 5) { cx.fillStyle = col; cx.font = '700 10px system-ui'; cx.textAlign = 'center'; cx.fillText('мины', q.x, q.y + Hex.R * s * .88) }
  }
}
function drawWorks() {
  const s = G.view.s;
  for (const [h, lvl] of G.forts || []) {
    const c = H.center(h);
    if (!onScreen(w2s(c), 60)) continue;
    for (let ring = 0; ring < lvl; ring++) {
      const cs = H.corners(h, .84 - ring * .14).map(w2s);
      const zig = () => {
        cx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = cs[i], b = cs[(i + 1) % 6];
          for (let k = 0; k < 8; k++) {
            const t = k / 8, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, o = (k % 2 ? 1 : -1) * clamp(s * .2, .8, 2.2);
            const nx = -(b.y - a.y), ny = b.x - a.x, L = Math.hypot(nx, ny) || 1;
            i === 0 && k === 0 ? cx.moveTo(x + nx / L * o, y + ny / L * o) : cx.lineTo(x + nx / L * o, y + ny / L * o);
          }
        }
        cx.closePath();
      };
      zig(); cx.strokeStyle = 'rgba(20,14,8,.85)'; cx.lineWidth = Math.max(3, s * .7); cx.stroke();
      zig(); cx.strokeStyle = 'rgba(205,175,120,.9)'; cx.lineWidth = Math.max(1.4, s * .3); cx.stroke();
    }
  }
  /* противотанковые «ежи» */
  for (const h of G.obst || []) {
    const c = w2s(H.center(h));
    if (!onScreen(c, 60)) continue;
    const r = Hex.R * s * .55, z = clamp(s * .8, 3, 8);
    for (let i = -2; i <= 2; i++) for (const row of [-1, 1]) {
      const x = c.x + i * r * .4 + row * r * .2, y = c.y + row * r * .32;
      cx.strokeStyle = 'rgba(10,10,10,.8)'; cx.lineWidth = 3;
      cx.beginPath(); cx.moveTo(x - z, y - z * .6); cx.lineTo(x + z, y + z * .6); cx.moveTo(x + z, y - z * .6); cx.lineTo(x - z, y + z * .6); cx.moveTo(x, y - z); cx.lineTo(x, y + z * .4); cx.stroke();
      cx.strokeStyle = '#a9aca8'; cx.lineWidth = 1.4; cx.stroke();
    }
  }
}

/* ---------- точки: контур клетки, табличка с названием и весом ---------- */
function drawPoints() {
  const s = G.view.s, own0 = G.spec ? N : G.side;
  for (const p of G.pts) {
    const q = w2s(H.center(p.hex));
    if (!onScreen(q, 80)) continue;
    const col = !p.owner ? '#c8c8b8' : p.owner === N ? '#6cc3ff' : '#ff8a72';
    hexPath(p.hex, .95);
    cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.lineWidth = p.city ? 4.5 : 3.5; cx.stroke();
    cx.strokeStyle = col; cx.lineWidth = p.city ? 2.2 : 1.6; cx.setLineDash(p.city ? [] : [5, 3]); cx.stroke(); cx.setLineDash([]);
    if (G.scen && G.scen.target === p.id) { hexPath(p.hex, 1.1 + .04 * Math.sin(ANIM * 4)); cx.strokeStyle = `rgba(242,179,61,${.55 + .45 * Math.sin(ANIM * 4)})`; cx.lineWidth = 2.4; cx.stroke() }
    /* табличка */
    const big = p.w >= 2.5, fs = big ? 13 : p.city ? 12 : 11;
    if (!p.city && s < 2.2 && !big) continue;
    cx.font = `${p.city ? 700 : 600} ${fs}px system-ui,sans-serif`; cx.textAlign = 'center';
    const tw = cx.measureText(p.n).width, pw = tw + 22, ph = fs + 8, ty = q.y - Hex.R * s * .95 - ph - 2;
    cx.fillStyle = 'rgba(0,0,0,.45)'; rr(cx, q.x - pw / 2 + 1.5, ty + 2, pw, ph, 4); cx.fill();
    cx.fillStyle = 'rgba(8,13,18,.9)'; rr(cx, q.x - pw / 2, ty, pw, ph, 4); cx.fill();
    cx.fillStyle = col; cx.save(); rr(cx, q.x - pw / 2, ty, pw, ph, 4); cx.clip(); cx.fillRect(q.x - pw / 2, ty, 4, ph); cx.restore();
    cx.strokeStyle = 'rgba(255,255,255,.1)'; cx.lineWidth = 1; rr(cx, q.x - pw / 2 + .5, ty + .5, pw - 1, ph - 1, 4); cx.stroke();
    cx.fillStyle = !p.owner ? '#e8e8da' : p.owner === own0 ? '#dcecf6' : '#ffc9b8';
    cx.fillText(p.n, q.x + 2, ty + ph - 5.5);
    /* вес — точки под табличкой */
    const n = Math.round(p.w * 2) / 2, dots = Math.ceil(n);
    for (let i = 0; i < dots; i++) {
      const dx = q.x + (i - (dots - 1) / 2) * 6;
      cx.fillStyle = 'rgba(0,0,0,.7)'; cx.beginPath(); cx.arc(dx, ty + ph + 4, 2.6, 0, 7); cx.fill();
      cx.fillStyle = i + 1 <= n ? col : 'rgba(255,255,255,.35)'; cx.beginPath(); cx.arc(dx, ty + ph + 4, 1.8, 0, 7); cx.fill();
    }
  }
}

/* ---------- подсветка ходов и целей ---------- */
function drawSelection() {
  const u = selUnit();
  if (!u) return;
  const s = G.view.s, T = utFor(u.side)[u.k];
  /* выбранная клетка: золотой контур с пульсом */
  hexPath(u.hex, .98); cx.strokeStyle = `rgba(242,179,61,${.75 + .25 * Math.sin(ANIM * 5)})`; cx.lineWidth = 2.6; cx.stroke();
  if (T.cmd) { const set = new Set(H.within(u.hex, T.cmd)); regionEdges(n => set.has(n), set); cx.strokeStyle = 'rgba(200,160,255,.55)'; cx.setLineDash([6, 5]); cx.lineWidth = 1.4; cx.stroke(); cx.setLineDash([]) }
  if (T.bomb) { const set = new Set(H.within(u.hex, T.bomb.rng)); cx.beginPath(); for (const h of set) addHex(h, 1); cx.fillStyle = 'rgba(255,140,90,.05)'; cx.fill(); regionEdges(n => set.has(n), set); cx.strokeStyle = 'rgba(255,150,100,.6)'; cx.setLineDash([4, 4]); cx.lineWidth = 1.4; cx.stroke(); cx.setLineDash([]) }
  if (T.aa) { const set = new Set(H.within(u.hex, T.aa)); regionEdges(n => set.has(n), set); cx.strokeStyle = 'rgba(160,220,255,.5)'; cx.setLineDash([2, 4]); cx.lineWidth = 1.4; cx.stroke(); cx.setLineDash([]) }
  if (G.reach && G.isMyTurn) {
    const list = [];
    for (const [h, r] of G.reach) if (h !== u.hex && !r.through) list.push(h);
    /* область хода: заливка и общий контур, броды — голубым */
    cx.beginPath(); for (const h of list) if (!G.reach.get(h).ford) addHex(h, 1);
    cx.fillStyle = 'rgba(108,195,255,.15)'; cx.fill();
    cx.beginPath(); for (const h of list) if (G.reach.get(h).ford) addHex(h, 1);
    cx.fillStyle = 'rgba(80,170,240,.28)'; cx.fill();
    const has = n => n === u.hex || (G.reach.has(n) && !G.reach.get(n).through);
    regionEdges(has, list.concat([u.hex]));
    cx.strokeStyle = 'rgba(0,0,0,.55)'; cx.lineWidth = 3.4; cx.stroke();
    cx.strokeStyle = 'rgba(140,210,255,.9)'; cx.lineWidth = 1.6; cx.stroke();
    /* клетки в зоне контроля противника: войдя, часть встанет — знак «стоп» */
    if (G.reachZoc) for (const h of list) {
      if (!G.reachZoc.has(h)) continue;
      const q = w2s(H.center(h));
      if (!onScreen(q, 20)) continue;
      const r = clamp(s * 1.1, 4, 8);
      cx.beginPath(); cx.arc(q.x, q.y, r, 0, 7); cx.fillStyle = 'rgba(200,40,30,.92)'; cx.fill();
      cx.lineWidth = 1.2; cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.stroke();
      cx.fillStyle = '#fff'; cx.fillRect(q.x - r * .62, q.y - r * .2, r * 1.24, r * .4);
    }
    /* путь под курсором: стрелка и стоимость */
    if (G.hover >= 0 && G.reach.has(G.hover) && G.hover !== u.hex && !G.reach.get(G.hover).through) {
      const raw = Rules.pathTo(G.reach, G.hover).map(h => H.center(h));
      const p = chaikin(raw, 2).map(w2s);
      cx.lineJoin = 'round'; cx.lineCap = 'round';
      cx.beginPath(); p.forEach((q, i) => i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y));
      cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.lineWidth = 6; cx.stroke();
      cx.strokeStyle = '#ffe6a0'; cx.lineWidth = 3; cx.stroke();
      const e = p[p.length - 1], e0 = p[Math.max(0, p.length - 3)], ang = Math.atan2(e.y - e0.y, e.x - e0.x), A = 11;
      cx.fillStyle = '#ffe6a0'; cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.moveTo(e.x + Math.cos(ang) * 3, e.y + Math.sin(ang) * 3);
      cx.lineTo(e.x - Math.cos(ang - .5) * A, e.y - Math.sin(ang - .5) * A); cx.lineTo(e.x - Math.cos(ang + .5) * A, e.y - Math.sin(ang + .5) * A); cx.closePath(); cx.stroke(); cx.fill();
      const r = G.reach.get(G.hover), left = Math.max(0, u.mp - r.c);
      const txt = (r.ford ? 'брод · весь ход' : `${fmtMp(r.c)} оч. · ост. ${fmtMp(left)}`) + (G.reachZoc && G.reachZoc.has(G.hover) ? ' · стоп: рядом противник' : '');
      cx.font = '700 11px system-ui'; cx.textAlign = 'center';
      const tw = cx.measureText(txt).width + 12, tq = w2s(H.center(G.hover)), ty = tq.y + Hex.R * s * .55;
      cx.fillStyle = 'rgba(6,10,14,.92)'; rr(cx, tq.x - tw / 2, ty, tw, 17, 5); cx.fill();
      cx.strokeStyle = 'rgba(255,230,160,.5)'; cx.lineWidth = 1; rr(cx, tq.x - tw / 2 + .5, ty + .5, tw - 1, 16, 5); cx.stroke();
      cx.fillStyle = '#ffe6a0'; cx.fillText(txt, tq.x, ty + 12.5);
    }
  }
  drawTargets();
}
/** цели: перекрестие и плашка с соотношением сил (или расчётом огня, авиаудара) */
/** стрелка от a к b в координатах экрана: тёмная обводка, древко, наконечник */
function arrowLine(a, b, col, w, opt) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (L < 4) return;
  const ux = dx / L, uy = dy / L, o = opt || {}, hd = o.noHead ? 0 : w * 2.3;
  const p0 = { x: a.x + ux * (o.from || 0), y: a.y + uy * (o.from || 0) }, p1 = { x: b.x - ux * (o.to || 0), y: b.y - uy * (o.to || 0) };
  if ((p1.x - p0.x) * ux + (p1.y - p0.y) * uy < hd + 2) return;
  const e = { x: p1.x - ux * hd * .85, y: p1.y - uy * hd * .85 };
  cx.save();
  cx.globalAlpha *= o.alpha === undefined ? 1 : o.alpha;
  cx.lineCap = 'round'; cx.lineJoin = 'round';
  if (o.dash) cx.setLineDash(o.dash);
  cx.beginPath(); cx.moveTo(p0.x, p0.y); cx.lineTo(e.x, e.y);
  cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.lineWidth = w + 3; cx.stroke();
  cx.strokeStyle = col; cx.lineWidth = w; cx.stroke();
  cx.setLineDash([]);
  if (hd) {
    const px = -uy, py = ux;
    cx.beginPath(); cx.moveTo(p1.x, p1.y); cx.lineTo(p1.x - ux * hd + px * hd * .55, p1.y - uy * hd + py * hd * .55); cx.lineTo(p1.x - ux * hd - px * hd * .55, p1.y - uy * hd - py * hd * .55); cx.closePath();
    cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.lineWidth = 3; cx.stroke();
    cx.fillStyle = col; cx.fill();
  }
  cx.restore();
}
/** план удара по цели под курсором: жирная стрелка от выбранной части цветом соотношения;
    части, дающие охват, показаны тонкими стрелками, сходящимися на цели */
function planArrows(u, t) {
  const s = G.view.s, R = Hex.R * s, B = w2s(H.center(t.hex));
  if (t.odds) for (const h of H.neighbors(t.hex)) {
    const o = G.units.find(x => x.hex === h);
    if (!o || o.side !== u.side || o.id === u.id || o.rem || !(UT[o.k] && UT[o.k].atk.soft > 0)) continue;
    arrowLine(w2s(H.center(h)), B, t.col, clamp(s * .7, 2.4, 4.5), { from: R * .42, to: R * .56, dash: [6, 5], alpha: .8 });
  }
  const w = clamp(s * 1.5, 5, 10);
  arrowLine(w2s(H.center(u.hex)), B, t.col, t.odds ? w : w * .6, { from: R * .36, to: R * .5, dash: t.odds ? null : t.fire ? [w * 1.1, w * .9] : [3, 6], alpha: .94 });
}
/** стрелки плана — поверх фишек: на крупном масштабе фишки соседних клеток стоят вплотную */
function drawPlan() {
  const su = selUnit();
  if (!su || animBusy()) return;
  for (const t of G.targets || []) if (t.hex === G.hover && (t.odds || t.fire || t.probe)) planArrows(su, t);
}
function drawTargets() {
  const s = G.view.s;
  for (const t of G.targets || []) {
    const q = w2s(H.center(t.hex)), R = Hex.R * s * .78, hot = t.hex === G.hover;
    cx.strokeStyle = t.col; cx.lineWidth = hot ? 2.6 : 1.8;
    cx.beginPath(); cx.arc(q.x, q.y, R, 0, 7); cx.stroke();
    cx.beginPath();
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + (hot ? ANIM * 1.5 : 0); cx.moveTo(q.x + Math.cos(a) * R * .72, q.y + Math.sin(a) * R * .72); cx.lineTo(q.x + Math.cos(a) * R * 1.18, q.y + Math.sin(a) * R * 1.18) }
    cx.stroke();
    cx.font = '800 12px system-ui'; cx.textAlign = 'center';
    const w = cx.measureText(t.lb).width + 14, y = q.y + R * .62;
    cx.fillStyle = 'rgba(0,0,0,.5)'; rr(cx, q.x - w / 2 + 1, y + 2, w, 18, 9); cx.fill();
    cx.fillStyle = 'rgba(6,10,14,.95)'; rr(cx, q.x - w / 2, y, w, 18, 9); cx.fill();
    cx.strokeStyle = t.col; cx.lineWidth = 1.2; rr(cx, q.x - w / 2 + .5, y + .5, w - 1, 17, 9); cx.stroke();
    cx.fillStyle = t.col; cx.fillText(t.lb, q.x, y + 13);
  }
}
const fmtMp = v => (Math.round(v * 10) / 10).toString().replace('.', ',');
/** режим авиаудара: зонтики видимых ПВО противника и расчёт на каждой цели */
function drawAirMode() {
  if (G.mode !== 'air:strike') return;
  for (const a of G.units) {
    if (a.side === G.side || !UT[a.k] || !UT[a.k].aa) continue;
    const set = new Set(H.within(a.hex, UT[a.k].aa));
    cx.beginPath(); for (const h of set) { const q = w2s(H.center(h)); if (onScreen(q, 60)) addHex(h, 1) }
    cx.fillStyle = 'rgba(120,200,255,.08)'; cx.fill();
    regionEdges(n => set.has(n), set);
    cx.strokeStyle = 'rgba(150,215,255,.75)'; cx.lineWidth = 1.6; cx.setLineDash([5, 4]); cx.stroke(); cx.setLineDash([]);
    const q = w2s(H.center(a.hex));
    if (onScreen(q, 60)) {
      cx.font = '700 11px system-ui'; cx.textAlign = 'center';
      const txt = 'ПВО', w = cx.measureText(txt).width + 10, y = q.y - Hex.R * G.view.s * 1.05;
      cx.fillStyle = 'rgba(6,14,22,.9)'; rr(cx, q.x - w / 2, y - 14, w, 16, 4); cx.fill();
      cx.fillStyle = '#9fd3f5'; cx.fillText(txt, q.x, y - 2);
    }
  }
  if (!selUnit()) drawTargets();
}

/* ---------- фишки ---------- */
function drawUnits() {
  for (const g of G.ghosts || []) { const q = w2s(H.center(g.hex)); if (onScreen(q, 60)) counter({ ...g, ghost: 1, side: G.side === N ? S : N }, q, .65) }
  const list = G.units.filter(u => !ANIMS.hidden.has(u.id)).map(u => ({ u, p: ANIMS.pos.get(u.id) || H.center(u.hex) }));
  list.sort((a, b) => (a.u.id === G.sel) - (b.u.id === G.sel) || a.p.y - b.p.y);
  for (const { u, p } of list) { const q = w2s(p); if (onScreen(q, 70)) counter(u, q) }
  for (const d of ANIMS.dying) { const k = clamp((RT() - d.t0) / .9, 0, 1); counter(d.u, w2s(d.p), 1 - k, 1 - k * .25) }
  /* призрак хода: полупрозрачная фишка там, куда часть придёт */
  const su = selUnit();
  if (su && G.isMyTurn && G.reach && G.hover >= 0 && G.hover !== su.hex && !animBusy()) {
    const r = G.reach.get(G.hover);
    if (r && !r.through) counter({ ...su, id: -1, ent: 0, amb: 0, prep: 0 }, w2s(H.center(G.hover)), .5);
  }
}

/* ---------- сводка хода противника ----------
   Пока ходит противник, запоминаем, что случилось на наших глазах: атаки, обстрелы,
   потери, отходы, взятые точки. В начале своего хода это коротко показано стрелками
   на карте и строкой сверху; гаснет само или по клику. Клавиша V — показать снова. */
const RECAP = { rec: false, on: false, items: [], t0: 0, sum: '' };
const RECAP_T = 16;
function recapNote(e) {
  if (G.spec) return;
  if (e.e === 'turn') { if (e.side !== G.side) { RECAP.rec = true; RECAP.on = false; RECAP.items = [] } else RECAP.rec = false; return }
  if (!RECAP.rec) return;
  const mineAt = h => G.units.some(u => u.hex === h && u.side === G.side);
  const mineId = id => { const u = G.units.find(x => x.id === id); return !!u && u.side === G.side };
  const I = RECAP.items;
  if (e.e === 'fight') I.push({ k: e.amb ? 'amb' : e.fire ? 'fire' : e.probe ? 'probe' : 'atk', a: e.ah, b: e.dh, la: e.la || 0, ld: e.ld || 0, su: e.su || 0 });
  else if (e.e === 'shell' && e.from !== null && e.from !== undefined) I.push({ k: 'shell', a: e.from, b: e.hex, mine: mineAt(e.from) });
  else if (e.e === 'blast' && e.ld && e.id !== undefined && mineId(e.id)) I.push({ k: 'hit', b: e.hex, ld: e.ld });
  else if (e.e === 'dead') I.push({ k: 'dead', b: e.hex, mine: e.side === G.side, how: e.how });
  else if (e.e === 'capture') I.push({ k: 'cap', b: e.hex, mine: e.side === G.side, n: e.n });
  else if (e.e === 'move' && e.retreat && e.side === G.side && e.path.length > 1) I.push({ k: 'ret', a: e.path[0], b: e.path[e.path.length - 1], rem: e.rem });
  else if (e.e === 'air' && e.kind === 'strike' && e.side !== undefined && e.side !== G.side) I.push({ k: 'air', b: e.hex });
}
/** начало своего хода: собрать итог и показать */
function recapShow() {
  const I = RECAP.items;
  if (!I.length) { RECAP.on = false; return }
  const n = k => I.filter(x => x.k === k).length;
  const lost = I.reduce((a, x) => a + (x.k === 'atk' || x.k === 'fire' || x.k === 'probe' || x.k === 'hit' ? x.ld : 0), 0);
  const dead = I.filter(x => x.k === 'dead' && x.mine).length, caps = I.filter(x => x.k === 'cap' && !x.mine).map(x => x.n);
  const parts = [];
  if (n('atk')) parts.push('атак: ' + n('atk'));
  if (n('fire') + n('probe')) parts.push('обстрелов: ' + (n('fire') + n('probe')));
  const sh = I.filter(x => x.k === 'shell' && !x.mine).length + n('air');
  if (sh) parts.push('огневых налётов: ' + sh);
  if (lost) parts.push('потеряно шагов: ' + lost);
  if (dead) parts.push('частей уничтожено: ' + dead);
  if (caps.length) parts.push('потеряны: ' + caps.join(', '));
  RECAP.sum = parts.join(' · ');
  RECAP.on = !!parts.length; RECAP.t0 = RT();
}
function recapToggle() {
  if (!RECAP.items.length) { if (typeof toast === 'function') toast('За прошлый ход противника показать нечего'); return }
  if (RECAP.on) RECAP.on = false; else { recapShow(); if (!RECAP.on) toast('За прошлый ход противника показать нечего') }
}
function drawRecap() {
  if (!RECAP.on) return;
  const age = RT() - RECAP.t0;
  if (age > RECAP_T) { RECAP.on = false; return }
  const s = G.view.s, R = Hex.R * s, c = h => w2s(H.center(h)), al = clamp(Math.min(age / .4, (RECAP_T - age) / 2), 0, 1);
  const tag = (q, txt, col) => {
    cx.font = '800 11px system-ui'; cx.textAlign = 'center';
    const w = cx.measureText(txt).width + 10;
    cx.fillStyle = 'rgba(6,10,14,.9)'; rr(cx, q.x - w / 2, q.y - 8, w, 16, 4); cx.fill();
    cx.fillStyle = col; cx.fillText(txt, q.x, q.y + 4);
  };
  cx.save(); cx.globalAlpha = al;
  for (const x of RECAP.items) {
    if (x.k === 'atk') { arrowLine(c(x.a), c(x.b), '#ff6b55', clamp(s * 1.2, 4, 8), { from: R * .45, to: R * .6 }); if (x.ld) tag({ x: c(x.b).x, y: c(x.b).y - R * .95 }, '−' + x.ld, '#ff8f80') }
    else if (x.k === 'fire' || x.k === 'probe') { arrowLine(c(x.a), c(x.b), '#ffb070', clamp(s * .8, 3, 5), { from: R * .45, to: R * .6, dash: [6, 5] }); if (x.ld || x.su) tag({ x: c(x.b).x, y: c(x.b).y - R * .95 }, (x.ld ? '−' + x.ld + ' ' : '') + (x.su ? '⚡' + x.su : ''), '#ffb070') }
    else if (x.k === 'amb') { arrowLine(c(x.a), c(x.b), '#9fe0a8', clamp(s * .8, 3, 5), { from: R * .45, to: R * .6 }); tag({ x: c(x.b).x, y: c(x.b).y - R * .95 }, 'засада −' + x.ld, '#9fe0a8') }
    else if (x.k === 'shell') arrowLine(c(x.a), c(x.b), x.mine ? '#9fd3f5' : '#ffb070', 2.2, { from: R * .4, to: R * .5, dash: [2, 6], alpha: .85 });
    else if (x.k === 'hit') tag({ x: c(x.b).x, y: c(x.b).y - R * .95 }, 'огонь −' + x.ld, '#ffb070');
    else if (x.k === 'ret') { arrowLine(c(x.a), c(x.b), '#ffd479', clamp(s * .7, 2.5, 4.5), { from: R * .2, to: R * .5 }); tag({ x: c(x.a).x, y: c(x.a).y + R * .2 }, x.rem ? 'разбиты' : 'отошли', '#ffd479') }
    else if (x.k === 'air') tag({ x: c(x.b).x, y: c(x.b).y - R * 1.35 }, '✈ налёт', '#ffb070');
    else if (x.k === 'dead' && x.mine) {
      const q = c(x.b), d = R * .42;
      cx.lineCap = 'round'; cx.beginPath(); cx.moveTo(q.x - d, q.y - d); cx.lineTo(q.x + d, q.y + d); cx.moveTo(q.x + d, q.y - d); cx.lineTo(q.x - d, q.y + d);
      cx.lineWidth = 6; cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.stroke(); cx.lineWidth = 3; cx.strokeStyle = '#ff5b47'; cx.stroke();
      tag({ x: q.x, y: q.y + R * .75 }, x.how === 'surrender' ? 'сдались' : x.how === 'captured' ? 'захвачен' : 'уничтожен', '#ff8f80');
    } else if (x.k === 'cap' && !x.mine) { hexPath(x.b, 1.06); cx.strokeStyle = '#ff5b47'; cx.lineWidth = 3; cx.setLineDash([6, 4]); cx.stroke(); cx.setLineDash([]) }
  }
  /* свои части, оставшиеся без снабжения */
  for (const u of G.units) if (u.side === G.side && u.supplied === 0) { const q = c(u.hex); cx.beginPath(); cx.arc(q.x, q.y, R * (.92 + .06 * Math.sin(ANIM * 6)), 0, 7); cx.strokeStyle = '#ff5b47'; cx.lineWidth = 2.4; cx.setLineDash([5, 4]); cx.stroke(); cx.setLineDash([]) }
  /* строка итога — сверху по центру карты */
  const cut = G.units.filter(u => u.side === G.side && u.supplied === 0).length;
  /* между мини-картой и кнопками масштаба; не влезает в строку — переносим по пунктам */
  const parts = ['Ход противника'].concat(RECAP.sum.split(' · '), cut ? ['без снабжения: ' + cut] : [], ['V — скрыть']);
  const a = mapArea(), mr = miniRect(), xl = mr.x + mr.w + 12, maxW = Math.max(160, a.r - 58 - xl - 24);
  cx.font = '700 12px system-ui'; cx.textAlign = 'left';
  const lines = [''];
  for (const p of parts) {
    const cur = lines[lines.length - 1], next = cur ? cur + '  ·  ' + p : p;
    if (cur && cx.measureText(next).width > maxW) lines.push(p); else lines[lines.length - 1] = next;
  }
  const w = Math.max(...lines.map(l => cx.measureText(l).width)) + 24, hgt = lines.length * 17 + 12, x0 = xl, y0 = a.t + 10;
  cx.fillStyle = 'rgba(8,13,18,.93)'; rr(cx, x0, y0, w, hgt, 6); cx.fill();
  cx.strokeStyle = 'rgba(255,107,85,.7)'; cx.lineWidth = 1.2; rr(cx, x0 + .5, y0 + .5, w - 1, hgt - 1, 6); cx.stroke();
  lines.forEach((l, i) => { cx.fillStyle = i ? '#f1c9bf' : '#ffd9cf'; cx.fillText(l, x0 + 12, y0 + 19 + i * 17) });
  cx.fillStyle = 'rgba(255,107,85,.8)'; cx.fillRect(x0 + 6, y0 + hgt - 3, (w - 12) * (1 - age / RECAP_T), 2);
  cx.restore();
}

/* ---------- очередь событий хода ---------- */
const ANIMS = { q: [], cur: null, pos: new Map(), hidden: new Set(), floats: [], dying: [] };
const PACE = () => G.spec ? (G.pace || 1) : 1;
function playEvent(e) { ANIMS.q.push(e) }
function animBusy() { return !!ANIMS.cur || ANIMS.q.length > 0 }
function animTick() {
  const now = RT();
  if (ANIMS.cur && now >= ANIMS.cur.end) { ANIMS.cur.done && ANIMS.cur.done(); ANIMS.cur = null }
  while (!ANIMS.cur && ANIMS.q.length) startAnim(ANIMS.q.shift());
  if (ANIMS.cur && ANIMS.cur.step) ANIMS.cur.step(now);
  ANIMS.floats = ANIMS.floats.filter(f => now - f.t0 < 1.8);
  ANIMS.dying = ANIMS.dying.filter(d => now - d.t0 < .9);
  if (!animBusy() && G.pendingSnap) { const v = G.pendingSnap; G.pendingSnap = null; applySnapshot(v) }
}
function floatText(p, txt, col, big) { ANIMS.floats.push({ p: { ...p }, txt, col, big, t0: RT() }) }
const unitKind = id => { const u = G.units.find(x => x.id === id); return u ? u.k : null };
function startAnim(e) {
  const now = RT(), k = 1 / PACE(), center = H.center;
  if (e.e === 'move') {
    const u = G.units.find(x => x.id === e.id);
    const pts = e.path.map(center);
    if (!pts.length || !u) return;
    const smooth = pts.length > 2 ? chaikin(pts, 2) : pts;
    const seg = (e.retreat ? .17 : .14) * k, dur = Math.max(.06, seg * (pts.length - 1));
    const lens = [0]; for (let i = 1; i < smooth.length; i++) lens.push(lens[i - 1] + Math.hypot(smooth[i].x - smooth[i - 1].x, smooth[i].y - smooth[i - 1].y));
    const L = lens[lens.length - 1] || 1;
    let dust = 0;
    ANIMS.cur = {
      end: now + dur,
      step(t) {
        const d = clamp((t - now) / dur, 0, 1), ee = d < .5 ? 2 * d * d : 1 - Math.pow(-2 * d + 2, 2) / 2, want = ee * L;
        let i = 1; while (i < lens.length - 1 && lens[i] < want) i++;
        const r = (want - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1), a = smooth[i - 1], b = smooth[i] || a;
        const p = { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r };
        ANIMS.pos.set(e.id, p);
        /* пыль за техникой */
        if (UT[u.k].cls !== 'foot' && t - dust > .07) { dust = t; PLUMES.push({ x: p.x, y: p.y, t0: t, d: 1.6, pw: .32, seed: Math.random() * 99, dark: false }) }
      },
      done() { u.hex = e.path[e.path.length - 1]; ANIMS.pos.delete(e.id) }
    };
    if (e.retreat) floatText(pts[pts.length - 1], e.rem ? 'остатки отходят' : 'отход', '#ffd479', !!e.rem);
    Sound.gun({ ...pts[0], kind: 'mg' });
  } else if (e.e === 'fight') {
    const A = center(e.ah), D = center(e.dh), ka = unitKind(e.a), kd = unitKind(e.d);
    const heavyA = ka && (UT[ka].arm === 'hard' || ka === 'at'), heavyD = kd && (UT[kd].arm === 'hard' || kd === 'at');
    fxAdd({ k: 'tracer', a: A, b: D, t0: now, d: .9 * k, heavy: heavyA, seed: Math.random() * 99 });
    if (!e.amb && !(e.fire && !e.la)) fxAdd({ k: 'tracer', a: D, b: A, t0: now + .18 * k, d: .8 * k, heavy: heavyD, seed: Math.random() * 99, col: '255,190,120' });
    if (e.fire) { fxAdd({ k: 'tracer', a: A, b: D, t0: now + .35 * k, d: .8 * k, heavy: heavyA, seed: Math.random() * 99 }); floatText({ x: A.x, y: A.y - 4 }, 'обстрел', '#ffb070') }
    if (e.amb) floatText({ x: D.x, y: D.y - 4 }, 'засада!', '#ffd479', 1);
    if (e.probe) floatText({ x: A.x, y: A.y - 4 }, 'разведка боем', '#9fd3f5');
    const hits = 2 + Math.min(3, e.ld || 0);
    for (let i = 0; i < hits; i++) fxBoom(ringPt(D, 1.6, 4.2), heavyA ? .85 : .6, (.25 + i * .13) * k, { noMark: i > 2 });
    if (e.la) fxBoom(ringPt(A, 1.6, 4), heavyD ? .75 : .55, .5 * k, {});
    ANIMS.cur = { end: now + 1.05 * k, done() { floatText(D, (e.ld ? '−' + e.ld : e.su ? '' : 'без потерь') + (e.su ? (e.ld ? ' ' : '') + '⚡' + e.su : ''), e.ld ? '#ff8f80' : e.su ? '#ffb070' : '#cfe0ea', e.ld >= 3); if (e.la) floatText({ x: A.x, y: A.y - 2 }, '−' + e.la, '#ffb070'); upd(e.d, -e.ld); upd(e.a, -e.la) } };
    Sound.gun({ ...D, kind: heavyA ? 'tank' : 'mg' }); setTimeout(() => Sound.boom({ ...D, w: 40 }, true), 300 * k);
  } else if (e.e === 'shell') {
    const D = center(e.hex), A = e.from !== null && e.from !== undefined ? center(e.from) : null;
    if (A) fxAdd({ k: 'shell', a: A, b: D, t0: now, d: (e.k === 'mlrs' ? 1.1 : .85) * k, rocket: e.k === 'mlrs' });
    ANIMS.cur = { end: now + (A ? (e.k === 'mlrs' ? .78 : .58) : .1) * k };
    if (A) Sound.outgoing(A, e.k === 'mlrs');
  } else if (e.e === 'blast') {
    const D = center(e.hex);
    const pw = e.mine ? .6 : e.big ? 1.2 : .8;
    fxBoom(ringPt(D, .5, 2.5), pw, 0, {});
    fxBoom(ringPt(D, 2, 4.2), pw * .7, .1, {});
    if (e.big) for (let i = 0; i < 3; i++) fxBoom(ringPt(D, 1.5, 4.5), .7, .14 + i * .1, {});
    if (e.ld !== undefined) setTimeout(() => { floatText(D, e.ld ? '−' + e.ld : 'мимо', e.ld ? '#ff8f80' : '#cfe0ea', e.ld >= 3); upd(e.id, -e.ld) }, 250 * k);
    ANIMS.cur = { end: now + .5 * k };
    if (e.hex >= 0 && G.mapId && H.build(G.mapId).hexes[e.hex].t === 'city') addFire(e.hex);
    Sound.boom({ ...D, w: e.big ? 90 : 40 }, false);
  } else if (e.e === 'dead') {
    const u = G.units.find(x => x.id === e.id), p = center(e.hex);
    if (u) { ANIMS.dying.push({ u: { ...u }, p, t0: now }); ANIMS.hidden.add(e.id) }
    /* сдались, захвачены, влились в соседа — без взрыва и остова */
    const quiet = e.how === 'surrender' || e.how === 'captured' || e.how === 'merged';
    if (!quiet) { fxBoom(p, 1.4, .05, {}); fxBoom(ringPt(p, 1.5, 3.5), .8, .2, {}); addWreck(e.hex, e.k, e.side) }
    floatText({ x: p.x, y: p.y + 2 }, e.how === 'surrender' ? 'сдались' : e.how === 'captured' ? 'захвачен' : e.how === 'merged' ? 'влились' : 'уничтожен', e.how === 'merged' ? '#9fe0a8' : '#ff6b55', 1);
    ANIMS.cur = { end: now + .6 * k };
  } else if (e.e === 'capture') {
    const p = center(e.hex);
    fxAdd({ k: 'capture', hex: e.hex, t0: now, d: 1.6, col: e.side === N ? '108,195,255' : '255,110,90' });
    floatText(p, e.n + ' взят', '#ffe6a0', 1);
    ANIMS.cur = { end: now + .55 * k };
  } else if (e.e === 'air') {
    const p = center(e.hex), mine = G.spec ? e.side !== S : e.side === undefined || e.side === G.side;
    const dir = (e.side || G.side) === S ? -1 : 1;
    fxAdd({ k: 'plane', p, t0: now, d: 1.4 * k, dir, icon: e.kind === 'drop' ? 'jet' : 'jet', theme: mine ? 'own' : 'enemy' });
    if (e.kind === 'drop') { fxAdd({ k: 'drop', p, t0: now, d: 1.8 * k }); floatText(p, 'груз сброшен', '#9fe0a8') }
    if (e.kind === 'recon') floatText(p, 'авиаразведка', '#9fd3f5');
    ANIMS.cur = { end: now + 1 * k };
  } else if (e.e === 'aa') {
    /* ПВО работает по налёту: трассы и разрывы в воздухе; сбит — дымный след вниз */
    const A = center(e.hex), B = center(e.target);
    for (let i = 0; i < (e.down ? 5 : 3); i++) fxAdd({ k: 'tracer', a: A, b: { x: B.x + (Math.random() - .5) * 6, y: B.y - 6 - Math.random() * 4 }, t0: now + i * .1, d: .7, col: '200,230,255', seed: Math.random() * 99 });
    for (let i = 0; i < (e.down ? 8 : 5); i++) fxAdd({ k: 'flak', x: B.x + (Math.random() - .5) * 8, y: B.y - 5 - Math.random() * 5, t0: now + .2 + i * .08, d: 1.2, seed: Math.random() * 9 });
    if (e.down) { fxAdd({ k: 'downed', p: { x: B.x, y: B.y - 7 }, t0: now + .35, d: 1.6 * k, dir: Math.random() < .5 ? -1 : 1 }); floatText(B, 'штурмовик сбит', '#9fd3f5', 1) }
    else floatText({ x: B.x, y: B.y - 3 }, 'ПВО: удар слабее', '#9fd3f5');
    ANIMS.cur = { end: now + (e.down ? .9 : .5) * k };
  } else if (e.e === 'turn') {
    const mine = !G.spec && e.side === G.side;
    showBanner(`Ход ${e.turn + 1} · ${e.clock}${e.night ? ' · ночь' : ''}`, G.spec ? 'Ходит ' + SIDE_GEN[e.side] : mine ? 'Ваш ход' : 'Ход противника', mine, e.side);
    ANIMS.cur = { end: now + (mine ? .9 : .5) * k };
    if (mine) { Sound.radio('hq'); recapShow() }
  } else if (e.e === 'eng' || e.e === 'spawn' || e.e === 'replace') {
    const p = center(e.hex !== undefined ? e.hex : (G.units.find(x => x.id === e.id) || { hex: 0 }).hex);
    if (e.task === 'blow') fxBoom(p, 1.1, 0, {});
    floatText(p, { bridge: 'понтон', mine: 'мины', dig: 'окоп', clear: 'проход', blow: 'взрыв', fort: 'укрепления', obst: 'заграждения', ambush: 'засада', repair: 'мост восстановлен' }[e.task] || (e.e === 'replace' ? '+' + e.n : e.militia ? 'ополчение!' : 'прибыл'), '#ffe6a0');
    ANIMS.cur = { end: now + .25 * k };
  } else if (e.e === 'smoke') {
    floatText(center(e.hex), 'дым', '#d8dadc');
    if (!G.smoke.includes(e.hex)) G.smoke = G.smoke.concat(H.within(e.hex, 1));
    ANIMS.cur = { end: now + .25 * k };
  } else if (e.e === 'promote') {
    floatText(center(e.hex), e.lv >= 2 ? 'ветераны ★★' : 'обстреляны ★', '#f2c94c');
    ANIMS.cur = { end: now + .2 * k };
  } else if (e.e === 'counter') {
    floatText(center(e.hex), 'контрбатарея!', '#ffb070');
    ANIMS.cur = { end: now + .15 * k };
  }
}
function upd(id, d) { const u = G.units.find(x => x.id === id); if (u && d) u.str = Math.max(0, u.str + d) }

function drawFloats() {
  const now = RT();
  for (const f of ANIMS.floats) {
    const t = (now - f.t0) / 1.8, q = w2s(f.p), a = t < .1 ? t / .1 : 1 - Math.max(0, (t - .55) / .45);
    const y = q.y - 22 - (1 - Math.pow(1 - t, 3)) * 30, fs = f.big ? 17 : 14;
    cx.font = `800 ${fs}px system-ui,sans-serif`; cx.textAlign = 'center'; cx.lineJoin = 'round';
    cx.globalAlpha = clamp(a, 0, 1);
    cx.lineWidth = 4; cx.strokeStyle = 'rgba(0,0,0,.85)'; cx.strokeText(f.txt, q.x, y);
    cx.fillStyle = f.col; cx.fillText(f.txt, q.x, y);
    cx.globalAlpha = 1;
  }
}

/* ---------- следы боя: остовы и пожары ---------- */
const MARKS = { wrecks: [], fires: [] };
function marksReset() { MARKS.wrecks.length = 0; MARKS.fires.length = 0; fxReset() }
function addWreck(hex, k, side) { const c = H.center(hex); MARKS.wrecks.push({ x: c.x + (Math.random() - .5) * 3, y: c.y + (Math.random() - .5) * 2, k, side, turn: G.turn, seed: Math.random() * 9 }) }
function addFire(hex) { if (!MARKS.fires.some(f => f.hex === hex)) MARKS.fires.push({ hex, turn: G.turn, seed: Math.random() * 9 }) }
function drawWrecks() {
  const s = G.view.s;
  MARKS.wrecks = MARKS.wrecks.filter(w => G.turn - w.turn < 6);
  for (const w of MARKS.wrecks) {
    const q = w2s(w);
    if (!onScreen(q, 40)) continue;
    drawIcon(cx, unitIcon(w.k, w.side), q.x, q.y, clamp(s * 4, 16, 46), 'dead', w.side === S, .85 * clamp(1 - (G.turn - w.turn) / 6, .3, 1));
  }
}
function drawBurning() {
  MARKS.fires = MARKS.fires.filter(f => G.turn - f.turn < 3);
  for (const w of MARKS.wrecks) { const age = G.turn - w.turn; if (age < 2) drawFire(w, age < 1 ? .55 : .25, .7, w.seed) }
  for (const f of MARKS.fires) drawFire(H.center(f.hex), clamp(1 - (G.turn - f.turn) / 3, .2, 1), 1, f.seed);
}
/** дымовые завесы — плотные клубы над клетками */
function drawSmokeScreens() {
  const s = G.view.s, T = RT();
  for (const h of G.smoke || []) {
    const c = H.center(h), q = w2s(c);
    if (!onScreen(q, 100)) continue;
    for (let i = 0; i < 4; i++) {
      const a = T * .25 + i * 1.6 + h, R = Hex.R * s * (.62 + .1 * Math.sin(T * .6 + i));
      SmokeTex.drawFast(cx, (h + i) % 6, q.x + Math.cos(a) * Hex.R * s * .3, q.y + Math.sin(a * 1.2) * Hex.R * s * .22, R, .42, [212, 214, 216], (h + i) & 3, 1.25);
    }
  }
}

/* ---------- кадр ---------- */
function draw(dt) {
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (!G.mapId) { cx.fillStyle = '#04070a'; cx.fillRect(0, 0, CW, CH); return }
  /* первая выпечка карты — с заставкой: кадр с надписью, потом тяжёлая работа */
  if (!TER || TER_ID !== G.mapId) {
    const el = document.getElementById('loading');
    if (el && el.hidden) { el.hidden = false; cx.fillStyle = '#04070a'; cx.fillRect(0, 0, CW, CH); return }
    bakeTerrain(G.mapId); OVL = null; ovlKey = ''; FOG_EDGE = null; MINIC = null; miniKey = '';
    if (el) el.hidden = true;
  }
  ANIM += dt;
  animTick();
  drawBase();
  if (G.selRiv) drawRiverEdges(G.view.s);
  drawScorch();
  drawWrecks();
  /* туман-погода стелется по земле — под фишками и подписями, а не фильтром на весь экран */
  drawGroundWeather();
  drawCityLights();
  drawFog();
  drawSupplyOverlay();
  drawCmdSectors();
  drawFront();
  drawPontoons();
  drawMines();
  drawWorks();
  if (G.phase === 'deploy' && G.deploy) {
    const set = new Set(G.deploy);
    cx.beginPath(); for (const h of G.deploy) { const q = w2s(H.center(h)); if (onScreen(q, 40)) addHex(h, 1) } cx.fillStyle = 'rgba(242,179,61,.06)'; cx.fill();
    regionEdges(n => set.has(n), G.deploy); cx.strokeStyle = 'rgba(242,179,61,.75)'; cx.lineWidth = 2; cx.setLineDash([8, 5]); cx.stroke(); cx.setLineDash([]);
  }
  if (G.spawn) { cx.beginPath(); for (const h of G.spawn) addHex(h, .92); cx.fillStyle = 'rgba(111,209,141,.18)'; cx.fill(); cx.strokeStyle = 'rgba(111,209,141,.7)'; cx.lineWidth = 1.4; cx.stroke() }
  drawPoints();
  drawAirMode();
  drawSelection();
  if (G.hover >= 0 && !animBusy()) { hexPath(G.hover, 1); cx.strokeStyle = 'rgba(255,255,255,.55)'; cx.lineWidth = 1.5; cx.stroke() }
  drawUnits();
  drawPlan();
  drawRecap();
  /* дыма много — в половинном разрешении (render/fx.js), иначе прямо на экран */
  if (smokeBegin()) { try { drawPlumes(); drawSmokeScreens() } finally { smokeEnd() } }
  else { drawPlumes(); drawSmokeScreens() }
  drawBurning();
  drawFxList();
  drawFloats();
  drawWeather(dt);
  drawScaleBar();
  drawMini();
  applyShake(dt);
}

/* ---------- мини-карта ---------- */
function miniRect() {
  const a = mapArea();
  let h = CW < 700 ? clamp((a.b - a.t) * .22, 70, 120) : clamp((a.b - a.t) * .28, 96, 168);
  let w = h * H.WW / H.WH;
  const maxW = Math.min(260, (a.r - a.l) * .32);
  if (w > maxW) { w = maxW; h = w * H.WH / H.WW }
  return { x: a.l + 12, y: a.t + 10, w, h };
}
/* Мини-карта печётся в свой холст и перерисовывается, только когда что-то
   на ней поменялось (снимок, переход части, размер); в кадре — копирование
   и рамка видимой области. Раньше каждый кадр заново рисовались все клетки
   тумана, территория, точки и части. */
let MINIC = null, miniKey = '';
function drawMini() {
  if (!MINI || !G.roomId) return;
  const m = miniRect(), k = m.w / H.WW;
  let uh = 0;
  for (const u of G.units) uh = (uh * 31 + u.hex * 7 + u.id + (u.side === S ? 3 : 0)) | 0;
  const key = [G.mapId, Math.round(m.w), Math.round(m.h), DPR, G.visV, G.spec ? 1 : 0, G.side, G.phase, uh, G.terrStr.length].join('|');
  if (key !== miniKey || !MINIC) {
    miniKey = key;
    const w = Math.max(1, Math.round(m.w * DPR)), h = Math.max(1, Math.round(m.h * DPR));
    if (!MINIC || MINIC.width !== w || MINIC.height !== h) { MINIC = document.createElement('canvas'); MINIC.width = w; MINIC.height = h }
    const g = MINIC.getContext('2d'), kk = w / H.WW;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
    g.globalAlpha = .92; g.imageSmoothingQuality = 'high'; g.drawImage(MINI, 0, 0, w, h); g.globalAlpha = 1;
    if (G.vis && !G.spec && G.phase === 'battle') { g.fillStyle = 'rgba(4,8,12,.42)'; g.beginPath(); for (let hx = 0; hx < H.NH; hx++) if (!G.vis.has(hx)) { const c = H.center(hx); g.rect((c.x - Hex.HW / 2) * kk, (c.y - Hex.R) * kk, Hex.HW * kk + .6, Hex.VS * kk + .8) } g.fill() }
    const F = buildFront();
    if (F) {
      const own = G.spec ? 1 : G.side === N ? 1 : 2;
      g.save(); g.scale(kk, kk);
      g.fillStyle = 'rgba(255,91,71,.16)'; g.fill(F.fill[3 - own]);
      g.strokeStyle = '#f2b33d'; g.lineWidth = 1.6 * DPR / kk; g.stroke(F.line);
      g.restore();
    }
    const d = DPR;
    for (const p of G.pts) { const c = H.center(p.hex), z = (p.city ? 5 : 3.5) * d; g.fillStyle = !p.owner ? '#ccc' : p.owner === N ? '#6cc3ff' : '#ff8a72'; g.strokeStyle = '#000'; g.lineWidth = d; g.fillRect(c.x * kk - z / 2, c.y * kk - z / 2, z, z); g.strokeRect(c.x * kk - z / 2, c.y * kk - z / 2, z, z) }
    for (const u of G.units) { const c = H.center(u.hex); g.fillStyle = (G.spec ? u.side === S : u.side !== G.side) ? '#ff5b47' : '#bfe6ff'; g.fillRect(c.x * kk - 1.5 * d, c.y * kk - 1.5 * d, 3 * d, 3 * d) }
  }
  cx.save();
  cx.fillStyle = 'rgba(0,0,0,.5)'; rr(cx, m.x - 4, m.y - 4, m.w + 10, m.h + 10, 8); cx.fill();
  cx.fillStyle = 'rgba(8,13,18,.95)'; rr(cx, m.x - 5, m.y - 5, m.w + 10, m.h + 10, 8); cx.fill();
  cx.strokeStyle = 'rgba(120,150,170,.35)'; cx.lineWidth = 1; rr(cx, m.x - 4.5, m.y - 4.5, m.w + 9, m.h + 9, 8); cx.stroke();
  cx.drawImage(MINIC, m.x, m.y, m.w, m.h);
  const a = s2w({ x: 0, y: 0 }), b = s2w({ x: CW, y: CH });
  cx.beginPath(); cx.rect(m.x, m.y, m.w, m.h); cx.clip();
  cx.strokeStyle = 'rgba(255,255,255,.85)'; cx.lineWidth = 1.2; cx.strokeRect(m.x + a.x * k, m.y + a.y * k, (b.x - a.x) * k, (b.y - a.y) * k);
  cx.restore();
}
