'use strict';
/* ============================================================
   ТЕКСТУРЫ ДЫМА И ОГНЯ (клиент)
   ------------------------------------------------------------
   Вместо кругов с радиальным градиентом — клубы из фрактального шума:
   рваный край (граница искажена шумом), неровная плотность внутри,
   у каждого варианта своя форма. Генерируются один раз при загрузке,
   потом рисуются drawImage с поворотом, растяжением и прозрачностью.
   Окраска — заранее в кэше (цвет округлён, вариантов немного).
   Если холст недоступен (тесты в jsdom) — запасной вариант градиентом.
   Перенесено из «Ночного рубежа» (degradacia).
   ============================================================ */

const SmokeTex = (() => {
  const N = 6, S = 96;
  let base = null, failed = false;
  const tinted = new Map();

  /* ---------- шум: значения в узлах решётки, плавная интерполяция, октавы ---------- */
  function lattice(seed) {
    const p = new Float32Array(64 * 64);
    let s = seed * 9301 + 49297;
    for (let i = 0; i < p.length; i++) { s = (s * 9301 + 49297) % 233280; p[i] = s / 233280 }
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const at = (a, b) => p[((a & 63) << 6) | (b & 63)];
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
  }

  function fbm(n, x, y, oct) {
    let s = 0, a = .5, f = 1, t = 0;
    for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); t += a; a *= .5; f *= 2.03 }
    return s / t;
  }

  /** один клуб: белый, вся форма — в альфе */
  function puff(seed) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S), d = img.data;
    const n1 = lattice(seed), n2 = lattice(seed + 17);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = i / S * 2 - 1, y = j / S * 2 - 1;
      /* граница: расстояние до центра, искажённое крупным шумом — клуб «бугристый» */
      const warp = fbm(n1, x * 1.6 + 3, y * 1.6 + 3, 3) - .5;
      const r = Math.hypot(x, y) + warp * .7;
      let a = 1 - Math.min(1, Math.max(0, (r - .25) / .65));
      a = a * a * (3 - 2 * a);
      /* внутри — мелкая неровная плотность, как клочья */
      const dens = fbm(n2, x * 4 + 7, y * 4 + 1, 4);
      a *= .35 + .9 * dens;
      const k = (j * S + i) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = Math.max(0, Math.min(255, a * 255));
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function build() {
    if (base || failed) return base;
    try {
      base = [];
      for (let i = 0; i < N; i++) base.push(puff(i * 31 + 5));
      /* проверка, что холст настоящий */
      if (!base[0].getContext('2d').getImageData) throw new Error('нет холста');
    } catch (e) { base = null; failed = true }
    return base;
  }

  /** клуб нужного цвета (цвет округляется до шага 12, чтобы кэш был маленьким) */
  function get(v, r, g, b) {
    const B = build();
    if (!B) return null;
    v = (((v | 0) % N) + N) % N;
    const q = c => Math.min(255, Math.round(c / 12) * 12);
    const key = v + ':' + q(r) + ',' + q(g) + ',' + q(b);
    let t = tinted.get(key);
    if (!t) {
      t = document.createElement('canvas');
      t.width = t.height = S;
      const x = t.getContext('2d');
      x.drawImage(B[v], 0, 0);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = `rgb(${q(r)},${q(g)},${q(b)})`;
      x.fillRect(0, 0, S, S);
      tinted.set(key, t);
    }
    return t;
  }

  /**
   * нарисовать клуб: центр (x, y), радиус r, растяжение sx (вдоль ang),
   * поворот ang, прозрачность a, цвет [r, g, b], вариант v
   */
  function draw(cx, v, x, y, r, a, rgb, ang, sx) {
    if (a <= .005 || r < .5) return;
    const t = get(v, rgb[0], rgb[1], rgb[2]);
    if (!t) {
      /* запасной путь: мягкий градиент */
      const gr = cx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
      gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      cx.fillStyle = gr; cx.fillRect(x - r, y - r, r * 2, r * 2);
      return;
    }
    const pa = cx.globalAlpha;
    cx.globalAlpha = pa * Math.min(1, a);
    cx.save();
    cx.translate(x, y); cx.rotate(ang || 0); cx.scale(sx || 1, 1);
    cx.drawImage(t, -r, -r, r * 2, r * 2);
    cx.restore();
    cx.globalAlpha = pa;
  }

  /**
   * то же без поворота: вместо угла — отражения (fl: 0–3), растяжение sx — по
   * горизонтали. Копирование без поворота в разы дешевле (на слабых устройствах
   * и при программной отрисовке — втрое), а у мягкого клуба поворот почти не
   * заметен. Для массового дыма: шлейфы, пожары, завесы.
   */
  function drawFast(cx, v, x, y, r, a, rgb, fl, sx) {
    if (a <= .005 || r < .5) return;
    const t = get(v, rgb[0], rgb[1], rgb[2]);
    if (!t) return draw(cx, v, x, y, r, a, rgb, 0, sx);
    const pa = cx.globalAlpha, w = r * (sx || 1);
    cx.globalAlpha = pa * Math.min(1, a);
    if (!(fl & 3)) cx.drawImage(t, x - w, y - r, w * 2, r * 2);
    else {
      cx.save(); cx.translate(x, y); cx.scale(fl & 1 ? -1 : 1, fl & 2 ? -1 : 1);
      cx.drawImage(t, -w, -r, w * 2, r * 2);
      cx.restore();
    }
    cx.globalAlpha = pa;
  }

  return { draw, drawFast, N };
})();
