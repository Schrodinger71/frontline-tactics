'use strict';
/* ============================================================
   ХОЛСТ И КАМЕРА (клиент)
   ------------------------------------------------------------
   G.view — то, что видно сейчас (центр в км и масштаб, пикс./км);
   CAM — куда камера плавно едет. Масштаб меняется по экспоненте,
   а точка под курсором при этом остаётся на месте (якорь), поэтому
   приближение больше не «уплывает» и не прыгает рывками.

   Колесо нормализуется (строки, страницы, жест «щипок» на тачпаде
   приходит как ctrl+колесо), шаг ограничен — тачпад больше не
   улетает в максимальное приближение. Сенсорный экран: один палец —
   двигать карту, два — масштаб, короткое касание — клик, долгое —
   снять выбор.

   Границы: масштаб от «вся карта в видимой области» до крупного;
   карту нельзя утащить за край дальше небольшого поля, и она не
   прячется под панелями.
   ============================================================ */

let cv, cx, CW = 0, CH = 0, DPR = 1;
const CAM = { x: 150, y: 220, s: 5, ax: null, ay: 0, sx: 0, sy: 0, moving: false };
const S_MAX = 10.5;
const w2s = p => ({ x: (p.x - G.view.x) * G.view.s + CW / 2, y: (p.y - G.view.y) * G.view.s + CH / 2 });
const s2w = p => ({ x: (p.x - CW / 2) / G.view.s + G.view.x, y: (p.y - CH / 2) / G.view.s + G.view.y });
const onScreen = (q, m) => q.x > -m && q.x < CW + m && q.y > -m && q.y < CH + m;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  CW = cv.clientWidth; CH = cv.clientHeight;
  const w = Math.round(CW * DPR), h = Math.round(CH * DPR);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
  if (typeof ICON_CACHE !== 'undefined') ICON_CACHE.clear();
  if (G && G.view) { clampTo(G.view); clampTo(CAM) }
}
/** изменение масштаба страницы (Ctrl +/−) меняет devicePixelRatio — перестраиваем холст */
function watchDPR() {
  if (!window.matchMedia) return;
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const on = () => { resize(); watchDPR() };
  if (mq.addEventListener) mq.addEventListener('change', on, { once: true });
  else if (mq.addListener) mq.addListener(on);
}

/** видимая область карты на экране: между панелями и под верхней строкой */
function mapArea() {
  const top = document.getElementById('top'), L = document.getElementById('left'), R = document.getElementById('right');
  const t = top ? top.getBoundingClientRect().bottom : 0;
  const shown = el => el && !el.classList.contains('col') && getComputedStyle(el).display !== 'none' && !document.body.classList.contains('nopanels');
  const l = shown(L) ? L.getBoundingClientRect().right : 0;
  const r = shown(R) ? R.getBoundingClientRect().left : CW;
  return { l: Math.max(0, l), r: Math.min(CW, r || CW), t, b: CH };
}
function sMin() {
  const a = mapArea();
  return Math.max(.6, Math.min((a.r - a.l) / WW, (a.b - a.t) / WH) * .94);
}
/** не дать карте уехать: поле 60 пикс. за краем, при мелком масштабе — по центру видимой области */
function clampTo(v) {
  if (!CW) return v;
  v.s = clamp(v.s, sMin(), S_MAX);
  const a = mapArea(), m = 60;
  const fit = (lo, hi, len, c0) => {
    if (len * v.s <= hi - lo) return len / 2 - ((lo + hi) / 2 - c0) / v.s;
    return null;
  };
  const fx = fit(a.l, a.r, WW, CW / 2), fy = fit(a.t, a.b, WH, CH / 2);
  if (fx !== null) v.x = fx; else v.x = clamp(v.x, (CW / 2 - a.l - m) / v.s, WW - (a.r - m - CW / 2) / v.s);
  if (fy !== null) v.y = fy; else v.y = clamp(v.y, (CH / 2 - a.t - m) / v.s, WH - (a.b - m - CH / 2) / v.s);
  return v;
}
function clampView() { clampTo(G.view) }

/** шаг камеры: масштаб — по логарифму, центр — вслед за якорем или к цели */
function camTick(dt) {
  const v = G.view, k = 1 - Math.exp(-dt * 16);
  const ls = Math.log(v.s), lt = Math.log(CAM.s);
  const done = Math.abs(ls - lt) < .002 && Math.abs(v.x - CAM.x) * v.s < .4 && Math.abs(v.y - CAM.y) * v.s < .4;
  if (done) { if (CAM.moving) { v.s = CAM.s; v.x = CAM.x; v.y = CAM.y; CAM.moving = false; CAM.ax = null } return }
  CAM.moving = true;
  v.s = Math.exp(ls + (lt - ls) * k);
  if (CAM.ax !== null) {
    v.x = CAM.ax - (CAM.sx - CW / 2) / v.s;
    v.y = CAM.ay - (CAM.sy - CH / 2) / v.s;
  } else { v.x += (CAM.x - v.x) * k; v.y += (CAM.y - v.y) * k }
  clampTo(v);
}
/** приблизить в точке экрана sp в f раз */
function zoomAt(sp, f) {
  const base = CAM.moving ? CAM : G.view;
  const ns = clamp(base.s * f, sMin(), S_MAX);
  const a = s2wAt(sp, base);
  CAM.ax = a.x; CAM.ay = a.y; CAM.sx = sp.x; CAM.sy = sp.y; CAM.s = ns;
  CAM.x = a.x - (sp.x - CW / 2) / ns; CAM.y = a.y - (sp.y - CH / 2) / ns;
  clampTo(CAM);
  CAM.moving = true;
}
const s2wAt = (p, v) => ({ x: (p.x - CW / 2) / v.s + v.x, y: (p.y - CH / 2) / v.s + v.y });
/** сдвиг карты мышью или пальцем — сразу, без сглаживания */
function panTo(x, y) {
  G.view.x = x; G.view.y = y; clampTo(G.view);
  CAM.x = G.view.x; CAM.y = G.view.y; CAM.s = G.view.s; CAM.ax = null; CAM.moving = false;
}
/** плавно навести камеру на точку мира (s — новый масштаб) */
function camTo(p, s) {
  CAM.ax = null; CAM.x = p.x; CAM.y = p.y; CAM.s = s ? clamp(s, sMin(), S_MAX) : CAM.moving ? CAM.s : G.view.s;
  clampTo(CAM); CAM.moving = true;
}
function camFit() { camTo({ x: WW / 2, y: WH / 2 }, sMin()) }
/** «рабочий» масштаб: гекс шириной около 46 пикселей */
const S_WORK = () => clamp(46 / Hex.HW, sMin(), S_MAX);

/** колесо → множитель масштаба */
function wheelFactor(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= CH;
  const k = e.ctrlKey ? .012 : .0019;
  return clamp(Math.exp(-dy * k), .72, 1.38);
}
