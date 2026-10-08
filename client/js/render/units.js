'use strict';
/* ============================================================
   ФИШКИ ЧАСТЕЙ (клиент)
   ------------------------------------------------------------
   Фишка — как на штабной карте: плашка в тонах стороны с цветной
   полосой сверху, иконка техники, сила крупной цифрой и шкалой
   из десяти делений, окоп — мешками с песком под фишкой, запасы —
   тремя делениями, значки состояния (котёл, «насмерть», засада,
   подавлены, прорыв, опыт). Под фишкой — тень, у выбранной —
   золотое свечение.
   Масштаб решает, сколько деталей: издалека — компактная метка
   с силой, вблизи — всё.
   ============================================================ */

const SIDE_TONE = {
  own: { top: '#5fb6f0', g0: 'rgba(30,48,62,.96)', g1: 'rgba(10,18,26,.96)', bd: '#6cc3ff', txt: '#e6f3fb' },
  enemy: { top: '#ff6b55', g0: 'rgba(64,30,24,.96)', g1: 'rgba(26,12,10,.96)', bd: '#ff8a72', txt: '#fde6dc' },
  ghost: { top: '#a08070', g0: 'rgba(40,26,20,.55)', g1: 'rgba(20,12,10,.55)', bd: '#b08a78', txt: '#e8d0c4' }
};
const strCol = s => s <= 3 ? '#ff6b55' : s <= 6 ? '#ffd479' : '#8fe0a2';

function counter(u, q, alpha, scale) {
  const s = G.view.s, hw = Hex.HW * s * (scale || 1);
  const enemy = G.spec ? u.side === S : u.side !== G.side, T = UT[u.k] || UT.inf, ghost = u.ghost;
  const tone = SIDE_TONE[ghost ? 'ghost' : enemy ? 'enemy' : 'own'];
  const sel = u.id === G.sel && !ghost;
  cx.save();
  if (alpha !== undefined) cx.globalAlpha = alpha;
  if (hw < 34) { compact(u, q, hw, tone, sel, enemy); cx.restore(); return }
  const W = clamp(hw * .8, 30, 108), H = W * .74, x0 = q.x - W / 2, y0 = q.y - H / 2 - H * .04, R = Math.min(7, H * .16);
  /* окоп: мешки с песком полукругом под фишкой */
  if (u.ent && !ghost) {
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
  cx.fillStyle = tone.top; cx.globalAlpha *= ghost ? .4 : .92; cx.fillRect(x0, y0, W, band); cx.restore();
  cx.lineWidth = sel ? 2.4 : 1.2; cx.strokeStyle = sel ? '#f2b33d' : tone.bd;
  if (ghost) cx.setLineDash([4, 3]);
  rr(cx, x0 + .5, y0 + .5, W - 1, H - 1, R); cx.stroke(); cx.setLineDash([]);
  cx.strokeStyle = 'rgba(255,255,255,.08)'; cx.lineWidth = 1;
  cx.beginPath(); cx.moveTo(x0 + R, y0 + band + 1.5); cx.lineTo(x0 + W - R, y0 + band + 1.5); cx.stroke();
  const big = W >= 50;
  /* иконка: крупная по центру или поменьше справа, чтобы не спорила с цифрой */
  if (big) drawIcon(cx, u.k || 'unk', q.x + W * .1, y0 + band + (H - band) * .55, W * .64, ghost ? 'ghost' : enemy ? 'enemy' : 'own', u.side === S);
  else drawIcon(cx, u.k || 'unk', x0 + W * .74, y0 + band + (H - band) * .5, W * .46, ghost ? 'ghost' : enemy ? 'enemy' : 'own', u.side === S);
  if (ghost) {
    cx.fillStyle = '#f0d0c0'; cx.font = `600 ${Math.round(clamp(W * .13, 9, 12))}px system-ui`; cx.textAlign = 'center';
    cx.fillText(u.age ? u.age + ' х. назад' : 'был здесь', q.x, y0 + H + 12);
    cx.restore(); return;
  }
  /* код типа — на полосе, если она достаточно высокая */
  if (band >= 9) {
    cx.font = `800 ${Math.round(band * .78)}px system-ui`; cx.textAlign = 'left'; cx.textBaseline = 'middle';
    cx.fillStyle = 'rgba(6,10,14,.9)'; cx.fillText(T.sh, x0 + 5, y0 + band / 2 + .5);
    cx.textBaseline = 'alphabetic';
  }
  /* сила: крупная цифра слева */
  const fs = Math.round(clamp(W * (big ? .26 : .31), 10, 24));
  cx.font = `800 ${fs}px system-ui,sans-serif`; cx.textAlign = 'left'; cx.lineJoin = 'round';
  const ty = y0 + band + (H - band - 7) / 2 + fs * .36;
  cx.lineWidth = 3; cx.strokeStyle = 'rgba(0,0,0,.8)'; cx.strokeText(u.str, x0 + 4, ty); cx.fillStyle = strCol(u.str); cx.fillText(u.str, x0 + 4, ty);
  /* шкала силы: 10 делений по низу */
  const bw = (W - 8) / 10;
  for (let i = 0; i < 10; i++) { cx.fillStyle = i < u.str ? strCol(u.str) : 'rgba(255,255,255,.1)'; cx.fillRect(x0 + 4 + i * bw + .5, y0 + H - 4.6, bw - 1, 2.4) }
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
    cx.fillText('★'.repeat(u.xp >= .6 ? 2 : 1), x0 + W - 4, y0 + H - 7.5);
  }
  if (!enemy && G.phase === 'battle' && u.mp !== undefined && !G.spec) {
    /* очки хода — полоска над шкалой силы, готовность атаки — точка в углу */
    const k = clamp(u.mp / T.mp, 0, 1);
    cx.fillStyle = 'rgba(0,0,0,.6)'; cx.fillRect(x0 + 4, y0 + H - 8, W * .3, 2.2);
    cx.fillStyle = '#6cc3ff'; cx.fillRect(x0 + 4, y0 + H - 8, W * .3 * k, 2.2);
    if (!u.acted && (T.atk.soft || T.bomb) && u.k !== 'hq') { cx.fillStyle = '#ff9f6b'; cx.strokeStyle = 'rgba(0,0,0,.7)'; cx.lineWidth = 1; cx.beginPath(); cx.arc(x0 + W - 1, y0 + H - 1, 3, 0, 7); cx.fill(); cx.stroke() }
    if (G.isMyTurn && u.mp <= 0 && u.acted) { rr(cx, x0, y0, W, H, R); cx.fillStyle = 'rgba(0,0,0,.42)'; cx.fill() }
  }
  if (u.org !== undefined && u.org < 50) { cx.fillStyle = 'rgba(0,0,0,.7)'; cx.fillRect(x0 + 4, y0 + H + 2, W - 8, 2.5); cx.fillStyle = u.org < 25 ? '#ff5b47' : '#8fb8ff'; cx.fillRect(x0 + 4, y0 + H + 2, (W - 8) * u.org / 100, 2.5) }
  /* значки состояния — столбиком справа от фишки */
  const badges = [];
  if (u.supplied === 0) badges.push(['!', '#ff5b47', 'котёл']);
  if (u.hold) badges.push(['⚑', '#f2b33d']);
  if (u.amb && !enemy) badges.push(['◉', '#9fe0a8']);
  if (u.exploit && !u.acted) badges.push(['»', '#9fe0a8']);
  if (u.mil) badges.push(['О', '#e8d8b0']);
  if (u.sup) badges.push(['⚡', '#ffa04a']);
  const bs = clamp(W * .2, 12, 18);
  badges.forEach(([t, c], i) => {
    const bx = x0 + W + bs * .15, by = y0 + i * (bs + 2);
    cx.fillStyle = 'rgba(6,10,14,.92)'; rr(cx, bx, by, bs, bs, 4); cx.fill();
    cx.strokeStyle = c; cx.lineWidth = 1.2; rr(cx, bx + .5, by + .5, bs - 1, bs - 1, 4); cx.stroke();
    cx.fillStyle = c; cx.font = `800 ${Math.round(bs * .66)}px system-ui`; cx.textAlign = 'center'; cx.fillText(t, bx + bs / 2, by + bs * .74);
  });
  if (u.support && !enemy) { cx.strokeStyle = 'rgba(255,170,100,.85)'; cx.setLineDash([3, 3]); cx.lineWidth = 1.4; rr(cx, x0 - 3.5, y0 - 3.5, W + 7, H + 7, R + 3); cx.stroke(); cx.setLineDash([]) }
  if (u.sup) { cx.strokeStyle = `rgba(255,160,60,${.5 + .4 * Math.sin(RT() * 8)})`; cx.lineWidth = 2; rr(cx, x0 - 2, y0 - 2, W + 4, H + 4, R + 2); cx.stroke() }
  cx.restore();
}

/** издалека: маленькая плашка с силой */
function compact(u, q, hw, tone, sel, enemy) {
  const W = clamp(hw * .72, 11, 26), H = W * .78, x0 = q.x - W / 2, y0 = q.y - H / 2;
  cx.fillStyle = 'rgba(0,0,0,.45)'; rr(cx, x0 + 1.5, y0 + 2, W, H, 3); cx.fill();
  rr(cx, x0, y0, W, H, 3);
  cx.fillStyle = u.ghost ? 'rgba(60,40,30,.5)' : enemy ? '#5a2219' : '#16354a'; cx.fill();
  cx.lineWidth = sel ? 2 : 1; cx.strokeStyle = sel ? '#f2b33d' : tone.bd; if (u.ghost) cx.setLineDash([2, 2]); cx.stroke(); cx.setLineDash([]);
  cx.fillStyle = tone.top; cx.fillRect(x0 + 1, y0 + 1, W - 2, Math.max(2, H * .18));
  if (u.ghost) return;
  if (W >= 16) {
    cx.font = `800 ${Math.round(W * .5)}px system-ui`; cx.textAlign = 'center';
    cx.fillStyle = strCol(u.str); cx.fillText(u.str, q.x, y0 + H * .86);
  } else { cx.fillStyle = strCol(u.str); cx.fillRect(x0 + 2, y0 + H - 3, (W - 4) * u.str / 10, 2) }
  if (u.supplied === 0) { cx.fillStyle = '#ff5b47'; cx.beginPath(); cx.arc(x0 + W, y0, 2.8, 0, 7); cx.fill() }
}
