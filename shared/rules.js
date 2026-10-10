'use strict';
/* ============================================================
   ПРАВИЛА (общие для сервера и клиента)
   ------------------------------------------------------------
   Движение. Стоимость клетки зависит от подвижности части и
   местности; по дороге (связь RD между клетками) — полклетки.
   Река без моста: колёсные не переходят, гусеничные и пешие —
   только с полным запасом хода и встают на том берегу. Вход в
   зону контроля противника (клетки рядом с его наземной частью)
   останавливает; из зоны в зону — только разведке.

   Бой. Сила атаки (по классу брони цели) и обороны умножаются на
   состав, мораль, опыт и набор факторов — каждый виден в
   предпросмотре: местность, окоп, охват (свои части рядом с целью),
   удар с двух сторон, река, ночь, снабжение, штаб, подавление,
   мины. Отношение сил даёт ожидаемые потери сторон и шанс отхода.
   Клиент считает то же самое, но по тому, что видит.

   Оборона: укрепления (forts: клетка → уровень 1–2) — оборона ×1,25 за
   уровень и держатся дольше; противотанковые заграждения (obst) —
   технике вход стоит всего хода, танки бьют в такую клетку хуже;
   огонь поддержки — своя артиллерия, не стрелявшая в свой ход,
   прикрывает клетки в своей дальности (support: сторона → Set клеток);
   противотанковый дивизион против танков обороняется втрое злее.

   Рельеф: атака в гору (цель выше на 60 м) — ×0,88, на 140 м — ×0,8;
   удар с высоты — ×1,1. Взаимодействие: если цель в этот ход уже
   атаковала часть другого рода (пехота после танков и наоборот) —
   атака ×1,15. Огонь в непогоду точнее не станет: множитель acc погоды.

   ctx — что известно о поле: { map, br (мосты: ключ → 'down' | 'pontoon'),
   occ (клетка → часть), mines (клетка → { side }), forts, obst, support, mud, night, side,
   cmd (клетки под управлением штабов стороны), acc (точность огня по погоде),
   counter (клетки, где действует приказ «Контрудар») }.
   ============================================================ */
(function (g) {
  const node = typeof module !== 'undefined' && module.exports;
  const W = node ? require('./world') : g;
  const Hex = node ? require('./hex') : g.Hex;
  const { UT, MAX_STR, clamp } = W;
  const { RIV, BR, RD } = Hex;

  /* ---------- границы клеток с учётом взорванных мостов и понтонов ---------- */
  function edgeOf(ctx, a, d) {
    let e = ctx.map.edge[a * 6 + d];
    if (!(e & RIV) || !ctx.br) return e;
    const b = ctx.H.nb(a, d), st = ctx.br.get(Hex.edgeKey(a, b));
    if (st === 'down') e &= ~(BR | RD);
    else if (st === 'pontoon') e |= BR;
    return e;
  }
  const crossable = e => !(e & RIV) || (e & BR);

  /* ---------- движение ---------- */
  const TCOST = {
    foot:  { open: 1, forest: 1, hill: 2, city: 1, marsh: 2, mount: 3, lake: Infinity },
    wheel: { open: 1, forest: 3, hill: 2, city: 1, marsh: 5, mount: Infinity, lake: Infinity },
    track: { open: 1, forest: 2, hill: 2, city: 1, marsh: 3, mount: Infinity, lake: Infinity }
  };
  /** стоимость входа в клетку b из a (направление d); Infinity — нельзя */
  function stepCost(ctx, u, a, d, b) {
    const T = UT[u.k], e = edgeOf(ctx, a, d), hx = ctx.map.hexes[b];
    if (hx.t === 'lake') return Infinity;
    if (!crossable(e)) return T.cls === 'wheel' ? Infinity : 'ford';
    /* заграждения: технике — весь ход */
    if (ctx.obst && ctx.obst.has(b) && T.cls !== 'foot') return 'stop';
    if ((e & RD) && T.cls !== 'foot') return .5;
    if ((e & RD) && hx.t === 'mount') return 1;
    let c = TCOST[T.cls][hx.t];
    if (ctx.mud && T.cls !== 'foot' && hx.t !== 'city' && c !== Infinity) c += 1;
    return c;
  }
  /** клетки, где стоит наземная часть противника, и её зона контроля */
  function zocOf(ctx, side) {
    const z = new Set();
    for (const [h, u] of ctx.occ) if (u.side !== side) for (const n of ctx.H.neighbors(h)) z.add(n);
    return z;
  }
  /**
   * куда часть дойдёт за оставшиеся очки хода: Map клетка → { c (потрачено), prev }.
   * Чужие части блокируют, зона контроля останавливает, брод — только с полным запасом.
   */
  function reachable(ctx, u) {
    const T = UT[u.k], out = new Map(), zoc = zocOf(ctx, u.side);
    const mp = u.mp;
    out.set(u.hex, { c: 0, prev: -1 });
    if (mp <= 0) return out;
    const startZoc = zoc.has(u.hex);
    const open = [u.hex];
    while (open.length) {
      open.sort((a, b) => out.get(b).c - out.get(a).c);
      const a = open.pop(), ca = out.get(a).c;
      if (a !== u.hex && zoc.has(a)) continue;          /* в зоне контроля — дальше нельзя */
      if (out.get(a).stop) continue;
      for (let d = 0; d < 6; d++) {
        const b = ctx.H.nb(a, d);
        if (b < 0) continue;
        const occ = ctx.occ.get(b);
        if (occ && occ.side !== u.side) continue;
        if (startZoc && a === u.hex && zoc.has(b) && !T.stl) continue;   /* из зоны в зону — только разведке */
        let c = stepCost(ctx, u, a, d, b), stop = false;
        if (c === Infinity) continue;
        if (c === 'ford') { if (a !== u.hex || mp < T.mp) continue; c = mp; stop = true }
        else if (c === 'stop') { c = Math.max(1, mp - ca); stop = true }
        const nc = ca + c;
        if (nc > mp + 1e-9) continue;
        const was = out.get(b);
        if (was && was.c <= nc) continue;
        out.set(b, { c: nc, prev: a, stop, ford: stop });
        open.push(b);
      }
    }
    /* в клетку со своей частью можно пройти, но не встать */
    for (const [h] of out) { const o = ctx.occ.get(h); if (o && o.id !== u.id) out.get(h).through = 1 }
    return out;
  }
  function pathTo(reach, to) {
    const p = [];
    for (let h = to; h !== -1 && h !== undefined; h = reach.get(h) ? reach.get(h).prev : -1) p.push(h);
    return p.reverse();
  }

  /* ---------- бой ---------- */
  const TDEF = { open: 1, forest: 1.3, hill: 1.35, city: 1.5, marsh: 1.15, mount: 1.8, lake: 1 };
  const TNAME = { open: 'поле', forest: 'лес', hill: 'высота', city: 'город', marsh: 'болото', mount: 'горы', lake: 'озеро' };
  const SUPK = W.SUPPLY;
  const strK = u => u.str / MAX_STR;
  /** действующие шаги: подавленные не воюют до начала своего хода */
  const effStr = u => Math.max(0, u.str - (u.su || 0));
  /** мощность огня части с закрытых позиций (подавленные шаги не стреляют) */
  const firePow = u => { const B = UT[u.k].bomb; return B ? B.pow * effStr(u) / MAX_STR * (.85 + .3 * (u.xp || 0)) * (u.att === 'hvy' ? 1.25 : 1) : 0 };
  const orgK = u => .5 + .5 * clamp(u.org, 0, 100) / 100;
  const xpK = u => 1 + .3 * (u.xp || 0);
  /** местность обороняющегося против атакующего */
  function terrainDef(hx, att, def) {
    let k = TDEF[hx.t];
    if (hx.t === 'forest' && UT[att.k].arm === 'hard') k = 1.6;
    if (hx.t === 'city' && UT[def.k].arm === 'soft') k = 1.9;
    if (hx.t === 'marsh' && UT[att.k].arm !== 'soft') k = 1.4;
    return k;
  }
  /**
   * шансы атаки att по def (соседние клетки). Возвращает силы, множители с подписями,
   * ожидаемые потери [мин, макс] и шанс отхода.
   */
  function odds(ctx, att, def, opt) {
    const TA = UT[att.k], TD = UT[def.k];
    /* обстрел с места (opt.fire): на цель никто не идёт — река, заграждения, мины и заградительный огонь не при чём */
    const fire = !!(opt && opt.fire);
    const hx = ctx.map.hexes[def.hex];
    let A = TA.atk[TD.arm] * strK(att) * orgK(att) * xpK(att), D = TD.def * strK(def) * orgK(def) * xpK(def);
    const mods = [];
    const am = (t, v) => { if (Math.abs(v - 1) > .001) { A *= v; mods.push({ t, v, who: 'a' }) } };
    const dm = (t, v) => { if (Math.abs(v - 1) > .001) { D *= v; mods.push({ t, v, who: 'd' }) } };
    const d = ctx.H.dirTo(att.hex, def.hex);
    if (!fire && d >= 0 && !crossable(edgeOf(ctx, att.hex, d))) am('через реку', .5);
    /* охват: другие свои части рядом с целью; удар с двух сторон */
    let n = 0, opposite = false;
    for (let k = 0; k < 6; k++) {
      const h = ctx.H.nb(def.hex, k), o = h >= 0 && ctx.occ.get(h);
      if (!o || o.side !== att.side || o.id === att.id || !UT[o.k].atk.soft) continue;
      n++;
      if (ctx.H.nb(def.hex, (ctx.H.dirTo(def.hex, att.hex) + 3) % 6) === h) opposite = true;
    }
    if (n) am(`охват (${n})`, Math.min(1.36, 1 + .12 * n));
    if (ctx.counter && ctx.counter.has(def.hex)) am('контрудар', 1.3);
    if (opposite) am('удар с двух сторон', 1.2);
    if (ctx.night && !TA.th) am('ночь', .75);
    /* рельеф: атаковать в гору тяжелее, с высоты — легче */
    const dh = hx.h - ctx.map.hexes[att.hex].h;
    if (dh > 60) am('атака в гору', dh > 140 ? .8 : .88);
    else if (dh < -60) am('удар с высоты', 1.1);
    /* взаимодействие родов войск: цель уже связана боем с частью другого рода */
    const ARMB = { soft: 1, light: 2, hard: 4 }, hb = def.hb || 0;
    if (hb && (hb & ~ARMB[TA.arm])) am('взаимодействие', 1.15);
    /* командование — от штаба своего командира: ctx.cmd это места → клетки сектора */
    const cz = ctx.cmd && (ctx.cmd.get ? ctx.cmd.get(att.seat || att.side) : ctx.cmd);
    if (cz && !cz.has(att.hex)) am('вне штаба', .9);
    else if (cz) am('штаб рядом', 1.1);
    const spA = att.sp === undefined ? 3 : att.sp, spD = def.sp === undefined ? 3 : def.sp;
    if (spA < 3) am(`боеприпасы ${spA}/3`, SUPK.att[spA]);
    if (ctx.smoke && ctx.smoke.has(def.hex)) am('цель в дыму', .8);
    /* подавленные шаги — отдельной строкой, чтобы было видно, сколько их */
    if (att.su) am(`подавлено ${Math.min(att.su, att.str)} из ${att.str}`, effStr(att) / Math.max(1, att.str));
    /* приданные специалисты */
    const fortD = ctx.forts && ctx.forts.get(def.hex);
    if (att.att === 'sap' && (hx.t === 'city' || def.ent || fortD)) am('штурмовые сапёры', 1.3);
    if (att.att === 'atg' && TD.arm !== 'soft') am('ПТ-взвод', 1.2);
    dm(TNAME[hx.t], terrainDef(hx, att, def));
    if (def.ent) dm(`окоп ${def.ent}`, 1 + .2 * def.ent);
    const fort = ctx.forts && ctx.forts.get(def.hex);
    if (fort) dm(`укрепления ${fort}`, 1 + .25 * fort);
    if (!fire && ctx.obst && ctx.obst.has(def.hex) && TA.arm === 'hard') am('заграждения', .75);
    if (TD.atd && TA.arm !== 'soft') dm('противотанковая оборона', 1.8);
    if (!fire && ctx.support && ctx.support[def.side] && ctx.support[def.side].has(def.hex)) dm('огонь поддержки', 1.25);
    if (def.amb) dm('из засады', 1.15);
    if (def.su) dm(`подавлено ${Math.min(def.su, def.str)} из ${def.str}`, effStr(def) / Math.max(1, def.str));
    if (def.att === 'atg' && TA.arm !== 'soft') dm('ПТ-взвод', 1.25);
    if (spD < 2) dm(`боеприпасы ${spD}/3`, SUPK.def[spD]);
    if (def.hold) dm('стоять насмерть', 1.3);
    if (!fire && ctx.mines && ctx.mines.get(def.hex) && ctx.mines.get(def.hex).side === def.side) dm('мины', 1.2);
    const r = A / Math.max(.05, D);
    const Ld = Math.min(6, 2.2 * Math.pow(r, .75)), La = Math.min(5, 1.6 / Math.pow(r, .75));
    const retreat = def.hold ? 0 : r >= 3.5 ? 1 : clamp((r - .9) * .6 + (40 - def.org) / 100 - .1 * (def.ent || 0) - .2 * (fort || 0), 0, .95);
    return {
      A, D, r, mods, retreat,
      lossD: [Math.max(0, Math.round(Ld * .6)), Math.min(def.str, Math.round(Ld * 1.4))],
      lossA: [Math.max(0, Math.round(La * .6)), Math.min(att.str, Math.round(La * 1.4))],
      expD: Ld, expA: La
    };
  }

  /**
   * обстрел: огневой бой с места по соседней цели. Силы и множители — как у атаки
   * (без реки, заграждений, мин и огня поддержки), но эффект меньше, большая его часть —
   * подавленные шаги, ответный огонь слабее; цель не отходит, стреляющий остаётся в окопах.
   */
  function fireOdds(ctx, att, def) {
    const F = W.FIREFIGHT, o = odds(ctx, att, def, { fire: true });
    const L = o.expD * F.dmg, kill = L * F.kill, sup = L * (1 - F.kill) * 2, back = o.expA * F.back;
    return { A: o.A, D: o.D, r: o.r, mods: o.mods, kill, sup, back,
      loss: [Math.max(0, Math.round(kill * .5)), Math.min(def.str, Math.round(kill * 1.5))],
      supp: [Math.round(sup * .6), Math.round(sup * 1.4)],
      lossA: [Math.max(0, Math.round(back * .5)), Math.min(att.str, Math.round(back * 1.5))] };
  }

  /* ---------- артиллерия и авиация ---------- */
  const BDEF = { open: 1, forest: 1.25, hill: 1.2, city: 1.4, marsh: 1, mount: 1.5, lake: 1 };
  const FIRE_KILL = .4;   /* доля потерь в эффекте огня; остальное — подавленные шаги */
  /** ожидаемые потери цели от огня: pow — мощность, from — кто бьёт */
  function bombardOdds(ctx, pow, def, opt) {
    const TD = UT[def.k], hx = ctx.map.hexes[def.hex];
    let P = pow;
    const mods = [];
    const m = (t, v) => { if (Math.abs(v - 1) > .001) { P *= v; mods.push({ t, v }) } };
    m(TNAME[hx.t], 1 / BDEF[hx.t]);
    if (def.ent) m(`окоп ${def.ent}`, 1 / (1 + .25 * def.ent));
    const fort = ctx.forts && ctx.forts.get(def.hex);
    if (fort) m(`укрепления ${fort}`, 1 / (1 + .3 * fort));
    if (TD.arm === 'hard' && !(opt && opt.air)) m('броня', .6);
    if (ctx.night && !(opt && opt.th)) m('ночь', .8);
    if (ctx.acc && ctx.acc < 1) m('погода', ctx.acc);
    if (opt && opt.barrage) m('артподготовка', 1.5);
    if (opt && opt.sp !== undefined && opt.sp < 3) m(`боеприпасы ${opt.sp}/3`, SUPK.att[opt.sp]);
    if (ctx.smoke && ctx.smoke.has(def.hex)) m('цель в дыму', .7);
    if (opt && opt.aaCut && opt.aaCut < 1) m('ПВО над целью', opt.aaCut);
    const L = Math.min((opt && opt.cap) || 5, P * .14);
    /* огонь больше прижимает, чем убивает: из ожидаемого эффекта треть — потери, остальное — подавление.
       У авиации доля потерь выше (opt.kill): бомбы и ракеты бьют прицельно */
    const KF = (opt && opt.kill) || FIRE_KILL;
    return { P, mods, exp: L, kill: L * KF, sup: L * (1 - KF) * 2,
      loss: [Math.max(0, Math.round(L * KF * .5)), Math.min(def.str, Math.round(L * KF * 1.5))],
      supp: [Math.round(L * (1 - KF) * 1.2), Math.round(L * (1 - KF) * 2.8)] };
  }

  /* ---------- авиаудар и ПВО ----------
     Зонтик ПВО над клеткой: зенитные дивизионы противника цели в своём радиусе
     (UT.aa клеток) — по действующим шагам (подавленные расчёты не стреляют) —
     и приданный самой цели зенитный взвод (за полдивизиона). Каждый налёт под
     зонтиком предсказуемо ослаблен: урон ×1/(1 + прикрытие), и с шансом
     прикрытие × 30% (до 70%) штурмовик сбит — удара нет, а у того, кто его
     послал, в следующий ход на вылет меньше. ctx.side — сторона, которая бьёт;
     ctx.occ — известные ей части (клиент видит только видимых). */
  function airCover(ctx, hex, def) {
    const A = W.AIR;
    let c = 0;
    const by = [];
    for (const [h, u] of ctx.occ) {
      if (!u || u.side === ctx.side) continue;
      const T = UT[u.k];
      if (!T || !T.aa || ctx.H.hexDist(h, hex) > T.aa) continue;
      const k = effStr(u) / MAX_STR;
      if (k <= 0) continue;
      c += k; by.push(u);
    }
    if (def && def.att === 'aaa') c += A.aaaCover;
    by.sort((a, b) => effStr(b) - effStr(a));
    return { c, by, shot: Math.min(A.shotMax, A.shotK * c), cut: 1 / (1 + A.cutK * c) };
  }
  /** расчёт авиаудара по части def: прикрытие ПВО, шанс сбить и ожидаемый эффект */
  function airOdds(ctx, def) {
    const A = W.AIR, cov = airCover(ctx, def.hex, def);
    const b = bombardOdds(ctx, A.pow, def, { air: true, th: true, kill: A.kill, cap: A.cap, aaCut: cov.cut });
    return Object.assign(b, { cover: cov.c, by: cov.by, shot: cov.shot, cut: cov.cut });
  }
  /** клетки под зонтиком ПВО стороны side (для авиаразведки и подсветки) */
  function aaZone(ctx, side) {
    const z = new Set();
    for (const [h, u] of ctx.occ) {
      if (!u || u.side !== side || !UT[u.k] || !UT[u.k].aa || effStr(u) <= 0) continue;
      for (const x of ctx.H.within(h, UT[u.k].aa)) z.add(x);
    }
    return z;
  }

  /** засада: ответный огонь части amb по тому, кто вошёл рядом (ожидаемые потери вошедшего) */
  function ambushHit(ctx, amb, mover) {
    const o = odds(ctx, amb, { ...mover, ent: 0, amb: 0 });
    return Math.min(3, o.expD * .55 * 1.4);
  }
  const ARMBIT = { soft: 1, light: 2, hard: 4 };
  const api = { ARMBIT, edgeOf, crossable, stepCost, zocOf, reachable, pathTo, odds, fireOdds, bombardOdds, airCover, airOdds, aaZone, ambushHit, terrainDef, effStr, firePow, TDEF, TCOST, TNAME };
  if (node) module.exports = api;
  else g.Rules = api;
})(typeof window !== 'undefined' ? window : globalThis);
