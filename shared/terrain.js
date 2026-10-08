'use strict';
/* ============================================================
   МЕСТНОСТЬ по описанию карты (shared/maps.js): рельеф, лес,
   дороги, реки, мосты, озёра, болота, хребты, большие города.
   Terrain.get(id) — местность карты (строится один раз и
   кэшируется): одна и та же на сервере и в браузере.

   Сетка 1 км — флаги клетки:
     F лес · R дорога · W река · B мост · C застройка ·
     L озеро · M болото · K горы
   ============================================================ */
(function (g) {
  const node = typeof module !== 'undefined' && module.exports;
  const W = node ? require('./world') : g;
  const { MAPS } = node ? require('./maps') : g;
  const { WW, WH } = W;

  /* ---------- шум ---------- */
  function h2(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, o) {
    let t = 0, a = .5, f = 1, n = 0;
    for (let i = 0; i < o; i++) { t += a * vnoise(x * f, y * f, s + i * 31); n += a; a *= .5; f *= 2.03 }
    return t / n;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }
  function bendy(a, b, n, amp, seed) {
    const L = dist(a, b) || 1, nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L, pts = [];
    for (let q = 0; q <= n; q++) {
      const t = q / n, j = (fbm(t * 4, seed, seed, 4) - .5) * 2 * amp * Math.sin(Math.PI * t);
      pts.push({ x: a.x + (b.x - a.x) * t + nx * j, y: a.y + (b.y - a.y) * t + ny * j });
    }
    return pts;
  }
  function riverPath(x0, y0, tx, ty, s) {
    const pts = [{ x: x0, y: y0 }];
    let x = x0, y = y0;
    for (let i = 0; i < 500; i++) {
      const a = Math.atan2(ty - y, tx - x) + (fbm(x * .03, y * .03, s, 4) - .5) * 2.1;
      x += Math.cos(a) * 1.6; y += Math.sin(a) * 1.6;
      pts.push({ x, y });
      if (Math.hypot(tx - x, ty - y) < 3 || x < -4 || x > WW + 4) break;
    }
    return pts;
  }
  function segX(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
  }

  const F = 1, R = 2, Wt = 4, B = 8, C = 16, L = 32, M = 64, K = 128;
  const METERS = 420, FOREST_T0 = .61;

  /** местность одной карты */
  function make(id) {
    const def = MAPS[id] || MAPS.valley, sd = def.seed || 0;
    const HILLS = def.hills || [], FT = (def.forest && def.forest.thr) || FOREST_T0;
    const ridges = (def.ridges || []).map(r => ({ w: r.w, pts: r.pts.map(([x, y]) => ({ x, y })) }));
    /** близость к хребту 0..1 */
    function ridgeK(x, y) {
      let k = 0;
      for (const r of ridges) for (let i = 1; i < r.pts.length; i++) {
        const d = segDist({ x, y }, r.pts[i - 1], r.pts[i]) + (fbm(x * .08, y * .08, 91 + sd, 3) - .5) * r.w * .8;
        if (d < r.w) k = Math.max(k, 1 - d / r.w);
      }
      return k;
    }
    function height(x, y) {
      let h = fbm(x * .018, y * .018, 7 + sd, 5);
      for (const b of HILLS) { const d2 = ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r); if (d2 < 9) h += b.a * Math.exp(-d2) }
      if (ridges.length) h += ridgeK(x, y) * .55;
      return h;
    }
    const lakeK = (x, y) => { let k = 0; for (const l of def.lakes || []) { const d = Math.hypot(x - l.x, y - l.y) + (fbm(x * .1, y * .1, 77 + sd, 3) - .5) * l.r * .5; if (d < l.r) k = Math.max(k, 1 - d / l.r) } return k };
    const marshK = (x, y) => { let k = 0; for (const l of def.marsh || []) { const d = Math.hypot(x - l.x, y - l.y) + (fbm(x * .07, y * .07, 55 + sd, 3) - .5) * l.r * .7; if (d < l.r) k = Math.max(k, 1 - d / l.r) } return k };
    const forestV = (x, y, H) => fbm(x * .055, y * .055, 31 + sd, 3) + (1 - y / WH) * .05 + (H === undefined ? height(x, y) : H) * .12 - (ridges.length ? ridgeK(x, y) * .25 : 0);
    const isForest = (x, y) => forestV(x, y) > FT;

    let ROADS = null, RIVERS = null, BRIDGES = null, FINE = null, HGT = null;
    function roads() {
      if (ROADS) return ROADS;
      ROADS = [];
      for (const [ia, ib] of def.links || []) {
        const a = def.points[ia], b = def.points[ib];
        if (!a || !b) continue;
        ROADS.push({ main: !!(a.city && b.city), pts: bendy(a, b, Math.max(8, Math.round(dist(a, b) / 6)), 7, ia * 13 + ib + sd) });
      }
      (def.roads || []).forEach((r, i) => ROADS.push({ main: true, pts: bendy({ x: r[0][0], y: r[0][1] }, { x: r[1][0], y: r[1][1] }, 26, 8, 3 + i * 2 + sd) }));
      return ROADS;
    }
    function rivers() {
      if (RIVERS) return RIVERS;
      return (RIVERS = (def.rivers || []).map(r => ({ n: r.n, w: r.w, pts: riverPath(r.from[0], r.from[1], r.to[0], r.to[1], r.seed) })));
    }
    function bridges() {
      if (BRIDGES) return BRIDGES;
      BRIDGES = [];
      for (const rv of rivers()) for (const rd of roads()) for (let i = 1; i < rd.pts.length; i++) for (let j = 1; j < rv.pts.length; j++) {
        const p = segX(rd.pts[i - 1], rd.pts[i], rv.pts[j - 1], rv.pts[j]);
        if (!p || p.x < 0 || p.x > WW || p.y < 0 || p.y > WH || BRIDGES.some(b => dist(b, p) < 3)) continue;
        BRIDGES.push({ id: 'b' + BRIDGES.length, x: p.x, y: p.y, river: rv.n, main: rd.main });
      }
      return BRIDGES;
    }
    function stamp(grid, pts, r, bit) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(dist(a, b) / .25));
        for (let q = 0; q <= n; q++) {
          const x = a.x + (b.x - a.x) * q / n, y = a.y + (b.y - a.y) * q / n;
          for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
            if (cx < 0 || cy < 0 || cx >= WW || cy >= WH) continue;
            if (Math.hypot(cx + .5 - x, cy + .5 - y) <= r) grid[cy * WW + cx] |= bit;
          }
        }
      }
    }
    function fine() {
      if (FINE) return FINE;
      const gr = new Uint8Array(WW * WH);
      for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
        const k = y * WW + x, px = x + .5, py = y + .5;
        if (lakeK(px, py) > 0) { gr[k] |= L; continue }
        if (isForest(px, py)) gr[k] |= F;
        if (marshK(px, py) > .05) gr[k] |= M;
        if (ridges.length && ridgeK(px, py) > .35) gr[k] |= K;
      }
      for (const r of roads()) stamp(gr, r.pts, .8, R);
      for (const r of rivers()) stamp(gr, r.pts, r.w * .5 + .45, Wt);
      for (const b of bridges()) stamp(gr, [b, b], 1.6, B);
      for (const p of def.points) if (p.city) stamp(gr, [p, p], p.w * 2.2 + 1, C);
      for (const c of def.cities || []) stamp(gr, [c, c], c.r, C);
      for (let i = 0; i < gr.length; i++) {
        if (gr[i] & (R | B)) gr[i] &= ~(F | M);
        if (gr[i] & C) gr[i] &= ~(F | M | K);
        if (gr[i] & L) gr[i] &= ~(R | C);
      }
      return (FINE = gr);
    }
    function flagsAt(x, y) {
      const cx = Math.floor(x), cy = Math.floor(y);
      if (cx < 0 || cy < 0 || cx >= WW || cy >= WH) return 0;
      return fine()[cy * WW + cx];
    }
    function heights() {
      if (HGT) return HGT;
      HGT = new Float32Array(WW * WH);
      for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) HGT[y * WW + x] = height(x + .5, y + .5) * METERS;
      return HGT;
    }
    function heightAt(x, y) {
      const H = heights();
      x = Math.max(.5, Math.min(WW - 1.5, x - .5)); y = Math.max(.5, Math.min(WH - 1.5, y - .5));
      const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, k = yi * WW + xi;
      return (H[k] * (1 - fx) + H[k + 1] * fx) * (1 - fy) + (H[k + WW] * (1 - fx) + H[k + WW + 1] * fx) * fy;
    }
    return { id, def, HILLS, FOREST_T: FT, height, forestV, isForest, lakeK, marshK, ridgeK, roads, rivers, bridges, fine, flagsAt, heightAt, h2 };
  }

  const CACHE = {};
  function get(id) { return CACHE[id] || (CACHE[id] = make(id)) }

  const api = { get, h2, fbm, FLAG: { F, R, W: Wt, B, C, L, M, K }, METERS };
  if (node) module.exports = api;
  else g.Terrain = api;
})(typeof window !== 'undefined' ? window : globalThis);
