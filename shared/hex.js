'use strict';
/* ============================================================
   ГЕКСЫ: геометрия и гексовая карта поверх местности.
   Гексы «остриём вверх», строки со сдвигом (odd-r), радиус R км.
   Карта строится из shared/terrain.js детерминированно — сервер
   и клиент получают одно и то же:
     t      тип клетки: open · forest · hill · city · marsh · mount · lake
     h      высота центра, м;  pt — точка (город/узел) в клетке
     road   в клетке есть дорога
   Границы клеток (edge[id*6+d]): RIV — река, BR — мост (дорога
   через реку), RD — дорога соединяет соседей.
   Направления: 0 В, 1 СВ, 2 СЗ, 3 З, 4 ЮЗ, 5 ЮВ; противоположное — (d+3)%6.
   ============================================================ */
(function (g) {
  const node = typeof module !== 'undefined' && module.exports;
  const W = node ? require('./world') : g;
  const TerrainM = node ? require('./terrain') : g.Terrain;
  const { WW, WH } = W;

  const R = 5, HW = Math.sqrt(3) * R, VS = 1.5 * R;
  const COLS = Math.floor((WW - HW / 2) / HW), ROWS = Math.floor((WH - R) / VS) + 1;
  const NH = COLS * ROWS;
  const RIV = 1, BR = 2, RD = 4;
  const ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];
  const EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];

  const colOf = id => id % COLS, rowOf = id => Math.floor(id / COLS);
  function center(id) {
    const q = id % COLS, r = (id - q) / COLS;
    return { x: HW * (q + .5 + (r & 1) * .5), y: R + VS * r };
  }
  /** сосед в направлении d или -1 */
  function nb(id, d) {
    const q = id % COLS, r = (id - q) / COLS, o = (r & 1 ? ODD : EVEN)[d];
    const nq = q + o[0], nr = r + o[1];
    if (nq < 0 || nr < 0 || nq >= COLS || nr >= ROWS) return -1;
    return nr * COLS + nq;
  }
  function neighbors(id) { const a = []; for (let d = 0; d < 6; d++) { const n = nb(id, d); if (n >= 0) a.push(n) } return a }
  function dirTo(a, b) { for (let d = 0; d < 6; d++) if (nb(a, d) === b) return d; return -1 }
  function cube(id) { const q = id % COLS, r = (id - q) / COLS; const x = q - (r - (r & 1)) / 2; return [x, r, -x - r] }
  function hexDist(a, b) { const A = cube(a), B = cube(b); return Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2])) }
  /** клетка под точкой карты (км) */
  function hexAt(x, y) {
    const r0 = Math.round((y - R) / VS);
    let best = -1, bd = 1e9;
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r >= ROWS) continue;
      const q0 = Math.round(x / HW - .5 - (r & 1) * .5);
      for (let q = q0 - 1; q <= q0 + 1; q++) {
        if (q < 0 || q >= COLS) continue;
        const id = r * COLS + q, c = center(id), d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; best = id }
      }
    }
    return bd <= R * R * 1.05 ? best : -1;
  }
  /** все клетки в радиусе n */
  function within(id, n) {
    const out = [], c = center(id);
    const rr = Math.ceil(n * VS / VS) + 1;
    const r0 = rowOf(id);
    for (let r = Math.max(0, r0 - n); r <= Math.min(ROWS - 1, r0 + n); r++) {
      for (let q = 0; q < COLS; q++) {
        const h = r * COLS + q;
        if (Math.abs(center(h).x - c.x) > (n + 1) * HW) continue;
        if (hexDist(id, h) <= n) out.push(h);
      }
    }
    return out;
  }
  /** вершины шестиугольника (для отрисовки) */
  function corners(id, k) {
    const c = center(id), out = [], rr = R * (k || 1);
    for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); out.push({ x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) }) }
    return out;
  }
  /** две вершины ребра в направлении d (для рек и дорог на границе) */
  function edgeEnds(id, d) {
    const cs = corners(id);
    /* вершины i: угол 60i−30; ребро в направлении d (угол −60d) — между вершинами */
    const map = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
    const [a, b] = map[d];
    return [cs[a], cs[b]];
  }

  /* ---------- построение карты ---------- */
  const MAPC = {};
  /** гексовая карта для местности карты id (Terrain.get(id)) */
  function build(id) {
    id = id || 'valley';
    if (MAPC[id]) return MAPC[id];
    const Terrain = TerrainM.get(id), POINT_DEF = Terrain.def.points;
    const F = TerrainM.FLAG, hexes = new Array(NH), edge = new Uint8Array(NH * 6);
    const hs = [];
    for (let id = 0; id < NH; id++) {
      const c = center(id);
      let forest = 0, road = 0, city = 0, lake = 0, marsh = 0, mount = 0;
      const pts = [c];
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; pts.push({ x: c.x + Math.cos(a) * R * .55, y: c.y + Math.sin(a) * R * .55 }) }
      for (const p of pts) {
        const f = Terrain.flagsAt(p.x, p.y);
        if (f & F.F) forest++;
        if (f & F.R) road++;
        if (f & F.C) city++;
        if (f & F.L) lake++;
        if (f & F.M) marsh++;
        if (f & F.K) mount++;
      }
      const h = Terrain.heightAt(c.x, c.y);
      hs.push(h);
      hexes[id] = { id, x: c.x, y: c.y, h, forest: forest / pts.length, road: road >= 2 || (Terrain.flagsAt(c.x, c.y) & F.R) ? 1 : 0, city: city >= 4, pt: null,
        lake: lake >= 4, marsh: marsh >= 4, mount: mount >= 4 };
    }
    const sorted = hs.slice().sort((a, b) => a - b), thr = sorted[Math.floor(sorted.length * .86)];
    for (const p of POINT_DEF) { const id = hexAt(p.x, p.y); if (id >= 0) { hexes[id].pt = p.id; hexes[id].city = !!p.city || hexes[id].city; hexes[id].lake = hexes[id].mount = hexes[id].marsh = false } }
    for (const hx of hexes) {
      const hill = hx.h > thr || Terrain.HILLS.some(b => Math.hypot(b.x - hx.x, b.y - hx.y) < b.r * .7);
      hx.t = hx.lake ? 'lake' : hx.city ? 'city' : hx.mount ? 'mount' : hx.marsh ? 'marsh' : hill ? 'hill' : hx.forest >= .5 ? 'forest' : 'open';
    }
    /* границы-реки — выборка по отрезку между центрами */
    for (let id = 0; id < NH; id++) for (let d = 0; d < 3; d++) {
      const n = nb(id, d);
      if (n < 0) continue;
      const a = hexes[id], b = hexes[n];
      let water = 0;
      for (let i = 1; i < 12; i++) {
        const t = i / 12, f = Terrain.flagsAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        if ((f & F.W) || (f & F.B)) water++;
      }
      if (water) { edge[id * 6 + d] |= RIV; edge[n * 6 + (d + 3) % 6] |= RIV }
    }
    /* дороги — по линиям дорог: соседние клетки вдоль дороги соединены; через реку — мост */
    for (const rd of Terrain.roads()) {
      let prev = -1;
      for (let i = 1; i < rd.pts.length; i++) {
        const a = rd.pts[i - 1], b = rd.pts[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 1));
        for (let q = 0; q <= n; q++) {
          const id = hexAt(a.x + (b.x - a.x) * q / n, a.y + (b.y - a.y) * q / n);
          if (id < 0 || id === prev) continue;
          hexes[id].road = 1;
          if (prev >= 0) {
            const d = dirTo(prev, id);
            if (d >= 0) {
              let e = RD | ((edge[prev * 6 + d] & RIV) ? BR : 0);
              edge[prev * 6 + d] |= e; edge[id * 6 + (d + 3) % 6] |= e;
            }
          }
          prev = id;
        }
      }
    }
    return (MAPC[id] = { id, hexes, edge, COLS, ROWS, NH, R, def: Terrain.def });
  }
  /** список мостов: пары клеток с мостом (ключ «меньший-больший») */
  const BRL = {};
  function bridgeList(id) {
    id = id || 'valley';
    if (BRL[id]) return BRL[id];
    const m = build(id), out = (BRL[id] = []);
    for (let id = 0; id < NH; id++) for (let d = 0; d < 3; d++) {
      const n = nb(id, d);
      if (n >= 0 && (m.edge[id * 6 + d] & BR)) { const a = m.hexes[id], b = m.hexes[n]; out.push({ key: Math.min(id, n) + '-' + Math.max(id, n), a: id, b: n, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) }
    }
    return out;
  }
  const edgeKey = (a, b) => Math.min(a, b) + '-' + Math.max(a, b);

  const api = { R, HW, VS, COLS, ROWS, NH, RIV, BR, RD, center, nb, neighbors, dirTo, hexDist, hexAt, within, corners, edgeEnds, build, bridgeList, edgeKey, colOf, rowOf };
  if (node) module.exports = api;
  else g.Hex = api;
})(typeof window !== 'undefined' ? window : globalThis);
