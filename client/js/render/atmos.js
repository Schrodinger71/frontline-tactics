'use strict';
/* ============================================================
   АТМОСФЕРА (клиент)
   огни городов ночью · облака клубами по ветру · туман-дымка ·
   дождь и снег в координатах карты (двигаются вместе с ней) ·
   вспышки молний · зерно и виньетка «экрана штаба» (CSS-слои).
   Настройки экрана — в окне звука, хранятся в localStorage.
   ============================================================ */

const SCREEN = { grain: true, vignette: true, shake: true, clouds: true };
try { Object.assign(SCREEN, JSON.parse(localStorage.getItem('ft.screen') || '{}')) } catch (e) { /* без настроек */ }
function setScreen(k, v) {
  SCREEN[k] = v;
  try { localStorage.setItem('ft.screen', JSON.stringify(SCREEN)) } catch (e) { /* приватный режим */ }
  applyScreenFX();
}
function applyScreenFX() {
  document.body.classList.toggle('no-vig', !SCREEN.vignette);
  document.body.classList.toggle('no-grain', !SCREEN.grain);
  const el = document.getElementById('fxGrain');
  if (el && SCREEN.grain && !el.style.backgroundImage && !/jsdom/i.test(navigator.userAgent)) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const g = c.getContext('2d'), d = g.createImageData(96, 96);
      for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255 | 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 16 }
      g.putImageData(d, 0, 0);
      el.style.backgroundImage = `url(${c.toDataURL()})`;
    } catch (e) { /* без холста */ }
  }
}
function screenPanelHTML() {
  const ck = (k, n) => `<label class="snd"><span>${n}</span><input type="checkbox" data-scr="${k}" ${SCREEN[k] ? 'checked' : ''}></label>`;
  return `<div class="lbl">Экран</div>${ck('grain', 'Зерно')}${ck('vignette', 'Виньетка')}${ck('shake', 'Дрожь от разрывов')}${ck('clouds', 'Облака и осадки')}`;
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

/* ---------- облака, туман, осадки ---------- */
const WX_LOOK = { clear: { cloud: 0, haze: 0 }, cloud: { cloud: .16, haze: 0 }, fog: { cloud: .12, haze: .26 }, rain: { cloud: .2, haze: .06, rain: 1 }, snow: { cloud: .15, haze: .08, snow: 1 }, storm: { cloud: .26, haze: .08, rain: 1.4 } };
const WX_PUFFS = (() => { let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; const a = []; for (let i = 0; i < 46; i++) a.push({ x: r() * (H.WW + 160), y: r() * (H.WH + 160), r: 14 + r() * 26, k: .6 + r() * .4, v: (r() * 6) | 0 }); return a })();
let WX_DROPS = [];
function drawWeather(dt) {
  const L = WX_LOOK[G.weather] || WX_LOOK.clear, s = G.view.s, w = windVec(), T = RT();
  if (!SCREEN.clouds) { WX_DROPS = []; if (L.haze) { cx.fillStyle = `rgba(160,172,180,${L.haze})`; cx.fillRect(0, 0, CW, CH) } return }
  if (L.cloud) {
    const drift = T * 1.2, sx = H.WW + 160, sy = H.WH + 160;
    for (const p of WX_PUFFS) {
      const x = ((p.x + w.x * drift) % sx + sx) % sx - 80, y = ((p.y + w.y * drift) % sy + sy) % sy - 80;
      const q = w2s({ x, y }), r = p.r * s;
      if (q.x < -r || q.y < -r || q.x > CW + r || q.y > CH + r) continue;
      /* тень облака на земле и само облако */
      SmokeTex.draw(cx, p.v, q.x + 30, q.y + 40, r * 1.1, L.cloud * p.k * .55, [4, 8, 10], p.x, 1.4);
      SmokeTex.draw(cx, p.v + 1, q.x, q.y, r, L.cloud * p.k * .7, [196, 206, 214], p.y, 1.5);
    }
  }
  if (L.haze) {
    cx.fillStyle = `rgba(170,182,190,${L.haze})`; cx.fillRect(0, 0, CW, CH);
    /* клочья тумана */
    for (let i = 0; i < 14; i++) {
      const x = ((i * 211 + T * 8) % (CW + 600)) - 300, y = (i * 137) % CH;
      SmokeTex.draw(cx, i, x, y, 260, L.haze * .9, [176, 186, 192], i, 2.2);
    }
  }
  const amt = L.rain || L.snow || 0;
  if (!amt) { WX_DROPS = []; return }
  const a = s2w({ x: 0, y: 0 }), b = s2w({ x: CW, y: CH }), vw = b.x - a.x, vh = b.y - a.y;
  const n = Math.round((L.rain ? 220 : 160) * amt);
  if (WX_DROPS.length > n) WX_DROPS.length = n;
  while (WX_DROPS.length < n) WX_DROPS.push({ x: a.x + Math.random() * vw, y: a.y + Math.random() * vh, z: .5 + Math.random() * .5, ph: Math.random() * 9 });
  const fall = (L.rain ? 560 : 55) / s, vx = w.x * (L.rain ? 90 : 40) / s;
  if (L.rain) { cx.strokeStyle = 'rgba(170,200,225,.24)'; cx.lineWidth = 1; cx.beginPath() } else cx.fillStyle = 'rgba(235,242,248,.6)';
  for (const d of WX_DROPS) {
    d.x += (vx + (L.snow ? Math.sin(T * 1.3 + d.ph) * 14 / s : 0)) * dt * d.z; d.y += fall * dt * d.z;
    if (d.x < a.x - vw || d.x > b.x + vw || d.y < a.y - vh || d.y > b.y + vh) { d.x = a.x + Math.random() * vw; d.y = a.y + Math.random() * vh }
    if (d.y > b.y) { d.y -= vh; d.x = a.x + Math.random() * vw } else if (d.y < a.y) d.y += vh;
    if (d.x > b.x) d.x -= vw; else if (d.x < a.x) d.x += vw;
    const q = w2s(d);
    if (L.rain) { cx.moveTo(q.x, q.y); cx.lineTo(q.x - vx * s * .025, q.y - 13 * d.z) } else cx.fillRect(q.x, q.y, 1.6 * d.z + .6, 1.6 * d.z + .6);
  }
  if (L.rain) cx.stroke();
  if (G.weather === 'storm' && Math.random() < .004) { LIGHTNING = RT(); Sound.thunder() }
  if (RT() - LIGHTNING < .25) { cx.fillStyle = `rgba(220,230,255,${.28 * (1 - (RT() - LIGHTNING) / .25)})`; cx.fillRect(0, 0, CW, CH) }
}
let LIGHTNING = 0;

/** роза ветров и масштабная линейка — в углу карты */
function drawScaleBar() {
  const a = mapArea(), s = G.view.s;
  const steps = [1, 2, 5, 10, 20, 50, 100];
  let km = steps.find(k => k * s > 70) || 100;
  const x0 = a.r - 22 - km * s, y0 = CH - 26;
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
