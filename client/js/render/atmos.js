'use strict';
/* ============================================================
   АТМОСФЕРА (клиент)
   огни городов ночью · облака клубами по ветру · туман-дымка ·
   дождь и снег в координатах карты (двигаются вместе с ней) ·
   вспышки молний · зерно и виньетка «экрана штаба» (CSS-слои).
   Настройки экрана — в окне звука, хранятся в localStorage.
   ============================================================ */

const SCREEN = { grain: true, vignette: true, shake: true, weather: true, trees: true, quality: 'auto' };
try {
  const saved = JSON.parse(localStorage.getItem('ft.screen') || '{}');
  /* было «Облака и осадки» (clouds) — теперь «Погода на карте» целиком */
  if (saved && 'clouds' in saved && !('weather' in saved)) saved.weather = saved.clouds;
  Object.assign(SCREEN, saved);
} catch (e) { /* без настроек */ }
if (!['auto', 'high', 'low'].includes(SCREEN.quality)) SCREEN.quality = 'auto';

/* ---------- качество графики ----------
   «Высокое» — всё как задумано. «Экономное» — холст в 1 пикс. на точку
   (на телефонах это вчетверо меньше работы), вдвое меньше клубов дыма и
   огня, без облаков, зерна и виньетки. «Авто» начинает с высокого и само
   переходит на экономное, если карта несколько секунд подряд не успевает
   (меньше ~22 кадров в секунду); решение запоминается для этого браузера. */
let AUTO_LOW = false;
try { AUTO_LOW = localStorage.getItem('ft.autolow') === '1' } catch (e) { /* приватный режим */ }
function LOWFX() { return SCREEN.quality === 'low' || (SCREEN.quality === 'auto' && AUTO_LOW) }
function saveScreen() { try { localStorage.setItem('ft.screen', JSON.stringify(SCREEN)) } catch (e) { /* приватный режим */ } }
function setScreen(k, v) {
  SCREEN[k] = v;
  if (k === 'quality') { AUTO_LOW = false; try { localStorage.removeItem('ft.autolow') } catch (e) { /* приватный режим */ } }
  saveScreen();
  applyScreenFX();
  if (k === 'quality' && typeof resize === 'function' && cv) resize();
  syncScreenUI();
}
/** кнопки и галочки, которые показывают настройки экрана, — в одно состояние */
function syncScreenUI() {
  const b = document.querySelector('[data-z=wx]'); if (b) b.classList.toggle('on', !!SCREEN.weather);
  const t = document.querySelector('[data-z=trees]'); if (t) t.classList.toggle('on', !!SCREEN.trees);
  document.querySelectorAll('[data-scr]').forEach(el => { if (el.type === 'checkbox') el.checked = !!SCREEN[el.dataset.scr]; else el.value = SCREEN[el.dataset.scr] });
}
function applyScreenFX() {
  const low = LOWFX();
  document.body.classList.toggle('no-vig', !SCREEN.vignette || low);
  document.body.classList.toggle('no-grain', !SCREEN.grain || low);
  const el = document.getElementById('fxGrain');
  if (el && SCREEN.grain && !low && !el.style.backgroundImage && !/jsdom/i.test(navigator.userAgent)) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const g = c.getContext('2d'), d = g.createImageData(96, 96);
      for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255 | 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 16 }
      g.putImageData(d, 0, 0);
      el.style.backgroundImage = `url(${c.toDataURL()})`;
    } catch (e) { /* без холста */ }
  }
}
/** погода на карте вкл/выкл (кнопка ☁, клавиша W, настройки экрана) */
function setWeatherFX(on) { setScreen('weather', !!on); if (typeof toast === 'function') toast(on ? 'Погода на карте включена' : 'Погода на карте выключена — правила погоды действуют как прежде') }
function screenPanelHTML() {
  const ck = (k, n) => `<label class="snd"><span>${n}</span><input type="checkbox" data-scr="${k}" ${SCREEN[k] ? 'checked' : ''}></label>`;
  const q = [['auto', 'Авто'], ['high', 'Высокое'], ['low', 'Экономное']].map(([v, n]) => `<option value="${v}"${SCREEN.quality === v ? ' selected' : ''}>${n}</option>`).join('');
  return `<div class="lbl">Экран</div>
    <label class="snd"><span>Качество графики${SCREEN.quality === 'auto' && AUTO_LOW ? ' <i class="mu">(сейчас экономное)</i>' : ''}</span><select data-scr="quality">${q}</select></label>
    ${ck('weather', 'Погода на карте: облака, туман, осадки')}${ck('trees', 'Деревья вблизи (кроны в лесу)')}${ck('shake', 'Дрожь от разрывов')}${ck('grain', 'Зерно')}${ck('vignette', 'Виньетка')}
    <p class="hint">Погода на карте — только картинка: туман, дождь и снег по-прежнему влияют на обзор, огонь и авиацию. «Экономное» качество — для слабых устройств.</p>`;
}
/* следим за плавностью: если в бою кадры долго не успевают — режим «Авто» упрощает графику */
const PERF = { ema: 0, slow: 0, armed: 0 };
function perfWatch(dt) {
  const now = performance.now();
  if (SCREEN.quality !== 'auto' || AUTO_LOW || !G.roomId || !G.mapId || document.hidden || !TER || TER_ID !== G.mapId) { PERF.slow = 0; PERF.ema = 0; PERF.armed = now; return }
  /* после выпечки карты не судим; разрыв больше 1,5 с — пауза (вкладка была скрыта), а не медленный кадр */
  if (now - PERF.armed < 3000 || dt > 1.5) return;
  dt = Math.min(dt, .5);
  PERF.ema = PERF.ema ? PERF.ema * .92 + dt * .08 : dt;
  PERF.slow = PERF.ema > 1 / 22 ? PERF.slow + dt : Math.max(0, PERF.slow - dt * .5);
  if (PERF.slow < 4) return;
  AUTO_LOW = true;
  try { localStorage.setItem('ft.autolow', '1') } catch (e) { /* приватный режим */ }
  applyScreenFX();
  if (typeof resize === 'function') resize();
  if (typeof toast === 'function') toast('Графика упрощена, чтобы карта не тормозила. Вернуть — 🔊 → «Качество графики».');
}

/* ---------- огни городов ---------- */
const LIGHTS = new Map();
function cityLights(p) {
  let L = LIGHTS.get(p.id);
  if (L) return L;
  let seed = 0;
  for (const ch of p.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const c = H.center(p.hex), R = p.city ? p.w * 2 + 1.5 : 1.2, n = p.city ? 10 + p.w * 10 : 4;
  L = [];
  for (let i = 0; i < n; i++) { const a = rnd() * 6.28, r = Math.sqrt(rnd()) * R; L.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, k: rnd(), sz: .5 + rnd() * .9 }) }
  LIGHTS.set(p.id, L);
  return L;
}
function drawCityLights() {
  const h = hourOfTurn(G.turn || 0), night = h === 22 || h === 2, dusk = h === 18 || h === 6;
  if (!night && !dusk) return;
  const fade = night ? 1 : .35, s = G.view.s, T = RT();
  cx.save(); cx.globalCompositeOperation = 'lighter';
  for (const p of G.pts) {
    const q = w2s(H.center(p.hex));
    if (!onScreen(q, 120)) continue;
    /* у фронта — затемнение: огни реже и мерцают */
    const near = G.units.some(u => H.hexDist(u.hex, p.hex) <= 1 && u.side !== p.owner);
    const pw = near ? .35 : 1;
    let lit = 0;
    for (const L of cityLights(p)) {
      if (L.k > pw) continue;
      lit++;
      const fl = near ? .55 + .45 * Math.sin(T * (3 + L.k * 7) + L.x) : 1, r = Math.max(1.4, L.sz * 1.3 * clamp(s / 3, .8, 2.6)), qq = w2s(L);
      cx.fillStyle = `rgba(255,214,150,${.7 * fl * fade})`; cx.fillRect(qq.x - r / 2, qq.y - r / 2, r, r);
    }
    if (lit) {
      const R = ((p.city ? p.w * 3.2 : 1.6) + 4) * s, g = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, R);
      g.addColorStop(0, `rgba(255,190,110,${.18 * fade * lit / cityLights(p).length})`); g.addColorStop(1, 'rgba(255,190,110,0)');
      cx.fillStyle = g; cx.fillRect(q.x - R, q.y - R, R * 2, R * 2);
    }
  }
  cx.restore();
}

/* ---------- облака, туман, осадки ----------
   Облака и туман — бесшовные текстуры из периодического шума в координатах
   карты: двигаются вместе с картой и ветром, в кадре — несколько копирований.
   Раньше облака были полусотней повёрнутых клубов, а туман — серой заливкой
   всего экрана с огромными клочьями поверх, которые стояли на месте при
   прокрутке и мылили всё, включая фишки.
     облака — над картой, тают при приближении (мы «под» ними);
     туман  — стелется по земле банками с просветами: рисуется ПОД фишками,
              подписями и подсветкой ходов, поэтому всё читается;
     дождь, снег, метель — частицы в координатах карты. */
const WX_LOOK = {
  clear: { cloud: 0 }, cloud: { cloud: .5 }, fog: { cloud: .22, fog: .58 },
  rain: { cloud: .62, rain: 1 }, snow: { cloud: .5, snow: 1 }, storm: { cloud: .78, rain: 1.4 },
  blizzard: { cloud: .6, snow: 2.2, blow: 1, fog: .26, fogFast: 1 }
};
/** периодический шум (бесшовная текстура): n×n, базовый период p клеток, oct октав */
function tileNoise(n, p, seed, oct) {
  const out = new Float32Array(n * n);
  let amp = .5, tot = 0, sd = seed * 977 + 13;
  const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let o = 0; o < oct; o++) {
    const per = p << o, lat = new Float32Array(per * per);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let j = 0; j < n; j++) {
      const y = j / n * per, yi = y | 0, fy = y - yi, v = fy * fy * (3 - 2 * fy), y0 = yi % per * per, y1 = (yi + 1) % per * per;
      for (let i = 0; i < n; i++) {
        const x = i / n * per, xi = x | 0, fx = x - xi, u = fx * fx * (3 - 2 * fx), x0 = xi % per, x1 = (xi + 1) % per;
        const a = lat[y0 + x0], b = lat[y0 + x1], c = lat[y1 + x0], d = lat[y1 + x1];
        out[j * n + i] += amp * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
      }
    }
    tot += amp; amp *= .5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
/** текстура из шума: плотность → прозрачность, цвет rgb */
function noiseTex(n, noise, lo, hi, rgb, amax) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data;
  for (let i = 0; i < noise.length; i++) {
    let t = (noise[i] - lo) / (hi - lo); t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
    d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = t * amax * 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
const WXTEX = {};
function wxTex(k) {
  if (WXTEX[k] !== undefined) return WXTEX[k];
  try {
    if (k === 'cloud' || k === 'shade') {
      const nz = WXTEX._cn || (WXTEX._cn = tileNoise(192, 3, 7, 4));
      WXTEX[k] = k === 'cloud' ? noiseTex(192, nz, .5, .78, [206, 214, 222], .85) : noiseTex(192, nz, .5, .78, [4, 8, 10], .6);
    } else if (k === 'fog') WXTEX[k] = noiseTex(160, tileNoise(160, 2, 23, 3), .3, .78, [198, 207, 213], 1);
    else if (k === 'wisp') WXTEX[k] = noiseTex(128, tileNoise(128, 3, 41, 3), .42, .8, [212, 220, 225], 1);
  } catch (e) { WXTEX[k] = null }
  return WXTEX[k];
}
/** замостить видимую часть листа текстурой tex: tw — размер плитки в км, (ox, oy) — сдвиг, км */
function tileOver(tex, tw, ox, oy, alpha) {
  if (!tex || alpha <= .004) return;
  const s = G.view.s, a = s2w({ x: 0, y: 0 }), b = s2w({ x: CW, y: CH });
  const x0 = Math.max(0, a.x), y0 = Math.max(0, a.y), x1 = Math.min(H.WW, b.x), y1 = Math.min(H.WH, b.y);
  if (x1 <= x0 || y1 <= y0) return;
  cx.save();
  const p = w2s({ x: x0, y: y0 }), q = w2s({ x: x1, y: y1 });
  cx.beginPath(); cx.rect(p.x, p.y, q.x - p.x, q.y - p.y); cx.clip();
  cx.globalAlpha = alpha; cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'low';
  const i0 = Math.floor((x0 - ox) / tw), i1 = Math.floor((x1 - ox) / tw), j0 = Math.floor((y0 - oy) / tw), j1 = Math.floor((y1 - oy) / tw);
  /* края плиток — по целым точкам экрана: ни щелей, ни светлых швов от наложения */
  const px = v => Math.round(v * DPR) / DPR, sx = i => px(w2s({ x: ox + i * tw, y: 0 }).x), sy = j => px(w2s({ x: 0, y: oy + j * tw }).y);
  for (let j = j0; j <= j1; j++) {
    const y = sy(j), h = sy(j + 1) - y;
    for (let i = i0; i <= i1; i++) { const x = sx(i); cx.drawImage(tex, x, y, sx(i + 1) - x, h) }
  }
  cx.restore();
}
const wxLook = () => SCREEN.weather ? (WX_LOOK[G.weather] || WX_LOOK.clear) : null;
/** туман по земле — под фишками (вызывается из кадра сразу после подложки) */
function drawGroundWeather() {
  const L = wxLook();
  if (!L || !L.fog) return;
  const s = G.view.s, T = RT(), w = windVec();
  /* вблизи туман реже: мы внутри него, и он не должен прятать соседние клетки */
  const zf = clamp(1.15 - (s - 4) * .06, .7, 1);
  const sp = L.fogFast ? 3.2 : .35;
  tileOver(wxTex('fog'), 150, w.x * T * sp, w.y * T * sp, L.fog * zf);
  if (!LOWFX()) tileOver(wxTex('wisp'), 64, -w.x * T * sp * 1.7 + 17, w.y * T * sp * .6 + 9, L.fog * .55 * zf);
}
let WX_DROPS = [];
function drawWeather(dt) {
  const L = wxLook(), s = G.view.s, w = windVec(), T = RT();
  if (!L) { WX_DROPS = []; return }
  /* облака высоко: при приближении тают, на рабочем масштабе почти не мешают */
  const cf = L.cloud * clamp((6.5 - s) / 3, 0, 1) * (LOWFX() ? 0 : 1);
  if (cf > .01) {
    const drift = T * 1.2, ox = w.x * drift, oy = w.y * drift;
    tileOver(wxTex('shade'), 190, ox + 7, oy + 9, cf * .8);
    tileOver(wxTex('cloud'), 190, ox, oy, cf);
  }
  const amt = L.rain || L.snow || 0;
  if (!amt) { WX_DROPS = []; }
  else {
    /* осадки — над листом карты, а не над столом */
    const pa = w2s({ x: 0, y: 0 }), pb = w2s({ x: H.WW, y: H.WH });
    cx.save(); cx.beginPath(); cx.rect(pa.x, pa.y, pb.x - pa.x, pb.y - pa.y); cx.clip();
    const a = s2w({ x: 0, y: 0 }), b = s2w({ x: CW, y: CH }), vw = b.x - a.x, vh = b.y - a.y;
    const n = Math.round((L.rain ? 220 : 160) * amt * (LOWFX() ? .5 : 1));
    if (WX_DROPS.length > n) WX_DROPS.length = n;
    while (WX_DROPS.length < n) WX_DROPS.push({ x: a.x + Math.random() * vw, y: a.y + Math.random() * vh, z: .5 + Math.random() * .5, ph: Math.random() * 9 });
    const fall = (L.rain ? 560 : L.blow ? 120 : 55) / s, vx = w.x * (L.rain ? 90 : L.blow ? 260 : 40) / s;
    const winter = mapWinter();
    if (L.rain) { cx.strokeStyle = 'rgba(170,200,225,.24)'; cx.lineWidth = 1; cx.beginPath() }
    else if (L.blow) { cx.strokeStyle = winter ? 'rgba(250,252,255,.85)' : 'rgba(235,242,248,.7)'; cx.lineWidth = 1.5; cx.beginPath() }
    for (const d of WX_DROPS) {
      d.x += (vx + (L.snow && !L.blow ? Math.sin(T * 1.3 + d.ph) * 14 / s : 0)) * dt * d.z; d.y += fall * dt * d.z;
      if (d.x < a.x - vw || d.x > b.x + vw || d.y < a.y - vh || d.y > b.y + vh) { d.x = a.x + Math.random() * vw; d.y = a.y + Math.random() * vh }
      if (d.y > b.y) { d.y -= vh; d.x = a.x + Math.random() * vw } else if (d.y < a.y) d.y += vh;
      if (d.x > b.x) d.x -= vw; else if (d.x < a.x) d.x += vw;
      const q = w2s(d);
      if (L.rain) { cx.moveTo(q.x, q.y); cx.lineTo(q.x - vx * s * .025, q.y - 13 * d.z) }
      else if (L.blow) { const k = 9 * d.z; cx.moveTo(q.x, q.y); cx.lineTo(q.x - vx * s * .03 * k / 9, q.y - fall * s * .03 * k / 9) }
      else {
        const z = 1.6 * d.z + .6;
        /* на снежной карте белые хлопья не видны на белом — с тенью */
        if (winter) { cx.fillStyle = 'rgba(40,52,64,.32)'; cx.fillRect(q.x + .8, q.y + .8, z, z) }
        cx.fillStyle = winter ? 'rgba(255,255,255,.95)' : 'rgba(235,242,248,.6)'; cx.fillRect(q.x, q.y, z, z);
      }
    }
    if (L.rain || L.blow) cx.stroke();
    cx.restore();
  }
  if (G.weather === 'storm' && Math.random() < .004) { LIGHTNING = RT(); Sound.thunder() }
  if (RT() - LIGHTNING < .25) { cx.fillStyle = `rgba(220,230,255,${.22 * (1 - (RT() - LIGHTNING) / .25)})`; cx.fillRect(0, 0, CW, CH) }
}
let LIGHTNING = 0;
/** зимняя ли текущая карта */
function mapWinter() { const d = typeof MAPS !== 'undefined' && MAPS[G.mapId]; return !!(d && d.winter) }

/** роза ветров и масштабная линейка — в углу карты */
function drawScaleBar() {
  const a = mapArea(), s = G.view.s;
  const steps = [1, 2, 5, 10, 20, 50, 100];
  let km = steps.find(k => k * s > 70) || 100;
  const x0 = a.r - 22 - km * s, y0 = a.b - 18;
  cx.save();
  cx.fillStyle = 'rgba(6,10,14,.6)'; cx.fillRect(x0 - 8, y0 - 16, km * s + 16, 26);
  cx.strokeStyle = 'rgba(220,228,234,.85)'; cx.lineWidth = 1.5;
  cx.beginPath(); cx.moveTo(x0, y0 - 4); cx.lineTo(x0, y0); cx.lineTo(x0 + km * s, y0); cx.lineTo(x0 + km * s, y0 - 4); cx.stroke();
  cx.fillStyle = 'rgba(220,228,234,.6)'; cx.fillRect(x0, y0 - 2, km * s / 2, 2);
  cx.fillStyle = '#dfe7ec'; cx.font = '600 11px ui-monospace,Consolas,monospace'; cx.textAlign = 'center';
  cx.fillText(km + ' км · гекс ' + Math.round(Hex.HW) + ' км', x0 + km * s / 2, y0 - 6);
  /* ветер */
  const w = windVec(), rx = x0 - 30, ry = y0 - 4;
  cx.strokeStyle = 'rgba(220,228,234,.5)'; cx.lineWidth = 1;
  cx.beginPath(); cx.arc(rx, ry, 11, 0, 7); cx.stroke();
  cx.translate(rx, ry); cx.rotate(Math.atan2(w.y, w.x));
  cx.fillStyle = '#9fd3f5'; cx.beginPath(); cx.moveTo(10, 0); cx.lineTo(-6, -4); cx.lineTo(-3, 0); cx.lineTo(-6, 4); cx.closePath(); cx.fill();
  cx.restore();
}
