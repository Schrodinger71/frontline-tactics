'use strict';
/* ============================================================
   ЭФФЕКТЫ БОЯ (клиент)
   ------------------------------------------------------------
   Всё дымное и огненное — клубами из шума (render/smoke-tex.js),
   а не кругами с градиентом:
     разрыв     — вспышка, освещающая землю, огненный шар из рваных
                  клубов (остывает от белого к красному), ударная
                  волна, разлёт искр и комьев, чёрный дым из шара;
     воронка    — рваное пятно гари, светлый выброс грунта лучами,
                  тёмная чаша с тенью; тлеет первые секунды, потом
                  несколько ходов медленно выцветает;
     шлейф      — после разрыва дым поднимается и тянется по ветру;
     перестрелка — очереди трассеров с вспышками у стволов и искрами
                  попаданий; у танков и ПТ — один тяжёлый трассер;
     снаряд     — дуга со светящейся головкой и дымным следом;
     РСЗО       — залп ракет с яркими факелами и густыми следами;
     авиация    — самолёт с тенью на земле и инверсионным следом,
                  зенитки — трассы вверх и разрывы в воздухе;
     пожары     — языки пламени, зарево и столб дыма по ветру.
   Время эффектов — реальное (RT), следы на земле живут по ходам.
   ============================================================ */

const RT = () => performance.now() / 1000;
const FX = [];          /* живые эффекты */
const SCORCH = [];      /* воронки: { x, y, turn, pw, seed, t0 } */
const PLUMES = [];      /* шлейфы дыма: { x, y, t0, d, pw, seed, dark } */
const hsh = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x) };
const zk = () => clamp(G.view.s / 4.5, .55, 2.6);

/** ветер для дыма и облаков: от погоды и хода, плавно меняется */
function windVec() {
  const t = G.turn || 0, wx = G.weather;
  const v = wx === 'storm' ? 1.6 : wx === 'rain' || wx === 'snow' ? 1.1 : wx === 'fog' ? .25 : .7;
  const a = (hsh(Math.floor(t / 3), 7) * 6.283) + Math.sin(RT() * .05) * .2;
  return { x: Math.cos(a) * v, y: Math.sin(a) * v * .6 - .15, v, a };
}

function fxAdd(o) { o.t0 = o.t0 || RT(); FX.push(o); if (FX.length > 260) FX.shift(); return o }
function fxReset() { FX.length = 0; SCORCH.length = 0; PLUMES.length = 0 }

/** точка вокруг центра клетки — разрывы и воронки видны рядом с фишкой, а не под ней */
function ringPt(c, r0, r1) { const a = Math.random() * 6.283, r = r0 + Math.random() * (r1 - r0); return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * .8 } }
/** разрыв на земле: вспышка сейчас, воронка и шлейф — после */
function fxBoom(p, pw, delay, opt) {
  const t0 = RT() + (delay || 0), seed = Math.random() * 1000;
  fxAdd({ k: 'boom', x: p.x, y: p.y, pw, t0, d: 1.5 + pw * .5, seed });
  if (!(opt && opt.noMark)) SCORCH.push({ x: p.x, y: p.y, turn: G.turn, pw, seed, t0 });
  PLUMES.push({ x: p.x, y: p.y, t0, d: 6 + pw * 5, pw, seed, dark: pw > .8 });
  if (SCORCH.length > 420) SCORCH.splice(0, SCORCH.length - 420);
  if (PLUMES.length > 70) PLUMES.splice(0, PLUMES.length - 70);
  setTimeout(() => shakeFrom(p, pw), (delay || 0) * 1000);
}

/* ---------- воронки ---------- */
function drawScorch() {
  const s = G.view.s, now = RT();
  for (let i = SCORCH.length - 1; i >= 0; i--) {
    const b = SCORCH[i], age = (G.turn - b.turn) / 8;
    if (age >= 1) { SCORCH.splice(i, 1); continue }
    if (now < b.t0) continue;
    const q = w2s(b);
    if (!onScreen(q, 60)) continue;
    const R = clamp(s * 1.1 * b.pw, 5, 40), a = (1 - age) * .9, sd = b.seed | 0;
    cx.save(); cx.translate(q.x, q.y);
    /* гарь вокруг: рваное пятно */
    SmokeTex.draw(cx, sd, 0, 0, R * 2.4, a * .75, [26, 20, 14], hsh(b.seed, 1) * 6.28, 1.3);
    SmokeTex.draw(cx, sd + 2, R * .2, -R * .1, R * 1.6, a * .65, [16, 12, 9], hsh(b.seed, 2) * 6.28, 1.15);
    /* выброс грунта лучами */
    if (R > 4) {
      cx.strokeStyle = `rgba(120,102,76,${a * .5})`; cx.lineWidth = Math.max(1, R * .12); cx.lineCap = 'round';
      cx.beginPath();
      for (let k = 0; k < 9; k++) {
        const an = hsh(b.seed, k + 5) * 6.28, r0 = R * .7, r1 = R * (1.2 + hsh(k, b.seed) * .9);
        cx.moveTo(Math.cos(an) * r0, Math.sin(an) * r0 * .8); cx.lineTo(Math.cos(an) * r1, Math.sin(an) * r1 * .8);
      }
      cx.stroke();
    }
    /* чаша: светлый бруствер, тёмное дно с тенью от света с северо-запада */
    cx.fillStyle = `rgba(112,96,72,${a * .75})`; cx.beginPath(); cx.ellipse(0, 0, R * .78, R * .62, 0, 0, 7); cx.fill();
    cx.fillStyle = `rgba(14,10,8,${a * .9})`; cx.beginPath(); cx.ellipse(R * .06, R * .05, R * .58, R * .44, 0, 0, 7); cx.fill();
    cx.fillStyle = `rgba(48,38,28,${a * .7})`; cx.beginPath(); cx.ellipse(R * .14, R * .12, R * .34, R * .24, 0, 0, 7); cx.fill();
    /* тлеет первые секунды */
    const e = now - b.t0;
    if (e < 5) {
      cx.globalCompositeOperation = 'lighter';
      const fl = (1 - e / 5) * (.6 + .4 * Math.sin(now * 9 + b.seed));
      const g = cx.createRadialGradient(0, 0, 0, 0, 0, R);
      g.addColorStop(0, `rgba(255,120,40,${.6 * fl})`); g.addColorStop(1, 'rgba(255,60,20,0)');
      cx.fillStyle = g; cx.beginPath(); cx.arc(0, 0, R, 0, 7); cx.fill();
    }
    cx.restore();
  }
}

/* ---------- шлейфы дыма ---------- */
function drawPlumes() {
  const w = windVec(), now = RT(), Z = zk(), wa = Math.atan2(w.y, w.x);
  for (let i = PLUMES.length - 1; i >= 0; i--) {
    const b = PLUMES[i], age = (now - b.t0) / b.d;
    if (age >= 1) { PLUMES.splice(i, 1); continue }
    if (age < 0) continue;
    const q = w2s(b);
    if (!onScreen(q, 240)) continue;
    const dens = Math.pow(1 - age, 1.3) * (b.dark ? .9 : .7), dark = clamp(1 - age * 2.4, 0, 1);
    const cr = Math.round(lerp(150, 58, dark * (b.dark ? 1 : .6))), cg = Math.round(lerp(146, 52, dark * (b.dark ? 1 : .6))), cb = Math.round(lerp(140, 48, dark * (b.dark ? 1 : .6)));
    const R = 11 * b.pw * Z, L = R * 8 * clamp(.25 + age * 3, .25, 1), N = 12;
    for (let k = 0; k < N; k++) {
      const ph = (now * .07 + k / N + hsh(b.seed, k) * .1) % 1;
      const r = R * (.55 + ph * 2.3) * (.8 + .4 * hsh(b.seed, k + 3));
      const wob = Math.sin(now * .5 + k * 1.7 + b.seed) * R * .35 * ph;
      const sx = q.x + w.x * ph * L - w.y * wob, sy = q.y + w.y * ph * L + w.x * wob - ph * R * 1.4;
      const a = dens * (1 - ph) * Math.min(1, ph * 5 + .2) * (.7 + .45 * hsh(k, b.seed));
      if (a < .01) continue;
      SmokeTex.draw(cx, k + (b.seed | 0), sx, sy, r * 1.25, a, [cr, cg, cb], wa + hsh(b.seed, k) * 6.28 + now * .05 * (k % 2 ? 1 : -1), 1 + ph * .6);
    }
  }
}

/* ---------- разрыв ---------- */
function drawBoom(f, k) {
  const a = w2s(f), s = G.view.s, pw = f.pw;
  const R0 = clamp(s * 3.2 * pw, 9 + 12 * pw, 120);
  cx.save();
  cx.globalCompositeOperation = 'lighter';
  if (k < .08) {
    const fk = 1 - k / .08, rr = R0 * 3.6;
    const g = cx.createRadialGradient(a.x, a.y, 0, a.x, a.y, rr);
    g.addColorStop(0, `rgba(255,250,235,${.95 * fk})`); g.addColorStop(.25, `rgba(255,210,150,${.45 * fk})`); g.addColorStop(1, 'rgba(255,160,80,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(a.x, a.y, rr, 0, 7); cx.fill();
  }
  {
    const gk = Math.pow(1 - k, 2), rr = R0 * 2.1;
    const g = cx.createRadialGradient(a.x, a.y, 0, a.x, a.y, rr);
    g.addColorStop(0, `rgba(255,140,50,${.4 * gk})`); g.addColorStop(1, 'rgba(255,90,30,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(a.x, a.y, rr, 0, 7); cx.fill();
  }
  const grow = 1 - Math.exp(-k * 9), heat = clamp(1 - k * 2.2, 0, 1);
  for (let i = 0; i < 6 && heat > 0; i++) {
    const an = hsh(f.seed + i, 1) * 6.28, d = R0 * .45 * hsh(i, f.seed) * grow;
    const bx = a.x + Math.cos(an) * d, by = a.y + Math.sin(an) * d - grow * R0 * .3 * hsh(f.seed, i);
    const r = R0 * (.3 + .55 * grow) * (.6 + .5 * hsh(i + 7, f.seed));
    SmokeTex.draw(cx, i + 2, bx, by, r * 1.3, .85 * heat, [255, Math.round(110 + 70 * heat), Math.round(30 + 40 * heat)], an + k * 2, 1.1);
    SmokeTex.draw(cx, i + 4, bx, by, r * .75, .8 * heat * heat, [255, Math.round(215 + 40 * heat), Math.round(150 + 90 * heat)], -an, 1);
  }
  if (k < .55) {
    const n = Math.round(8 + 7 * pw), sk = 1 - k / .55;
    cx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const an = hsh(i, f.seed * 3.1) * 6.28, sp = .5 + hsh(f.seed * 1.7, i) * .8;
      const d1 = R0 * 2.6 * sp * (1 - Math.exp(-k * 6)), d0 = d1 * (.55 + .35 * hsh(i + 5, f.seed));
      const fall = k * k * R0 * 1.2;
      cx.strokeStyle = `rgba(255,${Math.round(150 + 90 * sk)},${Math.round(60 + 80 * sk)},${.85 * sk})`;
      cx.lineWidth = 1.1 + sk;
      cx.beginPath(); cx.moveTo(a.x + Math.cos(an) * d0, a.y + Math.sin(an) * d0 * .8 + fall * .6); cx.lineTo(a.x + Math.cos(an) * d1, a.y + Math.sin(an) * d1 * .8 + fall); cx.stroke();
    }
  }
  cx.restore();
  /* комья земли — тёмные, обычным смешиванием */
  if (k < .6) {
    const sk = 1 - k / .6;
    cx.fillStyle = `rgba(38,30,22,${.8 * sk})`;
    for (let i = 0; i < 10; i++) {
      const an = hsh(i + 11, f.seed) * 6.28, d = R0 * 1.8 * (1 - Math.exp(-k * 5)) * (.4 + hsh(f.seed, i + 11));
      const sz = Math.max(1.5, R0 * .07 * (1 + hsh(i, 3)));
      cx.fillRect(a.x + Math.cos(an) * d - sz / 2, a.y + Math.sin(an) * d * .7 - Math.sin(k * Math.PI) * R0 * .6 * hsh(i, 9), sz, sz);
    }
  }
  if (k > .12) {
    const sk = clamp((k - .12) / .88, 0, 1), sa = Math.sin(sk * Math.PI) * .6;
    for (let i = 0; i < 5; i++) {
      const an = hsh(i + 3, f.seed) * 6.28, d = R0 * .5 * hsh(f.seed, i + 3);
      const bx = a.x + Math.cos(an) * d, by = a.y + Math.sin(an) * d - sk * R0 * .8;
      const r = R0 * (.5 + .7 * sk) * (.7 + .4 * hsh(i, f.seed + 2));
      SmokeTex.draw(cx, i, bx, by, r * 1.3, sa, [44, 38, 34], an + sk, 1.15);
    }
  }
  if (k < .3) {
    const wk = k / .3;
    cx.strokeStyle = `rgba(255,240,220,${(1 - wk) * .45})`; cx.lineWidth = 1 + (1 - wk) * 1.5;
    cx.beginPath(); cx.ellipse(a.x, a.y, R0 * (.6 + wk * 4), R0 * (.6 + wk * 4) * .78, 0, 0, 7); cx.stroke();
  }
}

/** разрыв в воздухе: зенитка */
function drawFlak(f, k) {
  const a = w2s(f), R0 = clamp(G.view.s * 1.1, 7, 24);
  cx.save(); cx.globalCompositeOperation = 'lighter';
  if (k < .15) {
    const fk = 1 - k / .15, rr = R0 * 2.4;
    const g = cx.createRadialGradient(a.x, a.y, 0, a.x, a.y, rr);
    g.addColorStop(0, `rgba(255,252,240,${fk})`); g.addColorStop(.3, `rgba(255,200,120,${.6 * fk})`); g.addColorStop(1, 'rgba(255,140,60,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(a.x, a.y, rr, 0, 7); cx.fill();
  }
  cx.restore();
  const sk = clamp(k / .3, 0, 1), r = R0 * (.4 + .8 * sk);
  SmokeTex.draw(cx, (f.seed * 7) | 0, a.x, a.y, r * 1.3, (1 - k) * .65, [70, 68, 66], f.seed + k, 1.1);
}

/* ---------- трассеры ---------- */
function drawTracers(f, k) {
  const a = w2s(f.a), b = w2s(f.b), L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const heavy = f.heavy, n = heavy ? 2 : 7, col = f.col || (heavy ? '255,220,150' : '255,206,110');
  cx.save(); cx.globalCompositeOperation = 'lighter'; cx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const t0 = i / n * (heavy ? .45 : .7), t = (k - t0) / (heavy ? .22 : .16);
    if (t < 0 || t > 1.25) continue;
    const jit = (hsh(i, f.seed) - .5) * clamp(G.view.s * 1.2, 4, 14);
    const sx = a.x - uy * jit * .3, sy = a.y + ux * jit * .3, ex = b.x - uy * jit, ey = b.y + ux * jit;
    const p1 = clamp(t, 0, 1), p0 = clamp(t - (heavy ? .35 : .22), 0, 1);
    const g = cx.createLinearGradient(sx + (ex - sx) * p0, sy + (ey - sy) * p0, sx + (ex - sx) * p1, sy + (ey - sy) * p1);
    g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},.95)`);
    cx.strokeStyle = g; cx.lineWidth = heavy ? 3.2 : 1.7;
    cx.beginPath(); cx.moveTo(sx + (ex - sx) * p0, sy + (ey - sy) * p0); cx.lineTo(sx + (ex - sx) * p1, sy + (ey - sy) * p1); cx.stroke();
    /* вспышка у ствола */
    if (t < .25) {
      const fk = 1 - t / .25, rr = (heavy ? 16 : 8) * fk + 2;
      const mg = cx.createRadialGradient(sx, sy, 0, sx, sy, rr);
      mg.addColorStop(0, `rgba(255,240,200,${.9 * fk})`); mg.addColorStop(1, 'rgba(255,160,60,0)');
      cx.fillStyle = mg; cx.beginPath(); cx.arc(sx + ux * rr * .3, sy + uy * rr * .3, rr, 0, 7); cx.fill();
    }
    /* искры попадания */
    if (t > 1 && t < 1.25) {
      const sk = 1 - (t - 1) / .25;
      cx.fillStyle = `rgba(255,220,140,${sk})`;
      for (let q = 0; q < (heavy ? 7 : 3); q++) {
        const an = Math.atan2(-uy, -ux) + (hsh(q, i + f.seed) - .5) * 2.4, d = (1 - sk) * (heavy ? 18 : 9) * (.5 + hsh(i, q));
        cx.fillRect(ex + Math.cos(an) * d - 1, ey + Math.sin(an) * d - 1, 2, 2);
      }
    }
  }
  cx.restore();
  /* пыль у тяжёлого выстрела */
  if (heavy && k < .7) SmokeTex.draw(cx, (f.seed | 0) % 6, a.x - ux * 6, a.y - uy * 6, clamp(G.view.s * 2, 8, 28) * (.6 + k), (1 - k / .7) * .4, [120, 112, 96], f.seed, 1.4);
}

/* ---------- снаряд по дуге ---------- */
function arcPt(a, b, t, hk) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * L * hk };
}
function drawShell(f, k) {
  const a = w2s(f.a), b = w2s(f.b);
  const rk = f.rocket;
  const list = rk ? [0, 1, 2, 3, 4, 5] : [0];
  cx.save();
  for (const i of list) {
    const off = rk ? (i - 2.5) * clamp(G.view.s * .9, 3, 10) : 0, dl = rk ? i * .06 : 0;
    const t = clamp((k - dl) / (1 - .36), 0, 1);
    if (t <= 0 || t >= 1) continue;
    const A = { x: a.x + off * .4, y: a.y + off * .3 }, B = { x: b.x + off, y: b.y + off * .5 };
    const hk = rk ? .22 : .32;
    /* след */
    for (let j = 1; j <= (rk ? 8 : 5); j++) {
      const tt = t - j * (rk ? .035 : .03);
      if (tt <= 0) break;
      const p = arcPt(A, B, tt, hk);
      SmokeTex.draw(cx, j + i, p.x, p.y, (rk ? 5 : 3) + j * (rk ? 1.6 : .9), (rk ? .32 : .2) * (1 - j / 9), rk ? [190, 186, 180] : [170, 168, 164], j + i, 1.2);
    }
    const p = arcPt(A, B, t, hk);
    cx.globalCompositeOperation = 'lighter';
    const g = cx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rk ? 9 : 5);
    g.addColorStop(0, 'rgba(255,248,220,1)'); g.addColorStop(.4, rk ? 'rgba(255,170,80,.8)' : 'rgba(255,220,150,.6)'); g.addColorStop(1, 'rgba(255,120,40,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(p.x, p.y, rk ? 9 : 5, 0, 7); cx.fill();
    cx.globalCompositeOperation = 'source-over';
  }
  /* залп: вспышки на позиции */
  if (k < .2) {
    cx.globalCompositeOperation = 'lighter';
    const fk = 1 - k / .2, rr = (rk ? 26 : 18) * fk + 4;
    const g = cx.createRadialGradient(a.x, a.y, 0, a.x, a.y, rr);
    g.addColorStop(0, `rgba(255,236,190,${fk})`); g.addColorStop(1, 'rgba(255,150,60,0)');
    cx.fillStyle = g; cx.beginPath(); cx.arc(a.x, a.y, rr, 0, 7); cx.fill();
  }
  cx.restore();
}

/* ---------- авиация ---------- */
function drawPlane(f, k) {
  const q = w2s(f.p), dir = f.dir || 1, span = Math.max(CW, CH) * .7;
  const x = q.x + (k - .5) * span * 2 * dir, y = q.y - 26 - (1 - Math.sin(k * Math.PI)) * 40;
  const W = clamp(G.view.s * 9, 44, 90);
  /* инверсионный след */
  cx.save();
  for (let j = 1; j < 10; j++) {
    const tx = x - dir * j * W * .32;
    SmokeTex.draw(cx, j, tx, y + 2, 4 + j * 1.3, .22 * (1 - j / 10), [235, 238, 242], 0, 2);
  }
  /* тень на земле */
  cx.globalAlpha = .35;
  cx.fillStyle = '#000';
  cx.beginPath(); cx.ellipse(x - dir * 18, q.y + 18, W * .32, W * .1, 0, 0, 7); cx.fill();
  cx.globalAlpha = 1;
  cx.translate(x, y); if (dir < 0) cx.scale(-1, 1);
  drawIcon(cx, f.icon || 'jet', 0, 0, W, f.theme || 'own', false);
  cx.restore();
}
/** парашюты с грузом */
function drawDrop(f, k) {
  const q = w2s(f.p);
  for (let i = 0; i < 3; i++) {
    const t = clamp((k - .25 - i * .08) / .6, 0, 1);
    if (t <= 0) continue;
    const x = q.x + (i - 1) * 14 + Math.sin(t * 6 + i) * 4, y = q.y - 60 * (1 - t);
    const a = t > .95 ? (1 - t) / .05 : 1;
    cx.globalAlpha = a;
    cx.fillStyle = '#e8e2d0'; cx.strokeStyle = '#2a2a24'; cx.lineWidth = 1;
    cx.beginPath(); cx.arc(x, y - 10, 7, Math.PI, 0); cx.closePath(); cx.fill(); cx.stroke();
    cx.beginPath(); cx.moveTo(x - 7, y - 10); cx.lineTo(x, y); cx.lineTo(x + 7, y - 10); cx.stroke();
    cx.fillStyle = '#7a6a48'; cx.fillRect(x - 3, y - 1, 6, 5);
    cx.globalAlpha = 1;
  }
}

/* ---------- захват точки ---------- */
function drawCapture(f, k) {
  const c = Hex.center(f.hex);
  for (let i = 0; i < 2; i++) {
    const t = clamp(k * 1.3 - i * .2, 0, 1);
    if (t <= 0) continue;
    const cs = Hex.corners(f.hex, .9 + t * .9).map(w2s);
    cx.beginPath(); cs.forEach((p, j) => j ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)); cx.closePath();
    cx.strokeStyle = `rgba(${f.col},${(1 - t) * .9})`; cx.lineWidth = 3 - i; cx.stroke();
  }
  if (k < .5) { const q = w2s(c); const g = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, Hex.R * G.view.s * 1.5); g.addColorStop(0, `rgba(${f.col},${.35 * (1 - k * 2)})`); g.addColorStop(1, `rgba(${f.col},0)`); cx.fillStyle = g; cx.fillRect(q.x - 200, q.y - 200, 400, 400) }
}

function drawFxList() {
  const now = RT();
  for (let i = FX.length - 1; i >= 0; i--) if (now - FX[i].t0 > FX[i].d) FX.splice(i, 1);
  for (const f of FX) {
    const k = (now - f.t0) / f.d;
    if (k < 0 || k > 1) continue;
    if (f.k === 'boom') drawBoom(f, k);
    else if (f.k === 'flak') drawFlak(f, k);
    else if (f.k === 'tracer') drawTracers(f, k);
    else if (f.k === 'shell') drawShell(f, k);
    else if (f.k === 'plane') drawPlane(f, k);
    else if (f.k === 'drop') drawDrop(f, k);
    else if (f.k === 'capture') drawCapture(f, k);
  }
}

/* ---------- пожары: языки пламени и дым ---------- */
function flameTongue(x, y, w, h, sway) {
  cx.beginPath();
  cx.moveTo(x - w / 2, y);
  cx.bezierCurveTo(x - w * .62, y - h * .45, x - w * .15 + sway * .5, y - h * .7, x + sway, y - h);
  cx.bezierCurveTo(x + w * .2 + sway * .5, y - h * .68, x + w * .62, y - h * .42, x + w / 2, y);
  cx.quadraticCurveTo(x, y + w * .32, x - w / 2, y);
  cx.closePath();
}
function drawFire(p, f, k, seed) {
  const q = w2s(p);
  if (!onScreen(q, 160)) return;
  const T = RT(), w = windVec(), Z = clamp(G.view.s / 5, .55, 1.8);
  const R = (4 + f * 8) * k * Z;
  const wa = Math.atan2(w.y - 1.2, w.x);
  for (let i = 0; i < 12; i++) {
    const ph = (T * .14 + i / 12 + seed) % 1;
    const r = R * (.55 + ph * 1.7);
    const sx = q.x + w.x * ph * R * 3.6 + Math.sin(seed + i) * R * .25, sy = q.y - R * .7 - ph * R * 4.6 + w.y * ph * R * 1.6;
    const c = Math.round(56 + ph * 46);
    SmokeTex.draw(cx, i + (seed | 0), sx, sy, r, ((1 - ph) * .55 * f + .08) * Math.min(1, ph * 6), [c, c - 4, c - 8], wa + i * 1.3 + T * .05 * (i % 2 ? 1 : -1), 1 + ph * .5);
  }
  cx.save();
  cx.globalCompositeOperation = 'lighter';
  const gr = R * 2.6, g0 = cx.createRadialGradient(q.x, q.y, 0, q.x, q.y, gr);
  g0.addColorStop(0, `rgba(255,120,40,${.14 + .14 * f})`); g0.addColorStop(1, 'rgba(255,90,30,0)');
  cx.fillStyle = g0; cx.beginPath(); cx.ellipse(q.x, q.y, gr, gr * .6, 0, 0, 7); cx.fill();
  cx.globalCompositeOperation = 'source-over';
  const n = 1 + Math.round(f * 2);
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * R * .38;
    const fl = .75 + .25 * Math.sin(T * (7 + i * 1.7) + seed + i * 2.3) * Math.sin(T * 4.3 + i);
    const hh = R * (1.7 + (i % 2 ? .2 : .6)) * fl, ww = R * .55, sway = Math.sin(T * 5 + i + seed) * R * .18 + w.x * R * .4;
    const go = cx.createLinearGradient(0, q.y, 0, q.y - hh);
    go.addColorStop(0, 'rgba(255,160,55,.85)'); go.addColorStop(.5, 'rgba(235,85,30,.6)'); go.addColorStop(1, 'rgba(160,30,10,0)');
    cx.fillStyle = go; flameTongue(q.x + off, q.y, ww, hh, sway); cx.fill();
    const gi = cx.createLinearGradient(0, q.y, 0, q.y - hh * .6);
    gi.addColorStop(0, 'rgba(255,246,205,.9)'); gi.addColorStop(.6, 'rgba(255,200,90,.5)'); gi.addColorStop(1, 'rgba(255,160,60,0)');
    cx.fillStyle = gi; flameTongue(q.x + off, q.y, ww * .45, hh * .62, sway * .6); cx.fill();
  }
  for (let i = 0; i < 3 + Math.round(f * 5); i++) {
    const ph = (T * .7 + i * .37 + seed) % 1;
    cx.fillStyle = `rgba(255,${190 + (i * 13) % 60},90,${(1 - ph) * .9})`;
    cx.fillRect(q.x + Math.sin(seed * 3 + i * 1.9) * R * .6 + w.x * ph * R * 2, q.y - R * .6 - ph * R * 3, 1.6, 1.6);
  }
  cx.restore();
}

/* ---------- дрожь экрана ---------- */
let SHAKE = 0;
function shakeFrom(p, pw) {
  if (!SCREEN.shake) return;
  const q = w2s(p), far = Math.hypot((q.x - CW / 2) / (CW / 2), (q.y - CH / 2) / (CH / 2));
  const z = clamp((G.view.s - 2) / 8, 0, 1);
  const k = clamp(1 - far * .8, 0, 1) * (.35 + .65 * z) * pw;
  if (k > .12) SHAKE = Math.max(SHAKE, k * 8);
}
function applyShake(dt) {
  if (SHAKE < .2) { if (cv.style.transform) cv.style.transform = ''; SHAKE = 0; return }
  cv.style.transform = `translate(${((Math.random() - .5) * SHAKE).toFixed(1)}px,${((Math.random() - .5) * SHAKE).toFixed(1)}px)`;
  SHAKE *= Math.pow(.015, dt);
}
