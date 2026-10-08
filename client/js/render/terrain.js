'use strict';
/* ============================================================
   ТОПООСНОВА КАРТЫ (клиент)
   ------------------------------------------------------------
   Местность печётся один раз на карту в offscreen-холст с высоким
   разрешением (TPX пикселей на км — вчетверо больше прежнего), чтобы
   на рабочем масштабе карта не «мылилась».

   Дорогие функции местности (рельеф, лес, озёра, хребты) считаются
   на грубой сетке 0,5 км и интерполируются; поверх — мелкий шум
   (кроны леса, борозды полей, камни), поэтому края чёткие, а
   выпечка не дольше прежней.

   Слои подложки:
     поля      — лоскуты с межами, у части — борозды;
     лес       — кроны с тенью по свету, тёмная опушка;
     болото    — окна воды и штриховка камыша;
     хребты    — скалы и осыпи;
     озёра     — глубина и светлая кромка берега;
     рельеф    — отмывка по склонам и горизонтали через 20 м
                 (каждая пятая — утолщённая);
     застройка — кварталы с улицами, дома с тенью, хутора.
   Реки, дороги, мосты и сетка гексов рисуются вектором поверх
   (render/base.js) — они остаются резкими на любом масштабе.
   ============================================================ */

const TPX = 4;
let TER = null, TER_ID = null, MINI = null, TREES = null;
/* TER_MIP — уменьшенные копии топоосновы: на отдалении рисуем из подходящей,
   а не масштабируем 1200×1760 каждый кадр. TREE_GRID — деревья по клеткам
   10×10 км, чтобы не перебирать все 60–70 тысяч ради видимых трёх. */
let TER_MIP = [], TREE_GRID = null;
const TG_CELL = 10, TG_W = Math.ceil(WW / TG_CELL), TG_H = Math.ceil(WH / TG_CELL);

function bakeTerrain(id) {
  const T = Terrain.get(id), def = T.def, sd = def.seed || 0;
  const fbm = Terrain.fbm, h2 = Terrain.h2, M = Terrain.METERS;
  const FT = T.FOREST_T;
  const hasLake = (def.lakes || []).length > 0, hasMarsh = (def.marsh || []).length > 0, hasRidge = (def.ridges || []).length > 0;
  const steppe = !!(def.forest && def.forest.thr > .7);

  /* ---------- грубая сетка: 2 узла на км ---------- */
  const CP = 2, cw = WW * CP + 2, ch = WH * CP + 2;
  const cH = new Float32Array(cw * ch), cF = new Float32Array(cw * ch);
  const cL = hasLake ? new Float32Array(cw * ch) : null, cM = hasMarsh ? new Float32Array(cw * ch) : null, cR = hasRidge ? new Float32Array(cw * ch) : null;
  for (let j = 0; j < ch; j++) {
    const y = j / CP;
    for (let i = 0; i < cw; i++) {
      const x = i / CP, k = j * cw + i;
      const H = T.height(x, y), rk = hasRidge ? T.ridgeK(x, y) : 0;
      cH[k] = H;
      cF[k] = fbm(x * .055, y * .055, 31 + sd, 3) + (1 - y / WH) * .05 + H * .12 - rk * .25;
      if (cL) cL[k] = T.lakeK(x, y);
      if (cM) cM[k] = T.marshK(x, y);
      if (cR) cR[k] = rk;
    }
  }
  const bil = (A, x, y) => {
    let fx = x * CP, fy = y * CP;
    if (fx < 0) fx = 0; if (fy < 0) fy = 0; if (fx > cw - 1.001) fx = cw - 1.001; if (fy > ch - 1.001) fy = ch - 1.001;
    const xi = fx | 0, yi = fy | 0, tx = fx - xi, ty = fy - yi, k = yi * cw + xi;
    return (A[k] * (1 - tx) + A[k + 1] * tx) * (1 - ty) + (A[k + cw] * (1 - tx) + A[k + cw + 1] * tx) * ty;
  };
  const vn = (x, y, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  /* ---------- палитры ---------- */
  const FLD = steppe
    ? [[104, 96, 60], [112, 102, 64], [96, 90, 56], [120, 108, 68], [106, 98, 62], [92, 86, 52], [124, 112, 74]]
    : [[74, 84, 52], [84, 90, 56], [66, 78, 48], [92, 92, 58], [80, 88, 52], [70, 78, 46], [90, 84, 54], [78, 90, 60]];
  const FOR = steppe ? [40, 58, 36] : [32, 52, 34];

  const w = WW * TPX, h = WH * TPX;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), D = img.data;
  const px = 1 / TPX;
  for (let j = 0; j < h; j++) {
    const y = (j + .5) * px;
    for (let i = 0; i < w; i++) {
      const x = (i + .5) * px, o = (j * w + i) * 4;
      let r, gg, b;
      const H = bil(cH, x, y);
      const lk = cL ? bil(cL, x, y) : 0;
      /* отмывка рельефа: свет с северо-запада */
      const sh = Math.max(.62, Math.min(1.4, 1 + ((bil(cH, x - .5, y) - bil(cH, x + .5, y)) + (bil(cH, x, y - .5) - bil(cH, x, y + .5))) * 14));
      const el = .9 + H * .32;
      let contour = 0, inForest = false;
      if (lk > 0) {
        const dp = Math.min(1, lk * 2.4), rip = (vn(x * 3.2, y * 1.1, 41) - .5) * 6;
        r = 22 - dp * 9 + rip * .4; gg = 56 - dp * 18 + rip; b = 74 - dp * 16 + rip;
        if (lk < .05) { r = 82; gg = 88; b = 72 }                         /* светлая кромка берега */
        else if (lk < .1) { r = r * .6 + 40; gg = gg * .6 + 52; b = b * .6 + 52 }
      } else {
        const fv = bil(cF, x, y) + (vn(x * 1.4, y * 1.4, 17) - .5) * .045 + (vn(x * 4.2, y * 4.2, 19) - .5) * .018;
        if (fv > FT) {
          /* лес: кроны с тенью по свету */
          inForest = true;
          const dn = Math.min(1, (fv - FT) * 6);
          const cr = vn(x * 2.6, y * 2.6, 23), lt = vn(x * 2.6 - .22, y * 2.6 - .22, 23) - vn(x * 2.6 + .22, y * 2.6 + .22, 23);
          const fine = vn(x * 7, y * 7, 29);
          const k = (.74 + .42 * cr + lt * .9) * (.9 + .2 * fine) * (1 - dn * .18);
          r = FOR[0] * k; gg = FOR[1] * k; b = FOR[2] * k;
          if (fv < FT + .012) { r *= .62; gg *= .66; b *= .62 }           /* опушка */
          else if (h2(i, j, 33) < .012) { r += 20; gg += 22; b += 10 }    /* блики на кронах */
        } else {
          /* поля: лоскуты на повёрнутой сетке, межи, борозды */
          const u = x * .95 + y * .31, v = -x * .31 + y * .95;
          const cu = Math.floor(u / 2.3), cv = Math.floor(v / 1.7);
          const hc = h2(cu, cv, 5 + sd);
          const f = FLD[(hc * FLD.length) | 0];
          r = f[0]; gg = f[1]; b = f[2];
          const du = (u - cu * 2.3), dv = (v - cv * 1.7);
          if (hc > .45) { const st = Math.sin((hc > .7 ? u : v) * 22) * .045; r *= 1 + st; gg *= 1 + st; b *= 1 + st }
          const nz = (vn(x * 3, y * 3, 13) - .5) * .12;
          r *= 1 + nz; gg *= 1 + nz; b *= 1 + nz;
          /* межа / лесополоса — мягкий край, без «лесенки» */
          const e = Math.min(du, dv), hk = e < .12 ? 1 : e < .3 ? 1 - (e - .12) / .18 : 0;
          if (hk) { r *= 1 - .2 * hk; gg *= 1 - .16 * hk; b *= 1 - .22 * hk }
          if (fv > FT - .03 && !steppe) { const t = (fv - FT + .03) / .03 * .45; r = r * (1 - t) + 36 * t; gg = gg * (1 - t) + 50 * t; b = b * (1 - t) + 32 * t }
        }
        const mk = cM ? bil(cM, x, y) : 0;
        if (mk > .05) {
          const t = Math.min(1, (mk - .05) * 3);
          r = r * (1 - t * .55) + 40 * t * .55; gg = gg * (1 - t * .55) + 56 * t * .55; b = b * (1 - t * .55) + 46 * t * .55;
          const pool = vn(x * 1.9, y * 1.9, 61);
          if (pool > .64 && t > .4) { r = 26; gg = 52; b = 60; if (pool < .67) { r = 70; gg = 84; b = 70 } }
          else if (((x * 5 + y * 1.6) % 1) < .14 && vn(x * 3, y * 3, 63) > .5) { r *= .72; gg *= .8; b *= .72 }  /* камыш */
        }
        const rk = cR ? bil(cR, x, y) : 0;
        if (rk > .25) {
          const t = Math.min(1, (rk - .25) * 2.2), sc = (h2(i, j, 71) - .5) * 26 + (vn(x * 5, y * 5, 73) - .5) * 30;
          r = r * (1 - t) + (98 + sc) * t; gg = gg * (1 - t) + (92 + sc) * t; b = b * (1 - t) + (82 + sc) * t;
          if (rk > .82) { r += 26; gg += 26; b += 28 }
        }
        /* горизонтали через 20 м, каждая пятая толще */
        const hm = H * M, hr = bil(cH, x + px, y) * M, hd = bil(cH, x, y + px) * M;
        const l0 = Math.floor(hm / 20);
        if (l0 !== Math.floor(hr / 20) || l0 !== Math.floor(hd / 20)) contour = (Math.max(l0, Math.floor(hr / 20), Math.floor(hd / 20)) % 5 === 0) ? 2 : 1;
      }
      let k = sh * el;
      r *= k; gg *= k; b *= k;
      if (contour) {
        const m = contour === 2 ? (inForest ? .8 : .7) : (inForest ? .92 : .85);
        r = r * m + (contour === 2 ? 14 : 8); gg = gg * m + (contour === 2 ? 8 : 5); b = b * m;
      }
      D[o] = r; D[o + 1] = gg; D[o + 2] = b; D[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  /* ---------- застройка ---------- */
  g.save();
  g.scale(TPX, TPX);
  const rnd = mulberry2(77 + sd);
  const forestAt = (x, y) => bil(cF, x, y) > FT;
  const lakeAt = (x, y) => cL && bil(cL, x, y) > 0;
  /** дом с тенью: x, y, ширина, глубина, угол */
  const house = (x, y, bw, bh, a, tone) => {
    g.save(); g.translate(x, y); g.rotate(a);
    g.fillStyle = 'rgba(8,10,8,.55)'; g.fillRect(-bw / 2 + .08, -bh / 2 + .1, bw, bh);
    g.fillStyle = tone; g.fillRect(-bw / 2, -bh / 2, bw, bh);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(-bw / 2, -bh / 2, bw, bh * .42);
    g.restore();
  };
  const TONES = ['#77746a', '#6c6a62', '#837c6c', '#7a6658', '#8a7f6a', '#686d6a', '#8c6f5c'];
  /** город: кварталы по сетке под углом a, между ними улицы; к окраинам кварталы мельче и реже */
  const town = (cx0, cy0, R, dense) => {
    const a = rnd() * Math.PI, ca = Math.cos(a), sa = Math.sin(a), st = dense ? .8 : .95;
    const gr = g.createRadialGradient(cx0, cy0, 0, cx0, cy0, R * 1.08);
    gr.addColorStop(0, 'rgba(70,68,62,.9)'); gr.addColorStop(.8, 'rgba(66,64,58,.6)'); gr.addColorStop(1, 'rgba(66,64,58,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(cx0, cy0, R * 1.08, 0, 7); g.fill();
    const n = Math.ceil(R / st) + 1;
    g.save(); g.translate(cx0, cy0); g.rotate(a);
    for (let iu = -n; iu <= n; iu++) for (let iv = -n; iv <= n; iv++) {
      const bx = iu * st, by = iv * st, wx = cx0 + bx * ca - by * sa, wy = cy0 + bx * sa + by * ca;
      const d = Math.hypot(bx, by) / R + (rnd() - .5) * .3;
      if (d > 1 || lakeAt(wx, wy)) continue;
      if (rnd() < d * .45) continue;
      const m = st * (.12 + d * .08), bw = st - m, tone = TONES[(rnd() * TONES.length) | 0];
      /* тень и квартал */
      g.fillStyle = 'rgba(10,10,8,.55)'; g.fillRect(bx - st / 2 + m / 2 + .09, by - st / 2 + m / 2 + .11, bw, bw);
      g.fillStyle = tone; g.fillRect(bx - st / 2 + m / 2, by - st / 2 + m / 2, bw, bw);
      /* дворы и разбивка на дома */
      g.fillStyle = 'rgba(30,32,26,.45)';
      if (d < .6) g.fillRect(bx - bw * .22, by - bw * .22, bw * .44, bw * .44);
      else { g.fillRect(bx - st / 2 + m / 2 + bw * .48, by - st / 2 + m / 2, bw * .06, bw); g.fillRect(bx - st / 2 + m / 2, by - st / 2 + m / 2 + bw * .48, bw, bw * .06) }
      g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(bx - st / 2 + m / 2, by - st / 2 + m / 2, bw, bw * .18);
    }
    /* проспекты */
    g.strokeStyle = 'rgba(176,164,134,.55)'; g.lineWidth = .16;
    for (const t of [-1, 1]) { g.beginPath(); g.moveTo(-R, t * st * .5 * (n % 2 ? 1 : 0)); g.lineTo(R, t * st * .5 * (n % 2 ? 1 : 0)); g.stroke() }
    g.beginPath(); g.moveTo(st * .5, -R); g.lineTo(st * .5, R); g.stroke();
    g.restore();
  };
  const hamlet = (x, y, n) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * (.6 + n * .07);
      const hx = x + Math.cos(a) * rr, hy = y + Math.sin(a) * rr;
      if (lakeAt(hx, hy)) continue;
      house(hx, hy, .3 + rnd() * .2, .22 + rnd() * .12, rnd() * 3, TONES[(rnd() * TONES.length) | 0]);
    }
  };
  for (const ct of def.cities || []) town(ct.x, ct.y, ct.r, true);
  for (const p of def.points) {
    if (p.city) town(p.x, p.y, p.w * 2.2 + 1, p.w >= 2.5);
    else hamlet(p.x, p.y, 7 + Math.round(p.w * 3));
  }
  /* хутора в полях — для масштаба */
  for (let i = 0; i < 140; i++) {
    const x = 6 + rnd() * (WW - 12), y = 6 + rnd() * (WH - 12);
    if (forestAt(x, y) || lakeAt(x, y) || (cR && bil(cR, x, y) > .3)) continue;
    if (def.points.some(p => Math.hypot(p.x - x, p.y - y) < 9)) continue;
    hamlet(x, y, 2 + ((rnd() * 4) | 0));
  }
  g.restore();

  /* кроны для крупного масштаба: рисуются вектором (base.js), чтобы вблизи лес был резким */
  const tr = [], SP = .9;
  for (let y = SP / 2; y < WH; y += SP) for (let x = SP / 2; x < WW; x += SP) {
    const jx = x + (h2(x * 10 | 0, y * 10 | 0, 81) - .5) * SP * .9, jy = y + (h2(x * 10 | 0, y * 10 | 0, 83) - .5) * SP * .9;
    const fv = bil(cF, jx, jy) + (vn(jx * 1.4, jy * 1.4, 17) - .5) * .045;
    if (fv < FT + .006 || (cL && bil(cL, jx, jy) > 0)) continue;
    tr.push(jx, jy, .3 + h2(x * 7 | 0, y * 7 | 0, 85) * .16 + Math.min(.1, (fv - FT) * .8));
  }
  TREES = new Float32Array(tr);
  TER = c; TER_ID = id;
  buildTreeGrid();
  buildMips();
  bakeMini(T);
}

/** деревья по клеткам карты: в каждой — индексы в TREES */
function buildTreeGrid() {
  const cells = new Array(TG_W * TG_H);
  for (let i = 0; i < TREES.length; i += 3) {
    const cx0 = Math.min(TG_W - 1, Math.max(0, TREES[i] / TG_CELL | 0));
    const cy0 = Math.min(TG_H - 1, Math.max(0, TREES[i + 1] / TG_CELL | 0));
    const k = cy0 * TG_W + cx0;
    (cells[k] || (cells[k] = [])).push(i);
  }
  TREE_GRID = cells.map(a => a ? Int32Array.from(a) : null);
}

/** мип-пирамида топоосновы: каждый уровень вдвое меньше предыдущего */
function buildMips() {
  TER_MIP = [TER];
  let prev = TER;
  while (prev.width > 160 && prev.height > 160 && TER_MIP.length < 5) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, prev.width >> 1); c.height = Math.max(1, prev.height >> 1);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(prev, 0, 0, c.width, c.height);
    TER_MIP.push(c);
    prev = c;
  }
}

/** уровень, чей размер ближе всего к нужному на экране (но не меньше) */
function terLevel(pxWide) {
  if (!TER_MIP.length) return TER;
  for (let i = TER_MIP.length - 1; i > 0; i--) if (TER_MIP[i].width >= pxWide) return TER_MIP[i];
  return TER_MIP[0];
}

/** мини-карта: подложка с реками и дорогами, один раз на карту */
function bakeMini(T) {
  const k = 2, c = document.createElement('canvas');
  c.width = WW * k; c.height = WH * k;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(TER, 0, 0, c.width, c.height);
  g.scale(k, k); g.lineJoin = g.lineCap = 'round';
  for (const r of T.roads()) { g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.strokeStyle = 'rgba(200,180,130,.55)'; g.lineWidth = r.main ? .9 : .6; g.stroke() }
  for (const r of T.rivers()) { g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.strokeStyle = '#2a6688'; g.lineWidth = r.w + .8; g.stroke() }
  MINI = c;
}

function mulberry2(a) { return () => { let t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

/** сглаживание ломаной (Чайкин): реки и дороги без изломов */
function chaikin(pts, n) {
  let p = pts;
  for (let it = 0; it < (n || 2); it++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      q.push({ x: a.x * .75 + b.x * .25, y: a.y * .75 + b.y * .25 }, { x: a.x * .25 + b.x * .75, y: a.y * .25 + b.y * .75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}
