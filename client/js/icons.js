'use strict';
/* ============================================================
   ИКОНКИ НА КАРТЕ И В ПАНЕЛЯХ (клиент) — как в «Ночном рубеже»
   Боковые профили из shared/icons.js на «плашках»: тёмная
   подложка, иконка в тонах стороны, рамка цвета состояния.
   Готовые картинки кэшируются по (иконка, тема, размер, зеркало) —
   на карте рисуется только drawImage.
   ============================================================ */

const ICON_THEMES = {
  own: { b: '#cfd8c6', s: '#8e9a87', l: '#f2f6ee', d: '#192016', g: '#86bdd2', a: '#e0ab45' },
  enemy: { b: '#efc39c', s: '#b07c55', l: '#fde6d2', d: '#2a1a10', g: '#c9a58a', a: '#ff8a5c' },
  ghost: { b: '#9a8578', s: '#6e5d53', l: '#b9a79b', d: '#2a1f19', g: '#8a7b70', a: '#b07c55' },
  dead: { b: '#6d6a66', s: '#4d4a47', l: '#8a8682', d: '#1a1817', g: '#4d4a47', a: '#6d4038' }
};

/** иконка типа k в технике той фракции, что играет за сторону side */
function unitIcon(k, side) { return iconKey(k || 'unk', (factionOf(side) || {}).style) }

const ICON_PATHS = {};
function iconPaths(key) {
  if (ICON_PATHS[key]) return ICON_PATHS[key];
  const L = ICONS[key] || ICONS.unk;
  return (ICON_PATHS[key] = typeof Path2D === 'undefined' ? [] : L.map(([t, d]) => [t, new Path2D(String(d)), d.bb]));
}

const ICON_CACHE = new Map();

/** готовая картинка иконки шириной px (с тёмной обводкой силуэта для читаемости) */
function iconImage(key, theme, px, flip) {
  px = Math.max(12, Math.round(px / 2) * 2);
  const id = key + '|' + theme + '|' + px + '|' + (flip ? 1 : 0) + '|' + DPR;
  let c = ICON_CACHE.get(id);
  if (c) return c;
  const k = px / ICON_W, pad = 3;
  c = document.createElement('canvas');
  c.width = Math.ceil(px * DPR) + pad * 2; c.height = Math.ceil(ICON_H * k * DPR) + pad * 2 + Math.ceil(12 * k * DPR);
  const g = c.getContext('2d');
  if (!g || !g.fill) { ICON_CACHE.set(id, c); return c }
  g.translate(pad, pad + 10 * k * DPR);
  g.scale(k * DPR, k * DPR);
  if (flip) { g.translate(ICON_W, 0); g.scale(-1, 1) }
  const pal = ICON_THEMES[theme] || ICON_THEMES.own;
  const P = iconPaths(key);
  /* тень на земле — машина стоит, а не висит на плашке */
  const sd = shadowOf(key);
  if (sd && g.ellipse) { g.fillStyle = 'rgba(0,0,0,.42)'; g.beginPath(); g.ellipse(sd.x, sd.y, sd.rx, sd.ry, 0, 0, Math.PI * 2); g.fill() }
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(4,7,10,.85)'; g.lineWidth = 3.2;
  for (const [t, p] of P) if (t === 'b' || t === 's' || t === 'd') g.stroke(p);
  /* светотень: свой градиент на каждый контур — по его рамке, сверху вниз */
  for (const [t, p, bb] of P) {
    const st = SHADE[t] && bb && bb[3] - bb[1] > 2.4 ? shadeStops(pal, t) : null;
    if (st) {
      const gr = g.createLinearGradient(0, bb[1], 0, bb[3]);
      gr.addColorStop(0, st[0]); gr.addColorStop(.45, st[1]); gr.addColorStop(1, st[2]);
      g.fillStyle = gr;
    } else g.fillStyle = pal[t] || pal.b;
    g.fill(p);
  }
  if (ICON_CACHE.size > 800) ICON_CACHE.clear();
  ICON_CACHE.set(id, c);
  return c;
}

/** иконка по центру точки (x,y) шириной w */
function drawIcon(g, key, x, y, w, theme, flip, alpha) {
  const img = iconImage(key, theme, w, flip);
  const iw = img.width / DPR, ih = img.height / DPR;
  if (alpha != null) g.globalAlpha = alpha;
  g.drawImage(img, x - iw / 2, y - ih / 2 - 2, iw, ih);
  if (alpha != null) g.globalAlpha = 1;
}

function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/** плашка: скруглённый прямоугольник с мягким градиентом и рамкой; tint — подложка стороны */
function drawPlate(g, x, y, w, h, col, sel, tint) {
  const r = Math.min(h * .32, 10);
  rr(g, x - w / 2, y - h / 2, w, h, r);
  const gr = g.createLinearGradient(0, y - h / 2, 0, y + h / 2);
  if (tint === 'enemy') { gr.addColorStop(0, 'rgba(46,26,22,.92)'); gr.addColorStop(1, 'rgba(20,10,8,.92)') }
  else { gr.addColorStop(0, 'rgba(24,34,42,.92)'); gr.addColorStop(1, 'rgba(8,13,18,.92)') }
  g.fillStyle = gr; g.fill();
  g.lineWidth = sel ? 2.2 : 1.3;
  g.strokeStyle = sel ? '#f2b33d' : col;
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x - w / 2 + r, y - h / 2 + 1.5); g.lineTo(x + w / 2 - r, y - h / 2 + 1.5); g.stroke();
}

/** иконка для панелей (inline SVG в тонах темы) */
function iconHTML(key, cls, theme) {
  const pal = ICON_THEMES[theme || 'own'];
  return `<svg class="${cls || 'ic'}" viewBox="0 -12 ${ICON_W} ${ICON_H + 12}" aria-hidden="true">${iconSVG(key, 0, 0, 1, pal)}</svg>`;
}
