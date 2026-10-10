'use strict';
/* ============================================================
   БОТ-КОМАНДИР «FRONTLINE TACTICS»
   ------------------------------------------------------------
   Видит только то, что видит его сторона, ходит теми же
   действиями, что игрок (this.act). Порядок хода:
     1. пополнение потрёпанных в тылу и закупка в своих городах;
     2. авиаразведка над целью, артиллерия и авиаудары — по целям
        будущей атаки (подавленный противник обороняется хуже);
     3. атаки группой: к выбранной цели подводятся до четырёх
        частей на соседние клетки (охват, удар с двух сторон), и
        только потом — удары, пока шансы хорошие; порог — от
        характера командующего;
     4. остальные: потрёпанные — к городам, ударные — к цели
        (наступающий) или на рубеж у своих точек (обороняющийся),
        с выбором хорошей местности и в пределах снабжения;
        артиллерия — во второй линии, штаб — за центром, сапёры —
        мины перед угрожаемыми точками и понтоны к цели.
   ============================================================ */
const W = require('../shared/world');
const Hex = require('../shared/hex');
const Rules = require('../shared/rules');
const { N, S, UT, MAX_STR } = W;

const MIX = {
  attacker: { inf: 3, mot: 3, tnk: 4, rec: 1, art: 2, mlrs: 1, aa: 1.3, eng: 1, at: .5 },
  defender: { inf: 5, mot: 2, tnk: 2, rec: 1, art: 3, mlrs: 1, aa: 1.6, eng: 1.5, at: 1.5 },
  both:     { inf: 4, mot: 3, tnk: 3, rec: 1, art: 2, mlrs: 1, aa: 1.4, eng: 1, at: 1 }
};
const TERR = { open: 0, forest: 3, hill: 4, city: 5, marsh: 1, mount: 5, lake: -99 };
const val = u => UT[u.k].price * u.str / MAX_STR;

module.exports = {
  /* ---------- расстановка ---------- */
  /* Бот сидит на месте (seat) и командует только своими частями;
     сторона нужна для зон, видимости и ролей. */
  botDeploy(seat) {
    const side = this.sideOf(seat) || seat;
    if (this.scen && this.scen.noDeploy) { this.ready[seat] = true; return }
    const mix = MIX[this.role[side]] || MIX.both, dir = side === N ? 1 : -1;
    const zone = [];
    for (let h = 0; h < this.H.NH; h++) if (this.inDeploy(side, h) && !this.unitAt(h)) zone.push(h);
    if (!zone.length) { this.ready[seat] = true; return }
    const xs = zone.map(h => this.map.hexes[h].x), edge = dir > 0 ? Math.max(...xs) : Math.min(...xs);
    /* ставка — в тылу своей полосы, поближе к своему городу: её захват дорого стоит */
    this.placeHQ(seat, zone, dir);
    let guard = 0;
    while (this.budget[seat] >= 60 && guard++ < 40) {
      const k = this.wantKind(seat, mix);
      if (!k) break;
      const back = UT[k].bomb ? 3.5 : k === 'hq' ? 6 : k === 'aa' ? 2.5 : 1;
      const yband = (guard % 5 + .5) * this.WH / 5;
      let best = -1, bs = -1e9;
      for (const h of zone) {
        if (this.unitAt(h)) continue;
        const hx = this.map.hexes[h], dx = Math.abs((edge - hx.x) * dir / Hex.HW - back);
        const s = -dx * 4 - Math.abs(hx.y - yband) / 20 + (k === 'inf' ? TERR[hx.t] : 0) + this.rnd() * 2;
        if (s > bs) { bs = s; best = h }
      }
      if (best < 0 || !this.buy(seat, k, best, true).ok) break;
    }
    this.ready[seat] = true;
  },
  /** куда поставить ставку: глубокий тыл своей полосы, рядом с городом */
  placeHQ(seat, zone, dir) {
    const side = this.sideOf(seat) || seat;
    /* ставим стационарный пункт: именно он обязателен перед началом */
    const hq = this.units.find(u => UT[u.k].fob && u.seat === seat && u.str > 0);
    if (!hq) return;
    const mine = this.seatsOf(side), band = Math.max(0, mine.findIndex(st => st.id === seat));
    const yband = this.WH * (band + 1) / (mine.length + 1);
    const towns = this.pts.filter(p => p.owner === side);
    const backX = dir > 0 ? Math.min(...zone.map(h => this.map.hexes[h].x)) : Math.max(...zone.map(h => this.map.hexes[h].x));
    let best = hq.hex, bs = -1e9;
    for (const h of zone) {
      if (this.unitAt(h) && this.unitAt(h) !== hq) continue;
      const hx = this.map.hexes[h];
      /* чем глубже в тыл и ближе к своему городу в своей полосе, тем лучше */
      const depth = -Math.abs(hx.x - backX) / Hex.HW;
      const near = towns.length ? -Math.min(...towns.map(p => this.H.hexDist(h, p.hex))) : 0;
      /* штабы союзников разводим по фронту: иначе оба садятся в один угол
         и смысл направлений теряется */
      const apart = Math.min(6, ...this.units
        .filter(v => UT[v.k].fob && v.side === side && v.seat !== seat && v.str > 0)
        .map(v => this.H.hexDist(h, v.hex)).concat([6]));
      const sc = depth * 2.2 + near * 1.2 - Math.abs(hx.y - yband) / 6 + apart * .9
        + (hx.t === 'city' ? 2 : 0) + this.rnd() * .8;
      if (sc > bs) { bs = sc; best = h }
    }
    if (best !== hq.hex && !this.unitAt(best)) hq.hex = best;
    hq.sited = true;   /* бот тоже обязан выбрать место */
  },
  wantKind(seat, mix) {
    const side = this.sideOf(seat) || seat;
    const have = {}; let total = 0;
    for (const u of this.units) if (u.side === side && u.str > 0) { have[u.k] = (have[u.k] || 0) + 1; total++ }
    const wsum = Object.values(mix).reduce((a, b) => a + b, 0);
    let best = null, bd = -1e9;
    for (const k in mix) {
      if (UT[k].price > this.budget[seat]) continue;
      const d = mix[k] / wsum * (total + 1) - (have[k] || 0) + this.rnd() * .3;
      if (d > bd) { bd = d; best = k }
    }
    return best;
  },

  /* ---------- ход ---------- */
  botTurn(seat) {
    const side = this.sideOf(seat) || seat;
    if (this.over || this.active !== side || this.done[seat]) return;
    const en = side === N ? S : N, dir = side === N ? 1 : -1, com = this.commanders[side];
    /* только свои части: на стороне может быть несколько командиров */
    const mine = () => this.units.filter(u => u.side === side && u.seat === seat && u.str > 0);
    const foes = () => this.units.filter(u => u.side === en && u.str > 0 && this.seen(side, u));
    const objective = this.botObjective(side);

    /* 1. пополнение и закупка */
    for (const u of mine()) if (u.str <= 6 && (u.sv || 0) >= 3 && !u.acted && !u.moved && this.budget[seat] > 30) this.act(seat, { t: 'replace', id: u.id });
    this.botBuy(seat);
    this.botSpecs(seat);
    this.botOrders(seat, 'early');

    /* 2. разведка, артиллерия, авиация */
    if (objective && this.air[seat].recon > 0) this.act(seat, { t: 'air', kind: 'recon', hex: objective.hex });
    const targets = () => foes().map(e => ({ e, adj: this.H.neighbors(e.hex).filter(h => { const o = this.unitAt(h); return o && o.side === side }).length }));
    for (const a of mine().filter(u => UT[u.k].bomb && !u.acted && u.reload <= 0)) {
      let best = null, bs = 0;
      for (const { e, adj } of targets()) {
        if (this.H.hexDist(a.hex, e.hex) > UT[a.k].bomb.rng) continue;
        const s = val(e) * (1 + adj * .5) * (objective && this.H.hexDist(e.hex, objective.hex) <= 2 ? 1.5 : 1);
        if (s > bs) { bs = s; best = e }
      }
      if (best) this.act(seat, { t: 'bombard', id: a.id, hex: best.hex });
    }
    /* авиаудары: по расчёту, как у игрока — ПВО над целью режет урон и может сбить
       штурмовик, поэтому под зонтик бот лезет только ради очень ценной цели */
    for (let guard = 0; this.air[seat].strike > 0 && guard < 6; guard++) {
      const ctx = this.ctxFor(side, false), risk = com.trait === 'решительный' ? .2 : .35;
      let best = null, bs = 0;
      for (const { e, adj } of targets()) {
        const o = Rules.airOdds(ctx, e), go = (1 - o.shot) * Math.min(1, o.kill / 2);
        if ((1 - o.shot) * o.cut < risk) continue;
        const s = val(e) * (1 + adj * .6) * go * (objective && this.H.hexDist(e.hex, objective.hex) <= 2 ? 1.4 : 1);
        if (s > bs) { bs = s; best = e }
      }
      if (!best || !this.act(seat, { t: 'air', kind: 'strike', hex: best.hex }).ok) break;
    }

    /* 3. атаки группами */
    /* обороняющийся контратакует охотнее, если противник уже в его точке */
    const lost = this.pts.some(p => p.home === side && p.owner !== side);
    const thr = com.aggr.ratio * (this.role[side] === 'defender' ? (lost ? .95 : 1.05) : 1) * (this.scen && this.role[side] === 'attacker' ? .85 : 1);
    for (let guard = 0; guard < 14; guard++) if (!this.botAttack(seat, thr, objective)) break;

    /* 4. манёвр */
    for (const u of mine().sort((a, b) => (UT[a.k].bomb ? 1 : 0) - (UT[b.k].bomb ? 1 : 0))) {
      if (u.str <= 0 || u.mp <= 0) continue;
      this.botMove(u, objective, dir);
    }
    /* оборона: засады в укрытиях, окопы у противника, сапёры — мины, укрепления, заграждения */
    const near = (u, r) => this.units.some(e => e.side === en && e.str > 0 && this.seen(side, e) && this.H.hexDist(e.hex, u.hex) <= r);
    for (const u of mine()) {
      if (u.str <= 0 || u.acted) continue;
      if (UT[u.k].eng && this.botEngineer(u, objective)) continue;
      const t = this.map.hexes[u.hex].t, cover = t === 'forest' || t === 'city' || this.forts.get(u.hex);
      if ((cover || u.k === 'at') && near(u, 2) && !UT[u.k].bomb && u.k !== 'hq' && UT[u.k].atk.soft >= 2) { this.act(seat, { t: 'ambush', id: u.id }); continue }
      if (!u.moved && near(u, 1)) this.act(seat, { t: 'dig', id: u.id });
    }
    this.botOrders(seat, 'late');
    if (!this.over) this.act(seat, { t: 'end' });
  },

  /** приказы штаба: артподготовка перед атаками, груз в котёл, «стоять насмерть» на точках, резерв */
  botOrders(seat, phase) {
    const side = this.sideOf(seat) || seat;
    const O = W.ORDERS, cp = () => this.cp[seat], en = side === N ? S : N;
    const mine = this.units.filter(u => u.side === side && u.str > 0);
    const foes = this.units.filter(u => u.side === en && u.str > 0 && this.seen(side, u));
    if (phase === 'early') {
      for (const u of mine.filter(u => !u.supplied && (u.sp <= 1 || (W.usesFuel(UT[u.k]) && u.fu <= 1)) && u.str >= 4).sort((a, b) => b.str - a.str))
        if (cp() >= O.airdrop.cp + 1 && this.weather.fly) this.act(seat, { t: 'order', k: 'airdrop', id: u.id });
      const guns = mine.filter(u => UT[u.k].bomb && !u.acted && u.reload <= 0 && u.sp > 0 && foes.some(e => this.H.hexDist(e.hex, u.hex) <= UT[u.k].bomb.rng));
      /* контрудар: противник в нашей исходной точке, рядом есть кому бить */
      const lostHome = this.pts.filter(p => p.home === side && p.owner !== side);
      if (lostHome.length && cp() >= O.counter.cp && !this.counter[side] &&
        lostHome.some(p => mine.filter(u => !UT[u.k].bomb && u.k !== 'hq' && u.str >= 4 && this.H.hexDist(u.hex, p.hex) <= 3).length >= 2)) this.act(seat, { t: 'order', k: 'counter' });
      if (guns.length >= 2 && cp() >= O.barrage.cp && !this.barrage[side]) this.act(seat, { t: 'order', k: 'barrage' });

      if (cp() >= O.reserve.cp && mine.length < W.MAX_UNITS) {
        const k = 'mot', cand = this.spawnHexes(side, k);
        cand.sort((a, b) => Math.abs(this.map.hexes[a].x - this.frontXAt(this.map.hexes[a].y)) - Math.abs(this.map.hexes[b].x - this.frontXAt(this.map.hexes[b].y)));
        if (cand.length) this.act(seat, { t: 'order', k: 'reserve', hex: cand[0] });
      }
      return;
    }
    /* поздно: держать точки под угрозой */
    const threatened = mine.filter(u => this.ptAt(u.hex) && UT[u.k].cap && !u.hold &&
      this.H.neighbors(u.hex).filter(h => { const e = this.unitAt(h); return e && e.side === en }).length >= 2)
      .sort((a, b) => this.ptAt(b.hex).w - this.ptAt(a.hex).w);
    for (const u of threatened) if (cp() >= O.hold.cp + 1) this.act(seat, { t: 'order', k: 'hold', id: u.id });
  },

  /** главная цель: для наступающего — ценная близкая точка противника, для обороны — угрожаемая своя */
  botObjective(side) {
    const en = side === N ? S : N, own = this.units.filter(u => u.side === side && u.str > 0 && UT[u.k].cap);
    if (!own.length) return null;
    if (this.scen && this.scen.target && this.role[side] === 'attacker') { const p = this.pts.find(q => q.id === this.scen.target); if (p && p.owner !== side) return p }
    let best = null, bs = -1e9;
    for (const p of this.pts) {
      const near = Math.min(...own.map(u => this.H.hexDist(u.hex, p.hex)));
      if (p.owner !== side) {
        /* обороняющийся тянется к чужим точкам только поблизости, свои потерянные — главное */
        if (this.role[side] === 'defender' && near > 6 && p.home !== side) continue;
        const s = p.w * (p.city ? 1.5 : 1) * 10 - near * (this.role[side] === 'defender' && p.home !== side ? 2.5 : 1.5) + (p.home === side ? 12 : 0);
        if (s > bs) { bs = s; best = p }
      } else if (this.units.some(e => e.side === en && e.str > 0 && this.seen(side, e) && this.H.hexDist(e.hex, p.hex) <= 3)) {
        const s = p.w * 12 - near;
        if (s > bs) { bs = s; best = p }
      }
    }
    return best;
  },

  /** одна групповая атака: цель, до 4 атакующих на соседних клетках, удары по очереди */
  botAttack(seat, thr, objective) {
    const side = this.sideOf(seat) || seat;
    const ctx = this.ctxFor(side, false);
    const foes = this.units.filter(u => u.side !== side && u.str > 0 && this.seen(side, u));
    const ready = this.units.filter(u => u.side === side && u.seat === seat && u.str >= 3 && u.org >= 30 && u.sp > 0 && !u.acted && !UT[u.k].bomb && UT[u.k].atk.soft >= 2 && u.k !== 'hq');
    let plan = null, ps = 0;
    for (const e of foes) {
      const slots = this.H.neighbors(e.hex).filter(h => { const o = this.unitAt(h); return !o || o.side === side });
      const cand = [];
      for (const u of ready) {
        if (this.H.hexDist(u.hex, e.hex) > UT[u.k].mp + 1) continue;
        const reach = Rules.reachable(ctx, u);
        for (const h of slots) {
          const o = this.unitAt(h);
          if (h === u.hex) cand.push({ u, h, c: 0 });
          else if (!o && reach.has(h) && !reach.get(h).through) cand.push({ u, h, c: reach.get(h).c });
        }
      }
      if (!cand.length) continue;
      /* распределить клетки: сильнейшие по этой цели — первыми */
      cand.sort((a, b) => UT[b.u.k].atk[UT[e.k].arm] * b.u.str - UT[a.u.k].atk[UT[e.k].arm] * a.u.str || a.c - b.c);
      const used = new Set(), taken = new Set(), group = [];
      for (const c of cand) { if (used.has(c.u.id) || taken.has(c.h) || group.length >= 4) continue; used.add(c.u.id); taken.add(c.h); group.push(c) }
      /* оценка: первый удар при полном охвате */
      const occ = new Map(ctx.occ);
      for (const c of group) { occ.delete(c.u.hex); occ.set(c.h, c.u) }
      const lead = group[0], sim = { ...lead.u, hex: lead.h };
      occ.set(lead.h, sim);
      const o = Rules.odds({ ...ctx, occ }, sim, e);
      const prio = (objective && this.H.hexDist(e.hex, objective.hex) <= 1 ? 1.6 : 1) * (this.ptAt(e.hex) ? 1.3 : 1);
      const score = (o.expD * val(e) / MAX_STR * (1 + o.retreat) - o.expA * val(lead.u) / MAX_STR) * prio;
      if (o.r * (prio > 1 ? 1.15 : 1) < thr || score <= ps) continue;
      ps = score; plan = { e, group };
    }
    if (!plan) return false;
    for (const c of plan.group) if (c.u.hex !== c.h) this.act(seat, { t: 'move', id: c.u.id, to: c.h });
    /* кому штурмовать рано — прижимают цель огнём с места, и только потом идут остальные */
    const weak = (c, e) => Rules.odds(this.ctxFor(side, false), c.u, e).r < Math.max(1, thr * .7);
    for (const pass of ['fire', 'attack']) for (const c of plan.group) {
      const e = this.byId(plan.e.id);
      if (!e || e.str <= 0 || c.u.str <= 0 || c.u.acted || this.H.hexDist(c.u.hex, e.hex) !== 1) continue;
      if (pass === 'fire') {
        if (!weak(c, e)) continue;
        const f = Rules.fireOdds(this.ctxFor(side, false), c.u, e);
        if (f.sup >= 1 && f.back < 1) this.act(seat, { t: 'fire', id: c.u.id, target: e.id });
      } else if (!weak(c, e)) this.act(seat, { t: 'attack', id: c.u.id, target: e.id });
    }
    return true;
  },

  /** куда идти части, если не атакует */
  botMove(u, objective, dir) {
    const side = u.side, seat = u.seat || u.side, T = UT[u.k];
    /* гарнизон: пехота в своём городе (и в главной точке сценария) остаётся на месте */
    const here = this.ptAt(u.hex);
    if (here && here.owner === side && T.cap && (here.city || (this.scen && this.scen.target === here.id)) && u.str > 3 &&
      (u.k === 'inf' || (this.scen && this.scen.target === here.id) || !this.units.some(v => v !== u && v.side === side && v.str > 0 && this.H.hexDist(v.hex, u.hex) <= 1))) return;
    const ctx = this.ctxFor(side, false), reach = Rules.reachable(ctx, u);
    /* снабжение на клетке после хода: своя земля — её значение, чужая рядом со
       своей — чуть меньше соседнего (клетку мы займём и подвоз пойдёт за нами) */
    const sv = this.sv[side], own = side === 'n' ? 1 : 2;
    const supAt = h => this.terr[h] === own ? sv[h] : Math.max(0, ...this.H.neighbors(h).map(n => this.terr[n] === own ? sv[n] - 1.5 : 0));
    const known = this.units.filter(e => e.side !== side && e.str > 0 && this.seen(side, e));
    const danger = h => known.filter(e => this.H.hexDist(e.hex, h) === 1).length;
    const front = h => (this.map.hexes[h].x - this.frontXAt(this.map.hexes[h].y)) * dir;   /* >0 — за линией фронта у противника */
    const com = this.commanders[side];
    let goal = null, mode = 'line';
    if ((u.str <= com.aggr.retreat || u.org < 30) && !T.bomb) {
      goal = this.pts.filter(p => p.owner === side && p.city).sort((a, b) => this.H.hexDist(a.hex, u.hex) - this.H.hexDist(b.hex, u.hex))[0];
      mode = 'rest';
    } else if (T.bomb) mode = 'arty';
    else if (u.k === 'hq') mode = 'hq';
    else if (u.k === 'aa') mode = 'aa';
    else if (objective && (this.role[side] !== 'defender' || objective.owner === side || objective.home === side || (u.str >= 7 && UT[u.k].arm !== 'soft'))) { goal = objective; mode = 'attack' }
    let best = u.hex, bs = -1e9;
    for (const [h, r] of reach) {
      if (r.through) continue;
      const hx = this.map.hexes[h], dg = danger(h);
      let s = TERR[hx.t] * .8 + (supAt(h) >= 4 ? 4 : supAt(h) >= 1 ? 1 : -8) - r.c * .1;
      if (mode === 'rest') s += -this.H.hexDist(h, goal ? goal.hex : h) * 3 - dg * 6;
      else if (mode === 'attack') s += -this.H.hexDist(h, goal.hex) * 3 - dg * (u.str >= 7 && T.arm === 'hard' ? 1 : 4);
      else if (mode === 'arty') s += -Math.abs(front(h) + 2.5 * Hex.HW) / Hex.HW * 3 - dg * 10 + (known.some(e => this.H.hexDist(e.hex, h) <= T.bomb.rng) ? 4 : 0);
      else if (mode === 'hq' || mode === 'aa') {
        const mates = this.units.filter(v => v.side === side && v.str > 0 && v !== u && !UT[v.k].bomb);
        const cx = mates.reduce((a, v) => a + this.map.hexes[v.hex].x, 0) / Math.max(1, mates.length), cy = mates.reduce((a, v) => a + this.map.hexes[v.hex].y, 0) / Math.max(1, mates.length);
        s += -Math.hypot(hx.x - cx + dir * (mode === 'hq' ? 25 : 12), hx.y - cy) / Hex.HW * 2 - dg * 10;
      } else {
        /* рубеж: держаться у линии фронта со своей стороны, у своих точек */
        const p = this.pts.filter(q => q.owner === side).sort((a, b) => this.H.hexDist(a.hex, h) - this.H.hexDist(b.hex, h))[0];
        s += -Math.abs(front(h) + Hex.HW) / Hex.HW * 2.5 - (p ? Math.max(0, this.H.hexDist(p.hex, h) - 3) : 0) - dg * 2;
        if (h === u.hex) s += 1.5 + u.ent;   /* окопавшиеся неохотно уходят */
      }
      if (s > bs) { bs = s; best = h }
    }
    if (best !== u.hex) this.act(seat, { t: 'move', id: u.id, to: best });
  },

  /** сапёры: понтон к цели через реку, мины перед угрожаемой точкой, окопать соседей */
  botEngineer(u, objective) {
    const side = u.side, seat = u.seat || u.side, ctx = this.ctxFor(side, true);
    /* взорванный мост рядом — восстановить, если противника нет вплотную */
    for (let d = 0; d < 6; d++) {
      const h = this.H.nb(u.hex, d);
      if (h < 0 || this.br.get(Hex.edgeKey(u.hex, h)) !== 'down') continue;
      if (this.H.neighbors(h).concat([h]).some(x => { const e = this.unitAt(x); return e && e.side !== side })) continue;
      if (this.act(seat, { t: 'eng', id: u.id, task: 'repair', hex: h }).ok) return true;
    }
    if (objective && objective.owner !== side) {
      for (let d = 0; d < 6; d++) {
        const h = this.H.nb(u.hex, d);
        if (h < 0) continue;
        const e = Rules.edgeOf(ctx, u.hex, d);
        if ((e & Hex.RIV) && !(e & Hex.BR) && this.H.hexDist(h, objective.hex) < this.H.hexDist(u.hex, objective.hex)) return this.act(seat, { t: 'eng', id: u.id, task: 'bridge', hex: h }).ok;
      }
    }
    if (u.mines > 0) {
      const en = side === N ? S : N;
      const threat = this.units.filter(e => e.side === en && e.str > 0 && this.seen(side, e)).sort((a, b) => this.H.hexDist(a.hex, u.hex) - this.H.hexDist(b.hex, u.hex))[0];
      if (threat && this.H.hexDist(threat.hex, u.hex) <= 3) {
        const h = this.H.neighbors(u.hex).filter(x => !this.unitAt(x) && !this.mines.has(x)).sort((a, b) => this.H.hexDist(a, threat.hex) - this.H.hexDist(b, threat.hex))[0];
        if (h !== undefined) return this.act(seat, { t: 'eng', id: u.id, task: 'mine', hex: h }).ok;
      }
    }
    /* укрепить угрожаемую свою точку рядом (или клетку с нашей частью), против танков — заграждения */
    const en = side === N ? S : N, foes = this.units.filter(e => e.side === en && e.str > 0 && this.seen(side, e));
    const threatened = h => foes.some(e => this.H.hexDist(e.hex, h) <= 3);
    for (const h of [u.hex, ...this.H.neighbors(u.hex)]) {
      const occ = this.unitAt(h), p = this.ptAt(h);
      if ((occ && occ.side !== side) || this.map.hexes[h].t === 'lake') continue;
      if ((p && p.owner === side || (occ && occ.side === side && UT[occ.k].cap)) && threatened(h) && (this.forts.get(h) || 0) < 2) return this.act(seat, { t: 'eng', id: u.id, task: 'fort', hex: h }).ok;
    }
    if (foes.some(e => UT[e.k].arm === 'hard' && this.H.hexDist(e.hex, u.hex) <= 4)) {
      const h = this.H.neighbors(u.hex).filter(x => !this.unitAt(x) && !this.obst.has(x) && this.map.hexes[x].t !== 'lake').sort((a, b) => Math.min(...foes.map(e => this.H.hexDist(e.hex, a))) - Math.min(...foes.map(e => this.H.hexDist(e.hex, b))))[0];
      if (h !== undefined) return this.act(seat, { t: 'eng', id: u.id, task: 'obst', hex: h }).ok;
    }
    if (!u.moved && this.H.neighbors(u.hex).some(h => { const v = this.unitAt(h); return v && v.side === side && v.ent < 2 })) return this.act(seat, { t: 'dig', id: u.id }).ok;
    return false;
  },

  /** приданные специалисты: артиллерии — тяжёлую батарею, пехоте и мотопехоте —
      ПТ-взвод, если у противника видна броня, иначе штурмовых сапёров */
  botSpecs(seat) {
    const side = this.sideOf(seat) || seat;
    const armor = this.units.some(e => e.side !== side && e.str > 0 && UT[e.k].arm === 'hard' && this.seen(side, e));
    for (const u of this.units) {
      if (this.budget[seat] < 140) return;
      if (u.side !== side || u.seat !== seat || u.str < 6 || u.att || u.acted || u.moved) continue;
      const T = UT[u.k];
      const k = T.bomb ? 'hvy' : W.SPECS.atg.for(T) && armor ? 'atg' : W.SPECS.sap.for(T) ? 'sap' : null;
      if (k) this.act(seat, { t: 'attach', id: u.id, k });
    }
  },
  botBuy(seat) {
    const side = this.sideOf(seat) || seat;
    const mix = { ...(MIX[this.role[side]] || MIX.both) };
    if (!this.units.some(u => u.side === side && u.k === 'hq' && u.str > 0)) mix.hq = 30;
    const armor = this.units.filter(e => e.side !== side && e.str > 0 && UT[e.k].arm === 'hard' && this.seen(side, e)).length;
    if (armor >= 2) mix.at += 2;
    for (let i = 0; i < 3; i++) {
      if (this.budget[seat] < 60) return;
      const k = this.wantKind(seat, mix);
      if (!k) return;
      const fx = h => Math.abs(this.map.hexes[h].x - this.frontXAt(this.map.hexes[h].y));
      /* поближе к фронту, но не вплотную: в самой точке — пехота, рядом — остальные */
      const cand = this.spawnHexes(side, k).sort((a, b) => fx(a) - fx(b) + ((this.ptAt(a) ? 1 : 0) - (this.ptAt(b) ? 1 : 0)) * (k === 'inf' ? -3 : 3));
      let ok = false;
      for (const h of cand) if (this.buy(seat, k, h, false).ok) { ok = true; break }
      if (!ok) return;
    }
  }
};
