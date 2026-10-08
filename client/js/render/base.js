'use strict';
/* ============================================================
   ПОДЛОЖКА НА ЭКРАНЕ (клиент)
   ------------------------------------------------------------
   Всё, что не меняется от кадра к кадру, собирается в буфер BASE
   размером с холст и перерисовывается, только когда сдвинули или
   приблизили карту, сменилось время суток или взорвали мост:
     поле стола и рамка карты с километровыми делениями;
     топооснова (render/terrain.js);
     реки, дороги, мосты — вектором, сглажены, резкие на любом масштабе;
     сетка гексов — пиксельно чёткая гравировка (тёмная линия + блик),
       на крупном масштабе — номера клеток;
     тонировка типов клеток (клавиша T);
     освещение по времени суток: рассвет, день, закат, ночь.
   ============================================================ */

/* Подложку печём с запасом PAD вокруг экрана и держим вместе с положением
   камеры, для которого она испечена. Пока камера не ушла за этот запас и
   масштаб не менялся, кадр — просто копирование готового слоя (сотые доли мс)
   вместо перерисовки (на максимальном приближении это были десятки мс). */
const PAD = 170;
let BASE = null, baseKey = '', baseAt = null;
/** подложку печём в свой холст и дальше только копируем, пока вид не изменился */
function renderBaseTo(s) { const main = cx; cx = BASE.getContext('2d'); try { renderBase(s) } finally { cx = main } }
const MAPGEO = { id: null, edges: null, rivers: null, roads: null, bridges: null };

/** геометрия карты, которую рисуем вектором: один раз на карту */
function mapGeo(id) {
  if (MAPGEO.id === id) return MAPGEO;
  const T = Terrain.get(id), m = H.build(id);
  /* рёбра сетки — каждое по разу */
  const E = [];
  for (let h = 0; h < H.NH; h++) {
    const cs = H.corners(h);
    for (let i = 0; i < 6; i++) {
      /* ребро между вершинами i и i+1; сосед за ним — по направлению */
      const d = [0, 5, 4, 3, 2, 1][i];
      const n = H.nb(h, d);
      if (n >= 0 && n < h) continue;
      const a = cs[i], b = cs[(i + 1) % 6];
      const lake = m.hexes[h].t === 'lake' && (n < 0 || m.hexes[n].t === 'lake');
      E.push(a.x, a.y, b.x, b.y, lake ? 1 : 0);
    }
  }
  MAPGEO.edges = new Float32Array(E);
  MAPGEO.rivers = T.rivers().map(r => ({ n: r.n, w: r.w, pts: chaikin(r.pts, 2) }));
  MAPGEO.roads = T.roads().map(r => ({ main: r.main, pts: chaikin(r.pts, 2) }));
  /* мосты правил (рёбра гексов) — рисуем у настоящего пересечения дороги с рекой */
  const nat = T.bridges(), segDir = (x, y) => {
    let best = null, bd = 1e9;
    for (const r of T.roads()) for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, d = (mx - x) ** 2 + (my - y) ** 2;
      if (d < bd) { bd = d; best = Math.atan2(b.y - a.y, b.x - a.x) }
    }
    return best || 0;
  };
  MAPGEO.bridges = H.bridgeList(id).map(b => {
    let p = null, pd = 49;
    for (const q of nat) { const d = (q.x - b.x) ** 2 + (q.y - b.y) ** 2; if (d < pd) { pd = d; p = q } }
    const x = p ? p.x : b.x, y = p ? p.y : b.y;
    return { key: b.key, x, y, a: segDir(x, y), main: p ? p.main : true };
  });
  MAPGEO.id = id;
  return MAPGEO;
}

/* ---------- время суток: цвет и сила освещения ---------- */
function todLook() {
  const h = hourOfTurn(G.turn || 0);
  /* 06 — рассвет, 10/14 — день, 18 — закат, 22/02 — ночь */
  return {
    6:  { shade: 'rgba(30,26,60,.16)', tint: 'rgba(255,170,130,.07)', dir: 1 },
    10: null, 14: null,
    18: { shade: 'rgba(40,20,20,.14)', tint: 'rgba(255,140,60,.09)', dir: -1 },
    22: { shade: 'rgba(4,10,28,.42)', tint: null },
    2:  { shade: 'rgba(3,8,24,.46)', tint: null }
  }[h] || null;
}

function drawBase() {
  const v = G.view, s = v.s;
  const brKey = (G.br || []).map(b => b.join(':')).join(',');
  /* в ключе нет ни положения камеры, ни масштаба: сдвиг гасится запасом,
     а масштаб — растягиванием готового слоя во время жеста */
  const key = [CW, CH, DPR, G.mapId, hourOfTurn(G.turn || 0), G.showTypes ? 1 : 0, SCREEN.trees ? 1 : 0, brKey, G.selRiv || ''].join('|');
  const needW = Math.ceil((CW + PAD * 2) * DPR), needH = Math.ceil((CH + PAD * 2) * DPR);
  if (!BASE || BASE.width !== needW || BASE.height !== needH) {
    BASE = document.createElement('canvas'); BASE.width = needW; BASE.height = needH; baseKey = ''; baseAt = null;
  }
  const now = performance.now();
  const k = baseAt ? s / baseAt.s : 1;                     /* во сколько раз тянем готовый слой */
  const drift = baseAt ? Math.max(Math.abs((baseAt.x - v.x) * s), Math.abs((baseAt.y - v.y) * s)) : 0;
  /* растянутый слой обязан закрывать экран целиком, иначе по краям будет пусто */
  const covers = baseAt && (CW + PAD * 2) * k >= CW + drift * 2 + 4 && (CH + PAD * 2) * k >= CH + drift * 2 + 4;
  const exact = baseAt && k === 1 && drift <= PAD;
  /* печём заново, если слой не годится вовсе либо жест кончился и пора вернуть чёткость */
  const stale = !baseAt || key !== baseKey || !covers || k < .55 || k > 2.2;
  const settled = !exact && !stale && now - (baseAt.t || 0) > 140;
  if (stale || settled) {
    baseKey = key; baseAt = { x: v.x, y: v.y, s, t: now };
    /* печём на вьюпорт с запасом: w2s и слои читают CW/CH, поэтому подменяем их */
    const oCW = CW, oCH = CH;
    CW = oCW + PAD * 2; CH = oCH + PAD * 2;
    try { renderBaseTo(s) } finally { CW = oCW; CH = oCH }
  }
  const kk = s / baseAt.s, wpx = (CW + PAD * 2) * kk, hpx = (CH + PAD * 2) * kk;
  const dx = CW / 2 - wpx / 2 + (baseAt.x - v.x) * s;
  const dy = CH / 2 - hpx / 2 + (baseAt.y - v.y) * s;
  cx.save(); cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'low';
  cx.drawImage(BASE, dx, dy, wpx, hpx);
  cx.restore();
}

function renderBase(s) {
  const geo = mapGeo(G.mapId);
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  /* стол штабной карты */
  const a = w2s({ x: 0, y: 0 }), b = w2s({ x: H.WW, y: H.WH });
  /* стол виден, только если лист карты не закрывает холст целиком */
  if (a.x > 0 || a.y > 0 || b.x < CW || b.y < CH) {
    const bg = cx.createRadialGradient(CW / 2, CH / 2, 0, CW / 2, CH / 2, Math.max(CW, CH) * .75);
    bg.addColorStop(0, '#0b1116'); bg.addColorStop(1, '#030507');
    cx.fillStyle = bg; cx.fillRect(0, 0, CW, CH);
  }
  /* Тень под листом карты. На приближении лист больше экрана в разы, а размытие
     по такому прямоугольнику стоит десятки миллисекунд — поэтому тень рисуем
     только когда край листа вообще виден, а подложку заливаем обрезанной. */
  const edgeVisible = a.x > -40 || a.y > -40 || b.x < CW + 40 || b.y < CH + 40;
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fx = cl(a.x, -40, CW + 40), fy = cl(a.y, -40, CH + 40);
  const fw = cl(b.x, -40, CW + 40) - fx, fh = cl(b.y, -40, CH + 40) - fy;
  if (fw > 0 && fh > 0) {
    cx.save();
    if (edgeVisible) { cx.shadowColor = 'rgba(0,0,0,.7)'; cx.shadowBlur = 28 }
    cx.fillStyle = '#10161a';
    cx.fillRect(fx, fy, fw, fh);
    cx.restore();
  }
  /* топооснова */
  cx.save();
  cx.beginPath(); cx.rect(a.x, a.y, b.x - a.x, b.y - a.y); cx.clip();
  cx.translate(CW / 2, CH / 2); cx.scale(s, s); cx.translate(-G.view.x, -G.view.y);
  /* Топооснова: берём мип-уровень по нужному размеру на экране и рисуем ТОЛЬКО
     видимый кусок. Раньше в каждый кадр отдавалась вся текстура целиком — на
     максимальном приближении это растягивание в несколько раз стоило десятки
     миллисекунд и ощущалось рывками при перемещении. */
  const lv = terLevel(H.WW * s * DPR);
  const halfW = CW / 2 / s + 2, halfH = CH / 2 / s + 2;
  const x0 = clamp(G.view.x - halfW, 0, H.WW), x1 = clamp(G.view.x + halfW, 0, H.WW);
  const y0 = clamp(G.view.y - halfH, 0, H.WH), y1 = clamp(G.view.y + halfH, 0, H.WH);
  if (x1 - x0 > .01 && y1 - y0 > .01) {
    /* при растягивании дорогое сглаживание не окупается — картинка всё равно мягкая */
    const upscale = lv.width < H.WW * s * DPR;
    cx.imageSmoothingEnabled = true;
    /* уровень пирамиды меньше вдвое — «medium» хватает, «high» дорог */
    cx.imageSmoothingQuality = upscale ? 'low' : 'medium';
    const kx = lv.width / H.WW, ky = lv.height / H.WH;
    cx.drawImage(lv, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
  }
  cx.restore();
  /* деревья рисуем и в движении: раньше быстрый кадр их пропускал, и на время
     прокрутки зума лес пропадал, возвращаясь рывком. Перебор идёт по клеткам
     сетки, поэтому это уже недорого. */
  drawTrees(s);
  cx.save();
  cx.beginPath(); cx.rect(a.x, a.y, b.x - a.x, b.y - a.y); cx.clip();
  drawRivers(geo, s);
  drawRoads(geo, s);
  drawBridgesBase(geo, s);
  if (G.showTypes) drawTypeTint(s);
  drawGrid(geo, s);
  if (G.selRiv) drawRiverEdges(s);
  const tod = todLook();
  if (tod) {
    cx.fillStyle = tod.shade; cx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    if (tod.tint) {
      const g = cx.createLinearGradient(tod.dir > 0 ? CW : 0, 0, tod.dir > 0 ? 0 : CW, 0);
      g.addColorStop(0, tod.tint); g.addColorStop(.7, 'rgba(0,0,0,0)');
      cx.fillStyle = g; cx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }
  cx.restore();
  drawFrame(a, b, s);
}

/* ---------- рамка листа и деления ---------- */
function drawFrame(a, b, s) {
  cx.strokeStyle = 'rgba(200,214,222,.35)'; cx.lineWidth = 1;
  cx.strokeRect(Math.round(a.x) - .5, Math.round(a.y) - .5, Math.round(b.x - a.x) + 1, Math.round(b.y - a.y) + 1);
  cx.strokeStyle = 'rgba(200,214,222,.12)';
  cx.strokeRect(Math.round(a.x) - 4.5, Math.round(a.y) - 4.5, Math.round(b.x - a.x) + 9, Math.round(b.y - a.y) + 9);
  const step = s > 3 ? 10 : 20;
  cx.fillStyle = 'rgba(190,206,216,.5)'; cx.strokeStyle = 'rgba(190,206,216,.4)';
  cx.font = '600 10px ui-monospace,Consolas,monospace';
  cx.beginPath();
  for (let x = 0; x <= H.WW; x += step) {
    const q = w2s({ x, y: 0 }), big = x % 50 === 0, L = big ? 7 : 4;
    if (q.x < -20 || q.x > CW + 20) continue;
    const X = Math.round(q.x) + .5;
    cx.moveTo(X, a.y - 1); cx.lineTo(X, a.y - 1 - L); cx.moveTo(X, b.y + 1); cx.lineTo(X, b.y + 1 + L);
  }
  for (let y = 0; y <= H.WH; y += step) {
    const q = w2s({ x: 0, y }), big = y % 50 === 0, L = big ? 7 : 4;
    if (q.y < -20 || q.y > CH + 20) continue;
    const Y = Math.round(q.y) + .5;
    cx.moveTo(a.x - 1, Y); cx.lineTo(a.x - 1 - L, Y); cx.moveTo(b.x + 1, Y); cx.lineTo(b.x + 1 + L, Y);
  }
  cx.stroke();
  cx.textAlign = 'center';
  for (let x = 50; x < H.WW; x += 50) { const q = w2s({ x, y: 0 }); if (q.x > 0 && q.x < CW) { cx.fillText(x, q.x, a.y - 11); cx.fillText(x, q.x, b.y + 19) } }
  cx.textAlign = 'right';
  for (let y = 50; y < H.WH; y += 50) { const q = w2s({ x: 0, y }); if (q.y > 0 && q.y < CH) cx.fillText(y, a.x - 10, q.y + 3) }
  cx.textAlign = 'left';
  for (let y = 50; y < H.WH; y += 50) { const q = w2s({ x: H.WW, y }); if (q.y > 0 && q.y < CH) cx.fillText(y, b.x + 10, q.y + 3) }
}

/* ---------- кроны деревьев: вблизи лес из отдельных крон с тенью ----------
   Крона — готовый спрайт (тень, крона, блик) под свой радиус в пикселях.
   Деревья целой клетки сетки TREE_GRID (10×10 км) печём в отдельный холст
   под ступень масштаба и дальше рисуем клетку одним drawImage. Раньше при
   каждой перепечке подложки (сдвиг за запас, конец жеста зума) заново
   рисовались все кроны в кадре — до 15–20 тысяч drawImage и 60–100 мс,
   отсюда рывки. Порядок отрисовки прежний: клетки по строкам, внутри клетки
   — в порядке TREES, поэтому картинка та же.
   Отключаются в настройках экрана («Деревья вблизи») и кнопкой ♣. */
const TREE_SPR = new Map();
function treeSprite(rp) {
  let c = TREE_SPR.get(rp);
  if (c) return c;
  const R = rp / DPR, sz = Math.ceil(rp * 2.9) + 2;
  c = document.createElement('canvas'); c.width = c.height = sz;
  const g = c.getContext('2d'), o = sz / 2 - rp * .2;
  g.fillStyle = 'rgba(6,12,6,.5)'; g.beginPath(); g.arc(o + rp * .35, o + rp * .4, rp, 0, 7); g.fill();
  const gr = g.createRadialGradient(o - rp * .3, o - rp * .35, rp * .1, o, o, rp);
  gr.addColorStop(0, '#4b6a42'); gr.addColorStop(.55, '#2c4a30'); gr.addColorStop(1, '#1d3322');
  g.fillStyle = gr; g.beginPath(); g.arc(o, o, rp, 0, 7); g.fill();
  g.strokeStyle = 'rgba(8,16,8,.6)'; g.lineWidth = Math.max(.6, rp * .08); g.stroke();
  c.off = o; c.R = R;
  if (TREE_SPR.size > 60) TREE_SPR.clear();
  TREE_SPR.set(rp, c);
  return c;
}

/* ступени масштаба для печёных клеток: через ~10 %, печём на верхнюю
   границу ступени и на экран только уменьшаем — кроны не мылятся */
const TREE_STEP = 1.1, TREE_PAD = 1.2;            /* запас клетки, км: кроны вылезают за её край */
const TREE_CELLS = new Map();                     /* `${ступень}:${клетка}` → холст */
let treeCellsFor = '', treeCellsPx = 0;
const TREE_CELLS_MAXPX = 64e6;                    /* ~256 МБ RGBA — выше чистим старые ступени */
function treeBucket(s) { return Math.ceil(Math.log(s) / Math.log(TREE_STEP) - 1e-9) }
function treeCellCanvas(k, bk) {
  const key = bk + ':' + k;
  let c = TREE_CELLS.get(key);
  if (c) { TREE_CELLS.delete(key); TREE_CELLS.set(key, c); return c }   /* свежесть для вытеснения */
  const cell = TREE_GRID[k];
  if (!cell) return null;
  const sq = Math.pow(TREE_STEP, bk), ppk = sq * DPR;                  /* пикселей холста на км */
  const x0 = (k % TG_W) * TG_CELL - TREE_PAD, y0 = ((k / TG_W) | 0) * TG_CELL - TREE_PAD;
  const side = Math.ceil((TG_CELL + TREE_PAD * 2) * ppk);
  c = document.createElement('canvas'); c.width = c.height = side;
  const g = c.getContext('2d'), T = TREES;
  let lastRp = -1, sp = null;
  for (let n = 0; n < cell.length; n++) {
    const i = cell[n], rp = Math.max(2, Math.round(T[i + 2] * sq * DPR));
    if (rp !== lastRp) sp = treeSprite(lastRp = rp);
    g.drawImage(sp, (T[i] - x0) * ppk - sp.off, (T[i + 1] - y0) * ppk - sp.off);
  }
  c.x0 = x0; c.y0 = y0; c.ppk = ppk;
  TREE_CELLS.set(key, c); treeCellsPx += side * side;
  /* вытесняем самые давние, пока не уложимся */
  for (const [kk, v] of TREE_CELLS) {
    if (treeCellsPx <= TREE_CELLS_MAXPX) break;
    if (kk === key) continue;
    TREE_CELLS.delete(kk); treeCellsPx -= v.width * v.height;
  }
  return c;
}
/** любая уже испечённая ступень этой клетки — пока идёт жест зума */
function treeCellAny(k, bk) {
  for (let d = 1; d < 12; d++) for (const b of [bk + d, bk - d]) { const c = TREE_CELLS.get(b + ':' + k); if (c) return c }
  return null;
}
function drawTrees(s) {
  if (!TREES || !TREE_GRID || s < 6 || !SCREEN.trees) return;
  const id = TER_ID + '|' + DPR;
  if (treeCellsFor !== id) { TREE_CELLS.clear(); treeCellsPx = 0; treeCellsFor = id }
  const al = clamp((s - 6) / 1.5, 0, 1), a = s2w({ x: -20, y: -20 }), b = s2w({ x: CW + 20, y: CH + 20 });
  const ox = CW / 2 - G.view.x * s, oy = CH / 2 - G.view.y * s;
  const bk = treeBucket(s);
  /* во время жеста новые ступени не печём: берём ближайшую готовую,
     точную допечём, когда камера встанет (подложка всё равно перепечётся) */
  const lazy = CAM.moving;
  cx.globalAlpha = al;
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'low';
  const pad = TREE_PAD + .6;
  const x0 = Math.max(0, (a.x - pad) / TG_CELL | 0), x1 = Math.min(TG_W - 1, (b.x + pad) / TG_CELL | 0);
  const y0 = Math.max(0, (a.y - pad) / TG_CELL | 0), y1 = Math.min(TG_H - 1, (b.y + pad) / TG_CELL | 0);
  for (let cy = y0; cy <= y1; cy++) for (let cx0 = x0; cx0 <= x1; cx0++) {
    const k = cy * TG_W + cx0;
    if (!TREE_GRID[k]) continue;
    const c = (lazy && (TREE_CELLS.get(bk + ':' + k) || treeCellAny(k, bk))) || treeCellCanvas(k, bk);
    if (!c) continue;
    const w = c.width / c.ppk * s;
    cx.drawImage(c, c.x0 * s + ox, c.y0 * s + oy, w, w);
  }
  cx.globalAlpha = 1;
}
/** вкл/выкл кроны (кнопка ♣ и настройки экрана) */
function setTrees(on) {
  setScreen('trees', !!on);
  const b = document.querySelector('[data-z=trees]'); if (b) b.classList.toggle('on', !!on);
  document.querySelectorAll('[data-scr=trees]').forEach(el => { el.checked = !!on });
}

/* ---------- реки ---------- */
function strokePts(pts) { cx.beginPath(); for (let i = 0; i < pts.length; i++) { const q = w2s(pts[i]); i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y) } }
function drawRivers(geo, s) {
  cx.lineJoin = 'round'; cx.lineCap = 'round';
  for (const r of geo.rivers) {
    const wpx = Math.max(1.6, r.w * s);
    strokePts(r.pts);
    cx.strokeStyle = 'rgba(28,40,30,.85)'; cx.lineWidth = wpx + Math.max(2, s * .5); cx.stroke();      /* берег */
    cx.strokeStyle = '#16405a'; cx.lineWidth = wpx; cx.stroke();
    cx.strokeStyle = 'rgba(64,124,160,.75)'; cx.lineWidth = wpx * .62; cx.stroke();
    if (wpx > 5) { cx.strokeStyle = 'rgba(150,200,225,.22)'; cx.lineWidth = Math.max(1, wpx * .16); cx.setLineDash([wpx * 1.6, wpx * 2.2]); cx.stroke(); cx.setLineDash([]) }
  }
  /* подписи рек на крупном масштабе */
  if (s > 4) {
    cx.font = `italic 600 ${Math.round(clamp(s * 1.6, 11, 15))}px Georgia,"Times New Roman",serif`;
    cx.fillStyle = 'rgba(150,205,230,.75)'; cx.textAlign = 'center';
    for (const r of geo.rivers) for (const t of [.3, .7]) {
      const i = Math.floor(r.pts.length * t), p = r.pts[i], p2 = r.pts[Math.min(r.pts.length - 1, i + 4)], q = w2s(p);
      if (!onScreen(q, -20)) continue;
      let ang = Math.atan2(p2.y - p.y, p2.x - p.x); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      cx.save(); cx.translate(q.x, q.y); cx.rotate(ang); cx.fillText(r.n, 0, -r.w * s * .5 - 6); cx.restore();
    }
  }
}
/* ---------- дороги ---------- */
function drawRoads(geo, s) {
  const wm = clamp(s * .42, 1.3, 4.4), ws = clamp(s * .28, 1, 3);
  cx.lineJoin = 'round'; cx.lineCap = 'round';
  for (const r of geo.roads) { strokePts(r.pts); cx.strokeStyle = 'rgba(14,12,8,.62)'; cx.lineWidth = (r.main ? wm : ws) + 1.8; cx.stroke() }
  for (const r of geo.roads) { strokePts(r.pts); cx.strokeStyle = r.main ? '#b8a171' : '#8d8262'; cx.lineWidth = r.main ? wm : ws; cx.stroke() }
  if (s > 5) for (const r of geo.roads) if (r.main) { strokePts(r.pts); cx.strokeStyle = 'rgba(250,236,190,.32)'; cx.lineWidth = 1; cx.setLineDash([5, 7]); cx.stroke(); cx.setLineDash([]) }
}
/* ---------- мосты ---------- */
function drawBridgesBase(geo, s) {
  const st = new Map(G.br || []);
  const L = clamp(s * 2.1, 9, 34), Wd = clamp(s * .9, 4.5, 13);
  for (const b of geo.bridges) {
    const q = w2s(b);
    if (!onScreen(q, 40)) continue;
    const down = st.get(b.key) === 'down';
    cx.save(); cx.translate(q.x, q.y); cx.rotate(b.a);
    cx.fillStyle = 'rgba(0,0,0,.45)'; cx.fillRect(-L / 2 + 1.5, -Wd / 2 + 2, L, Wd);
    if (down) {
      for (const sx of [-1, 1]) {
        cx.fillStyle = '#7d7462'; cx.strokeStyle = '#15191b'; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(sx * L / 2, -Wd / 2); cx.lineTo(sx * L * .14, -Wd / 2); cx.lineTo(sx * L * .2, 0); cx.lineTo(sx * L * .1, Wd / 2); cx.lineTo(sx * L / 2, Wd / 2); cx.closePath(); cx.fill(); cx.stroke();
      }
      cx.strokeStyle = '#ff5b47'; cx.lineWidth = 2; const r = Wd * .55;
      cx.beginPath(); cx.moveTo(-r, -r); cx.lineTo(r, r); cx.moveTo(r, -r); cx.lineTo(-r, r); cx.stroke();
    } else {
      cx.fillStyle = '#d6c8a2'; cx.strokeStyle = '#121618'; cx.lineWidth = 1;
      cx.fillRect(-L / 2, -Wd / 2, L, Wd); cx.strokeRect(-L / 2 + .5, -Wd / 2 + .5, L - 1, Wd - 1);
      cx.strokeStyle = 'rgba(40,36,28,.6)';
      cx.beginPath(); cx.moveTo(-L / 2 + 2, -Wd / 2 + 1.5); cx.lineTo(L / 2 - 2, -Wd / 2 + 1.5); cx.moveTo(-L / 2 + 2, Wd / 2 - 1.5); cx.lineTo(L / 2 - 2, Wd / 2 - 1.5); cx.stroke();
      /* быки */
      cx.fillStyle = '#121618';
      for (const t of [-.5, -.17, .17, .5]) cx.fillRect(t * L - 1, -Wd / 2 - 1.5, 2, 1.5);
    }
    cx.restore();
  }
}
/* ---------- сетка гексов ---------- */
function drawGrid(geo, s) {
  const hw = Hex.HW * s;
  const k = clamp((hw - 10) / 34, .25, 1);
  const E = geo.edges, a = s2w({ x: -40, y: -40 }), b = s2w({ x: CW + 40, y: CH + 40 });
  const snap = v => Math.round(v * DPR) / DPR + .5 / DPR;
  const path = (dy, skipLake) => {
    cx.beginPath();
    for (let i = 0; i < E.length; i += 5) {
      const x1 = E[i], y1 = E[i + 1], x2 = E[i + 2], y2 = E[i + 3];
      if ((x1 < a.x && x2 < a.x) || (x1 > b.x && x2 > b.x) || (y1 < a.y && y2 < a.y) || (y1 > b.y && y2 > b.y)) continue;
      if (skipLake && E[i + 4]) continue;
      let X1 = (x1 - G.view.x) * s + CW / 2, Y1 = (y1 - G.view.y) * s + CH / 2 + dy, X2 = (x2 - G.view.x) * s + CW / 2, Y2 = (y2 - G.view.y) * s + CH / 2 + dy;
      if (Math.abs(X1 - X2) < .01) { X1 = X2 = snap(X1) }       /* вертикальные рёбра — точно по пикселю */
      cx.moveTo(X1, Y1); cx.lineTo(X2, Y2);
    }
  };
  cx.lineCap = 'butt';
  cx.lineWidth = 1;
  /* гравировка: тёмная тень на пиксель ниже и светлая линия ребра */
  cx.lineWidth = hw > 60 ? 1.25 : 1;
  path(1, true); cx.strokeStyle = `rgba(0,0,0,${.5 * k})`; cx.stroke();
  path(0, false); cx.strokeStyle = `rgba(230,238,216,${.3 * k})`; cx.stroke();
  /* номера клеток: КККРР, как на штабной карте */
  if (hw > 74) {
    cx.font = `500 ${Math.round(clamp(hw * .11, 8, 11))}px ui-monospace,Consolas,monospace`;
    cx.fillStyle = `rgba(220,228,210,${clamp((hw - 74) / 50, 0, .2)})`; cx.textAlign = 'center';
    for (let h = 0; h < H.NH; h++) {
      const c = H.center(h);
      if (c.x < a.x || c.x > b.x || c.y < a.y || c.y > b.y) continue;
      const q = w2s(c);
      cx.fillText(String(H.colOf(h) + 1).padStart(2, '0') + String(H.rowOf(h) + 1).padStart(2, '0'), q.x, q.y - Hex.R * s * .72);
    }
  }
}
/* ---------- тонировка типов клеток ---------- */
const TYPE_TINT = { forest: 'rgba(40,140,70,.26)', hill: 'rgba(210,160,90,.24)', city: 'rgba(200,200,200,.24)', marsh: 'rgba(70,170,170,.24)', mount: 'rgba(235,225,210,.28)', lake: 'rgba(60,120,200,.2)', open: null };
function drawTypeTint(s) {
  const m = H.build(G.mapId);
  for (const t in TYPE_TINT) {
    if (!TYPE_TINT[t]) continue;
    cx.beginPath();
    for (const hx of m.hexes) {
      if (hx.t !== t) continue;
      const q = w2s(hx);
      if (!onScreen(q, 60)) continue;
      H.corners(hx.id, .96).forEach((p, i) => { const r = w2s(p); i ? cx.lineTo(r.x, r.y) : cx.moveTo(r.x, r.y) }); cx.closePath();
    }
    cx.fillStyle = TYPE_TINT[t]; cx.fill();
  }
  /* значки типов */
  if (Hex.HW * s > 30) {
    cx.lineWidth = 1.4; cx.strokeStyle = 'rgba(240,236,220,.7)'; cx.fillStyle = 'rgba(240,236,220,.7)';
    for (const hx of m.hexes) {
      const q = w2s(hx), r = Hex.R * s * .28;
      if (!onScreen(q, 40) || hx.t === 'open' || hx.t === 'lake') continue;
      cx.beginPath();
      if (hx.t === 'forest') { cx.arc(q.x, q.y + r * .1, r * .45, 0, 7); cx.moveTo(q.x, q.y + r * .55); cx.lineTo(q.x, q.y + r) }
      else if (hx.t === 'hill') { cx.moveTo(q.x - r, q.y + r * .5); cx.quadraticCurveTo(q.x, q.y - r * .9, q.x + r, q.y + r * .5) }
      else if (hx.t === 'mount') { cx.moveTo(q.x - r, q.y + r * .6); cx.lineTo(q.x - r * .3, q.y - r * .6); cx.lineTo(q.x + r * .1, q.y); cx.lineTo(q.x + r * .5, q.y - r * .8); cx.lineTo(q.x + r, q.y + r * .6) }
      else if (hx.t === 'marsh') { for (let i = -1; i <= 1; i++) { cx.moveTo(q.x + i * r * .6 - r * .3, q.y + r * .4); cx.lineTo(q.x + i * r * .6 + r * .3, q.y + r * .4); cx.moveTo(q.x + i * r * .6, q.y + r * .4); cx.lineTo(q.x + i * r * .6, q.y - r * .2) } }
      else if (hx.t === 'city') { cx.rect(q.x - r * .7, q.y - r * .3, r * .6, r * .8); cx.rect(q.x + r * .05, q.y - r * .7, r * .6, r * 1.2) }
      cx.stroke();
    }
  }
}
/** рёбра-реки (по правилам) — когда выбрана часть: видно, где брод */
function drawRiverEdges(s) {
  const m = H.build(G.mapId), st = new Map(G.br || []);
  cx.lineCap = 'round';
  for (let h = 0; h < H.NH; h++) for (let d = 0; d < 3; d++) {
    const e = m.edge[h * 6 + d];
    if (!(e & Hex.RIV)) continue;
    const n = H.nb(h, d), q = w2s(H.center(h));
    if (!onScreen(q, 60)) continue;
    const key = Hex.edgeKey(h, n), bridge = ((e & Hex.BR) && st.get(key) !== 'down') || st.get(key) === 'pontoon';
    const [p1, p2] = H.edgeEnds(h, d).map(w2s);
    cx.strokeStyle = bridge ? 'rgba(220,210,160,.7)' : 'rgba(120,200,255,.75)'; cx.lineWidth = 2.2;
    cx.setLineDash(bridge ? [3, 4] : []);
    cx.beginPath(); cx.moveTo(p1.x, p1.y); cx.lineTo(p2.x, p2.y); cx.stroke();
  }
  cx.setLineDash([]);
}
