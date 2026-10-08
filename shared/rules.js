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
  function odds(ctx, att, def) {
    const TA = UT[att.k], TD = UT[def.k];
    const hx = ctx.map.hexes[def.hex];
    let A = TA.atk[TD.arm] * strK(att) * orgK(att) * xpK(att), D = TD.def * strK(def) * orgK(def) * xpK(def);
    const mods = [];
    const am = (t, v) => { if (Math.abs(v - 1) > .001) { A *= v; mods.push({ t, v, who: 'a' }) } };
    const dm = (t, v) => { if (Math.abs(v - 1) > .001) { D *= v; mods.push({ t, v, who: 'd' }) } };
    const d = ctx.H.dirTo(att.hex, def.hex);
    if (d >= 0 && !crossable(edgeOf(ctx, att.hex, d))) am('через реку', .5);
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
    if (spA < 3) am(`запасы ${spA}/3`, SUPK.att[spA]);
    if (ctx.smoke && ctx.smoke.has(def.hex)) am('цель в дыму', .8);
    if (att.sup) am('подавлены', .8);
    dm(TNAME[hx.t], terrainDef(hx, att, def));
    if (def.ent) dm(`окоп ${def.ent}`, 1 + .2 * def.ent);
    const fort = ctx.forts && ctx.forts.get(def.hex);
    if (fort) dm(`укрепления ${fort}`, 1 + .25 * fort);
    if (ctx.obst && ctx.obst.has(def.hex) && TA.arm === 'hard') am('заграждения', .75);
    if (TD.atd && TA.arm !== 'soft') dm('противотанковая оборона', 1.8);
    if (ctx.support && ctx.support[def.side] && ctx.support[def.side].has(def.hex)) dm('огонь поддержки', 1.25);
    if (def.amb) dm('из засады', 1.15);
    if (def.sup) dm('подавлены огнём', .8);
    if (spD < 2) dm(`запасы ${spD}/3`, SUPK.def[spD]);
    if (def.hold) dm('стоять насмерть', 1.3);
    if (ctx.mines && ctx.mines.get(def.hex) && ctx.mines.get(def.hex).side === def.side) dm('мины', 1.2);
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

  /* ---------- артиллерия и авиация ---------- */
  const BDEF = { open: 1, forest: 1.25, hill: 1.2, city: 1.4, marsh: 1, mount: 1.5, lake: 1 };
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
    if (opt && opt.sp !== undefined && opt.sp < 3) m(`запасы ${opt.sp}/3`, SUPK.att[opt.sp]);
    if (ctx.smoke && ctx.smoke.has(def.hex)) m('цель в дыму', .7);
    const L = Math.min(5, P * .14);
    return { P, mods, exp: L, loss: [Math.max(0, Math.round(L * .5)), Math.min(def.str, Math.round(L * 1.5))] };
  }

  /** засада: ответный огонь части amb по тому, кто вошёл рядом (ожидаемые потери вошедшего) */
  function ambushHit(ctx, amb, mover) {
    const o = odds(ctx, amb, { ...mover, ent: 0, amb: 0 });
    return Math.min(3, o.expD * .55 * 1.4);
  }
  const ARMBIT = { soft: 1, light: 2, hard: 4 };
  const api = { ARMBIT, edgeOf, crossable, stepCost, zocOf, reachable, pathTo, odds, bombardOdds, ambushHit, terrainDef, TDEF, TCOST, TNAME };
  if (node) module.exports = api;
  else g.Rules = api;
})(typeof window !== 'undefined' ? window : globalThis);
