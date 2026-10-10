'use strict';
/* ============================================================
   ФИШКИ ЧАСТЕЙ (клиент)
   ------------------------------------------------------------
   Фишка — как на штабной карте: плашка в тонах стороны с цветной
   полосой сверху. Сила — рядом из десяти точек, как в Unity of
   Command: целые шаги залиты, подавленные — пустые оранжевые,
   потерянные — тёмные. Род войск читается на любом масштабе:
   вблизи — силуэт техники, на среднем и дальнем — условный знак
   (пехота — крест, танки — овал, артиллерия — точка…).
   По ребру фишки — состояние: шевроны окопа слева, красный угол,
   если кончились боеприпасы или топливо, значки столбиком справа
   (котёл, «насмерть», засада, заслон, готовность к атаке…).
   Под фишкой — тень, у выбранной — золотое свечение.
   ============================================================ */

const SIDE_TONE = {
  own: { top: '#5fb6f0', g0: 'rgba(30,48,62,.96)', g1: 'rgba(10,18,26,.96)', bd: '#6cc3ff', txt: '#e6f3fb', box: '#16354a', gl: '#d6efff' },
  /* союзник: та же сторона, но другой командир — зелёным, чтобы не путать со своими */
  ally: { top: '#6fd18d', g0: 'rgba(26,52,36,.96)', g1: 'rgba(10,22,15,.96)', bd: '#7ee0a0', txt: '#e2f7e8', box: '#1b4430', gl: '#d9f7e2' },
  enemy: { top: '#ff6b55', g0: 'rgba(64,30,24,.96)', g1: 'rgba(26,12,10,.96)', bd: '#ff8a72', txt: '#fde6dc', box: '#5a2219', gl: '#ffe0d6' },
  /* призрак — где противника видели в последний раз: серый, без цвета стороны */
  ghost: { top: '#8a8f94', g0: 'rgba(52,56,60,.6)', g1: 'rgba(26,28,31,.6)', bd: '#a4aab0', txt: '#d8dde2', box: 'rgba(52,56,60,.6)', gl: '#c4cad0' }
};
const strCol = s => s <= 3 ? '#ff6b55' : s <= 6 ? '#ffd479' : '#8fe0a2';

/** Условный знак рода войск в рамке w×h с центром (x, y) — упрощённые армейские
    обозначения. Линии толстые: знак должен читаться и в плашке 14 пикселей. */
function typeGlyph(k, x, y, w, h, col) {
  const l = x - w / 2, r = x + w / 2, t = y - h / 2, b = y + h / 2;
  cx.save();
  cx.strokeStyle = col; cx.fillStyle = col; cx.lineWidth = clamp(w * .11, 1.3, 3.2); cx.lineCap = 'round'; cx.lineJoin = 'round';
  const ln = (...p) => { cx.beginPath(); cx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) cx.lineTo(p[i], p[i + 1]); cx.stroke() };
  const dot = (px, py, rad) => { cx.beginPath(); cx.arc(px, py, rad, 0, 7); cx.fill() };
  switch (k) {
    case 'inf': ln(l, t, r, b); ln(l, b, r, t); break;                                   /* пехота — крест */
    case 'mot': ln(l, t, r, b); ln(l, b, r, t); cx.beginPath(); cx.ellipse(x, y, w * .3, h * .24, 0, 0, 7); cx.stroke(); break;   /* мотопехота — крест с овалом */
    case 'tnk': cx.beginPath(); cx.ellipse(x, y, w * .44, h * .32, 0, 0, 7); cx.stroke(); break;       /* танки — овал гусеницы */
    case 'rec': ln(l, b, r, t); break;                                                   /* разведка — диагональ */
    case 'art': dot(x, y, Math.min(w, h) * .26); break;                                  /* артиллерия — точка */
    case 'mlrs': dot(x, y + h * .2, Math.min(w, h) * .2); ln(x - w * .3, y - h * .02, x, y - h * .26, x + w * .3, y - h * .02); ln(x - w * .3, y - h * .26, x, y - h * .5, x + w * .3, y - h * .26); break;   /* РСЗО — точка под шевронами */
    case 'aa': cx.beginPath(); cx.moveTo(l, b); cx.quadraticCurveTo(x, t - h * .5, r, b); cx.stroke(); break;   /* ПВО — купол */
    case 'eng': ln(l, y - h * .15, r, y - h * .15); ln(l, y - h * .15, l, b); ln(x, y - h * .15, x, b); ln(r, y - h * .15, r, b); break;   /* сапёры — мост */
    case 'at': ln(l, b, x, t, r, b); break;                                              /* ПТ — клин */
    case 'hq': ln(l + w * .12, t, l + w * .12, b); cx.fillRect(l + w * .12, t, w * .62, h * .5); break;   /* штаб — флаг */
    case 'fob': cx.beginPath(); cx.moveTo(x, t); cx.lineTo(r, y - h * .05); cx.lineTo(r - w * .14, b); cx.lineTo(l + w * .14, b); cx.lineTo(l, y - h * .05); cx.closePath(); cx.stroke(); dot(x, y + h * .08, Math.min(w, h) * .13); break;   /* пункт — блиндаж */
    case 'dep': ln(l, y + h * .22, r, y + h * .22); ln(l + w * .2, y + h * .22, l + w * .2, t + h * .1, r - w * .2, t + h * .1, r - w * .2, y + h * .22); break;   /* склад — ящик на черте */
    default: ln(l, y, r, y);
  }
  cx.restore();
}

function counter(u, q, alpha, scale) {
  const s = G.view.s, hw = Hex.HW * s * (scale || 1);
  const enemy = G.spec ? u.side === S : u.side !== G.side, T = utFor(u.side)[u.k] || UT.inf, ghost = u.ghost;
  /* союзная часть — своей стороны, но под другим командиром */
  const ally = !enemy && !ghost && !G.spec && G.mySeat && u.seat && u.seat !== G.mySeat;
  const tone = SIDE_TONE[ghost ? 'ghost' : enemy ? 'enemy' : ally ? 'ally' : 'own'];
  const sel = u.id === G.sel && !ghost;
  cx.save();
  if (alpha !== undefined) cx.globalAlpha = alpha;
  /* остатки разбитой части — блёклые: это уже не боевая единица */
  if (u.rem) cx.globalAlpha *= .78;
  if (hw < 34) { compact(u, q, hw, tone, sel, enemy); cx.restore(); return }
  const W = clamp(hw * .8, 30, 108), H = W * .74, x0 = q.x - W / 2, y0 = q.y - H / 2 - H * .04, R = Math.min(7, H * .16);
  const big = W >= 50;
  /* окоп вблизи: мешки с песком полукругом под фишкой */
  if (u.ent && !ghost && big) {
    cx.fillStyle = '#8f7a54'; cx.strokeStyle = 'rgba(20,16,10,.8)'; cx.lineWidth = 1;
    const n = 5 + u.ent * 2, rx = W * .62, ry = H * .5 + 3;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (.06 + .88 * i / (n - 1));
      const bx = q.x + Math.cos(a) * rx, by = q.y + Math.sin(a) * ry + H * .08;
      cx.beginPath(); cx.ellipse(bx, by, W * .07, W * .045, a - Math.PI / 2, 0, 7); cx.fill(); cx.stroke();
    }
  }
  /* тень */
  cx.fillStyle = 'rgba(0,0,0,.42)'; rr(cx, x0 + 2.5, y0 + 3.5, W, H, R); cx.fill();
  if (sel) { cx.shadowColor = 'rgba(242,179,61,.85)'; cx.shadowBlur = 14 }
  /* плашка */
  rr(cx, x0, y0, W, H, R);
  const gr = cx.createLinearGradient(0, y0, 0, y0 + H);
  gr.addColorStop(0, tone.g0); gr.addColorStop(1, tone.g1);
  cx.fillStyle = gr; cx.fill();
  cx.shadowBlur = 0; cx.shadowColor = 'transparent';
  /* полоса стороны */
  const band = Math.max(4, H * .17);
  cx.save(); rr(cx, x0, y0, W, H, R); cx.clip();
  cx.fillStyle = tone.top; cx.globalAlpha *= ghost ? .5 : .92; cx.fillRect(x0, y0, W, band);
  /* остатки: косая штриховка по плашке */
  if (u.rem) {
    cx.globalAlpha = (alpha === undefined ? 1 : alpha) * .22; cx.strokeStyle = '#fff'; cx.lineWidth = 2;
    cx.beginPath(); for (let i = -H; i < W; i += 7) { cx.moveTo(x0 + i, y0 + H); cx.lineTo(x0 + i + H, y0) } cx.stroke();
  }
  /* красный угол: кончились боеприпасы или топливо */
  const dry = !ghost && (u.sp === 0 || (u.fu === 0 && usesFuel(T)));
  if (dry) {
    cx.globalAlpha = alpha === undefined ? 1 : alpha; cx.fillStyle = '#ff3b2a';
    const c = W * .26; cx.beginPath(); cx.moveTo(x0 + W - c, y0 + H); cx.lineTo(x0 + W, y0 + H); cx.lineTo(x0 + W, y0 + H - c); cx.closePath(); cx.fill();
  }
  cx.restore();
  cx.lineWidth = sel ? 2.4 : 1.2; cx.strokeStyle = sel ? '#f2b33d' : tone.bd;
  if (ghost || u.rem) cx.setLineDash([4, 3]);
  rr(cx, x0 + .5, y0 + .5, W - 1, H - 1, R); cx.stroke(); cx.setLineDash([]);
  cx.strokeStyle = 'rgba(255,255,255,.08)'; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(x0 + R, y0 + band + 1.5); cx.lineTo(x0 + W - R, y0 + band + 1.5); cx.stroke();
  const bodyY = y0 + band, bodyH = H - band;
  /* род войск: вблизи — силуэт техники, на среднем масштабе — условный знак справа от цифры */
  const ik = unitIcon(u.k, u.side), theme = ghost ? 'ghost' : enemy ? 'enemy' : 'own';
  if (big) drawIcon(cx, ik, q.x, bodyY + bodyH * .4, W * .7, theme, u.side === S);
  else typeGlyph(u.k, x0 + W * .7, bodyY + bodyH * .46, W * .36, bodyH * .5, tone.gl);
  if (ghost) {
    /* призрак: знак вопроса и ход, когда видели */
    const fs = Math.round(clamp(W * .3, 11, 22));
    cx.font = `800 ${fs}px system-ui`; cx.textAlign = 'left'; cx.lineWidth = 3; cx.strokeStyle = 'rgba(0,0,0,.75)';
    cx.strokeText('?', x0 + 5, bodyY + bodyH * .5 + fs * .36); cx.fillStyle = '#e9edf0'; cx.fillText('?', x0 + 5, bodyY + bodyH * .5 + fs * .36);
    const txt = 'ход ' + Math.max(1, G.turn - (u.age || 0) + 1), ls = Math.round(clamp(W * .13, 9, 12));
    cx.font = `700 ${ls}px system-ui`; cx.textAlign = 'center';
    const tw = cx.measureText(txt).width + 8;
    cx.fillStyle = 'rgba(8,12,16,.8)'; rr(cx, q.x - tw / 2, y0 + H + 2, tw, ls + 5, 3); cx.fill();
    cx.fillStyle = '#c9d0d6'; cx.fillText(txt, q.x, y0 + H + ls + 3);
    cx.restore(); return;
  }
  /* код типа — на полосе, если она достаточно высокая */
  if (band >= 9) {
    cx.font = `800 ${Math.round(band * .78)}px system-ui`; cx.textAlign = 'left'; cx.textBaseline = 'middle';
    cx.fillStyle = 'rgba(6,10,14,.9)'; cx.fillText(u.rem ? 'ОСТАТКИ' : T.sh, x0 + 5, y0 + band / 2 + .5);
    cx.textBaseline = 'alphabetic';
  }
  const su = Math.min(u.su || 0, u.str), eff = u.str - su;
  if (big) {
    /* шаги точками: целые залиты, подавленные — пустые оранжевые, потерянные — тёмные; пятёрками */
    const gap = W * .03, pr = Math.min((W - 10 - gap) / 20 - .7, 4.2), step = (W - 10 - gap) / 10, py = y0 + H - pr - 3.5, col = strCol(u.str);
    for (let i = 0; i < 10; i++) {
      const px = x0 + 5 + step * (i + .5) + (i >= 5 ? gap : 0);
      cx.beginPath(); cx.arc(px, py, pr, 0, 7);
      if (i < eff) { cx.fillStyle = col; cx.fill(); cx.lineWidth = 1; cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.stroke() }
      else if (i < u.str) { cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fill(); cx.lineWidth = 1.4; cx.strokeStyle = '#ffa04a'; cx.stroke() }
      else { cx.fillStyle = 'rgba(0,0,0,.5)'; cx.fill(); cx.lineWidth = 1; cx.strokeStyle = 'rgba(255,255,255,.12)'; cx.stroke() }
    }
  } else {
    /* на среднем масштабе точки не разглядеть: цифра действующих шагов и шкала */
    const fs = Math.round(clamp(W * .34, 10, 17));
    cx.font = `800 ${fs}px system-ui,sans-serif`; cx.textAlign = 'left'; cx.lineJoin = 'round';
    const ty = bodyY + (bodyH - 5) / 2 + fs * .36;
    cx.lineWidth = 3; cx.strokeStyle = 'rgba(0,0,0,.8)'; cx.strokeText(eff, x0 + 3.5, ty); cx.fillStyle = su ? '#ffa04a' : strCol(u.str); cx.fillText(eff, x0 + 3.5, ty);
    const bw = (W - 6) / 10;
    for (let i = 0; i < 10; i++) { cx.fillStyle = i < eff ? strCol(u.str) : i < u.str ? '#ffa04a' : 'rgba(255,255,255,.1)'; cx.fillRect(x0 + 3 + i * bw + .5, y0 + H - 4.2, bw - 1, 2.4) }
  }
  /* запасы: три деления на полосе справа */
  if (u.sp !== undefined && G.phase === 'battle') {
    const pw = Math.max(3, W * .06), ph = Math.max(2.5, band * .36);
    for (let i = 0; i < 3; i++) {
      cx.fillStyle = i < u.sp ? (u.sp <= 1 ? '#ff6b55' : u.sp === 2 ? '#ffd479' : '#2fa35a') : 'rgba(6,10,14,.85)';
      cx.fillRect(x0 + W - 5 - (3 - i) * (pw + 1.5), y0 + band / 2 - ph / 2, pw, ph);
    }
  }
  /* опыт: звёзды */
  if (u.xp !== undefined && u.xp >= .3 && big) {
    cx.fillStyle = '#f2c94c'; cx.font = `${Math.round(clamp(W * .12, 8, 12))}px system-ui`; cx.textAlign = 'right';
    cx.fillText('★'.repeat(u.xp >= .6 ? 2 : 1), x0 + W - 4, bodyY + clamp(W * .12, 8, 12) + 1);
  }
  /* окоп: шевроны по числу уровней на левом ребре */
  if (u.ent) {
    const cw = clamp(W * .1, 4, 8), ch = cw * .62, cxm = x0, cy0 = y0 + H * .58;
    cx.lineJoin = 'miter'; cx.lineCap = 'butt';
    for (let i = 0; i < u.ent; i++) {
      const yy = cy0 - i * (ch + 2);
      cx.beginPath(); cx.moveTo(cxm - cw / 2, yy + ch); cx.lineTo(cxm, yy); cx.lineTo(cxm + cw / 2, yy + ch);
      cx.lineWidth = 4; cx.strokeStyle = 'rgba(0,0,0,.8)'; cx.stroke();
      cx.lineWidth = 2; cx.strokeStyle = '#e8c97a'; cx.stroke();
    }
  }
  if (!enemy && G.phase === 'battle' && u.mp !== undefined && !G.spec) {
    /* очки хода — полоска под полосой стороны, готовность атаки — точка в углу */
    const k = clamp(u.mp / Math.max(1, T.mp), 0, 1);
    cx.fillStyle = 'rgba(0,0,0,.6)'; cx.fillRect(x0 + 4, bodyY + 3, W * .3, 2.2);
    cx.fillStyle = '#6cc3ff'; cx.fillRect(x0 + 4, bodyY + 3, W * .3 * k, 2.2);
    if (!u.acted && !u.rem && (T.atk.soft || T.bomb) && u.k !== 'hq') { cx.fillStyle = '#ff9f6b'; cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.lineWidth = 1; cx.beginPath(); cx.arc(x0 + W - 1, y0 + 1, 3, 0, 7); cx.fill(); cx.stroke() }
    if (G.isMyTurn && u.mp <= 0 && u.acted) { rr(cx, x0, y0, W, H, R); cx.fillStyle = 'rgba(0,0,0,.42)'; cx.fill() }
  }
  if (u.org !== undefined && u.org < 50) { cx.fillStyle = 'rgba(0,0,0,.7)'; cx.fillRect(x0 + 4, y0 + H + 2, W - 8, 2.5); cx.fillStyle = u.org < 25 ? '#ff5b47' : '#8fb8ff'; cx.fillRect(x0 + 4, y0 + H + 2, (W - 8) * u.org / 100, 2.5) }
  /* значки состояния — столбиком справа от фишки */
  const badges = [];
  if (u.supplied === 0) badges.push(['!', '#ff5b47', 'котёл']);
  if (u.hold) badges.push(['⚓', '#f2b33d']);
  if (u.rear) badges.push(['↶', '#f2b33d']);
  if (u.amb) badges.push(['◉', '#9fe0a8']);
  if (u.prep && !u.moved && !u.acted && !enemy) badges.push(['▲', '#ffd479']);
  if (u.exploit && !u.acted) badges.push(['»', '#9fe0a8']);
  if (u.mil) badges.push(['О', '#e8d8b0']);
  if (u.su) badges.push(['⚡', '#ffa04a']);
  if (u.fu !== undefined && usesFuel(T) && u.fu <= 1) badges.push(['⛽', u.fu ? '#ffd479' : '#ff5b47']);
  if (u.intel) badges.push(['i', '#9fd3f5']);
  if (u.lvl) badges.push([['', 'I', 'II', 'III'][u.lvl] || 'I', u.fed === 0 ? '#ffb070' : '#9fd0ff']);
  if (u.att && SPECS[u.att]) badges.push([SPECS[u.att].sh, '#9fd0ff']);
  const bs = clamp(W * .2, 12, 18);
  badges.forEach(([t, c], i) => {
    const bx = x0 + W + bs * .15, by = y0 + i * (bs + 2);
    cx.fillStyle = 'rgba(6,10,14,.92)'; rr(cx, bx, by, bs, bs, 4); cx.fill();
    cx.strokeStyle = c; cx.lineWidth = 1.2; rr(cx, bx + .5, by + .5, bs - 1, bs - 1, 4); cx.stroke();
    cx.fillStyle = c; cx.font = `800 ${Math.round(bs * (t.length > 1 && t.charCodeAt(0) < 0x2000 ? .5 : .66))}px system-ui`; cx.textAlign = 'center'; cx.fillText(t, bx + bs / 2, by + bs * .72);
  });
  if (u.support && !enemy) { cx.strokeStyle = 'rgba(255,170,100,.85)'; cx.setLineDash([3, 3]); cx.lineWidth = 1.4; rr(cx, x0 - 3.5, y0 - 3.5, W + 7, H + 7, R + 3); cx.stroke(); cx.setLineDash([]) }
  if (u.su) { cx.strokeStyle = `rgba(255,160,60,${.5 + .4 * Math.sin(RT() * 8)})`; cx.lineWidth = 2; rr(cx, x0 - 2, y0 - 2, W + 4, H + 4, R + 2); cx.stroke() }
  cx.restore();
}

/** издалека: плашка с условным знаком рода войск и полоской силы */
function compact(u, q, hw, tone, sel, enemy) {
  const W = clamp(hw * .8, 13, 28), H = W * .8, x0 = q.x - W / 2, y0 = q.y - H / 2;
  cx.fillStyle = 'rgba(0,0,0,.45)'; rr(cx, x0 + 1.5, y0 + 2, W, H, 3); cx.fill();
  rr(cx, x0, y0, W, H, 3);
  cx.fillStyle = tone.box || '#16354a'; cx.fill();
  cx.lineWidth = sel ? 2 : 1; cx.strokeStyle = sel ? '#f2b33d' : tone.bd; if (u.ghost || u.rem) cx.setLineDash([2, 2]); cx.stroke(); cx.setLineDash([]);
  const band = Math.max(2, H * .16);
  cx.fillStyle = tone.top; cx.fillRect(x0 + 1, y0 + 1, W - 2, band);
  /* знак — на всю плашку между полосой стороны и полоской силы */
  const gy = y0 + band + (H - band - 4) / 2 + .5;
  typeGlyph(u.k, q.x, gy, W * .56, (H - band - 5) * .78, tone.gl);
  if (u.ghost) {
    cx.font = `800 ${Math.round(W * .42)}px system-ui`; cx.textAlign = 'center'; cx.fillStyle = '#e9edf0';
    cx.fillText('?', x0 + W + W * .22, y0 + H * .72);
    return;
  }
  /* сила: полоска по низу, подавленная часть — оранжевым */
  const su = Math.min(u.su || 0, u.str), bw = W - 4;
  cx.fillStyle = 'rgba(0,0,0,.6)'; cx.fillRect(x0 + 2, y0 + H - 3.6, bw, 2.4);
  cx.fillStyle = strCol(u.str); cx.fillRect(x0 + 2, y0 + H - 3.6, bw * (u.str - su) / 10, 2.4);
  if (su) { cx.fillStyle = '#ffa04a'; cx.fillRect(x0 + 2 + bw * (u.str - su) / 10, y0 + H - 3.6, bw * su / 10, 2.4) }
  /* окоп — засечки на левом ребре */
  for (let i = 0; i < (u.ent || 0); i++) { cx.fillStyle = '#e8c97a'; cx.fillRect(x0 - 2, y0 + H - 5 - i * 3.4, 3, 2) }
  if (u.supplied === 0) { cx.fillStyle = '#ff5b47'; cx.beginPath(); cx.arc(x0 + W, y0, 2.8, 0, 7); cx.fill() }
  else if (u.sp === 0 || (u.fu === 0 && usesFuel(utFor(u.side)[u.k] || UT.inf))) { cx.fillStyle = '#ff3b2a'; cx.beginPath(); cx.moveTo(x0 + W - 5, y0 + H); cx.lineTo(x0 + W, y0 + H); cx.lineTo(x0 + W, y0 + H - 5); cx.closePath(); cx.fill() }
}
