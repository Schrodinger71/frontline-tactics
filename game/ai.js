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
  attacker: { inf: 3, mot: 3, tnk: 4, rec: 1, art: 2, mlrs: 1, aa: 1, eng: 1, at: .5 },
  defender: { inf: 5, mot: 2, tnk: 2, rec: 1, art: 3, mlrs: 1, aa: 1, eng: 1.5, at: 1.5 },
  both:     { inf: 4, mot: 3, tnk: 3, rec: 1, art: 2, mlrs: 1, aa: 1, eng: 1, at: 1 }
};
const TERR = { open: 0, forest: 3, hill: 4, city: 5, marsh: 1, mount: 5, lake: -99 };
const val = u => UT[u.k].price * u.str / MAX_STR;

module.exports = {
  /* ---------- расстановка ---------- */
  botDeploy(side) {
    if (this.scen && this.scen.noDeploy) { this.ready[side] = true; return }
    const mix = MIX[this.role[side]] || MIX.both, dir = side === N ? 1 : -1;
    const zone = [];
    for (let h = 0; h < Hex.NH; h++) if (this.inDeploy(side, h) && !this.unitAt(h)) zone.push(h);
    if (!zone.length) { this.ready[side] = true; return }
    const xs = zone.map(h => this.map.hexes[h].x), edge = dir > 0 ? Math.max(...xs) : Math.min(...xs);
    let guard = 0;
    while (this.budget[side] >= 60 && guard++ < 40) {
      const k = this.wantKind(side, mix);
      if (!k) break;
      const back = UT[k].bomb ? 3.5 : k === 'hq' ? 6 : k === 'aa' ? 2.5 : 1;
      const yband = (guard % 5 + .5) * W.WH / 5;
      let best = -1, bs = -1e9;
      for (const h of zone) {
        if (this.unitAt(h)) continue;
        const hx = this.map.hexes[h], dx = Math.abs((edge - hx.x) * dir / Hex.HW - back);
        const s = -dx * 4 - Math.abs(hx.y - yband) / 20 + (k === 'inf' ? TERR[hx.t] : 0) + this.rnd() * 2;
        if (s > bs) { bs = s; best = h }
      }
      if (best < 0 || !this.buy(side, k, best, true).ok) break;
    }
    this.ready[side] = true;
  },
  wantKind(side, mix) {
    const have = {}; let total = 0;
    for (const u of this.units) if (u.side === side && u.str > 0) { have[u.k] = (have[u.k] || 0) + 1; total++ }
    const wsum = Object.values(mix).reduce((a, b) => a + b, 0);
    let best = null, bd = -1e9;
    for (const k in mix) {
      if (UT[k].price > this.budget[side]) continue;
      const d = mix[k] / wsum * (total + 1) - (have[k] || 0) + this.rnd() * .3;
      if (d > bd) { bd = d; best = k }
    }
    return best;
  },

  /* ---------- ход ---------- */
  botTurn(side) {
    if (this.over || this.active !== side) return;
    const en = side === N ? S : N, dir = side === N ? 1 : -1, com = this.commanders[side];
    const mine = () => this.units.filter(u => u.side === side && u.str > 0);
    const foes = () => this.units.filter(u => u.side === en && u.str > 0 && this.seen(side, u));
    const objective = this.botObjective(side);

    /* 1. пополнение и закупка */
    for (const u of mine()) if (u.str <= 6 && u.supplied && !u.acted && !u.moved && this.budget[side] > 30) this.act(side, { t: 'replace', id: u.id });
    this.botBuy(side);
    this.botOrders(side, 'early');

    /* 2. разведка, артиллерия, авиация */
    if (objective && this.air[side].recon > 0) this.act(side, { t: 'air', kind: 'recon', hex: objective.hex });
    const targets = () => foes().map(e => ({ e, adj: Hex.neighbors(e.hex).filter(h => { const o = this.unitAt(h); return o && o.side === side }).length }));
    for (const a of mine().filter(u => UT[u.k].bomb && !u.acted && u.reload <= 0)) {
      let best = null, bs = 0;
      for (const { e, adj } of targets()) {
        if (Hex.hexDist(a.hex, e.hex) > UT[a.k].bomb.rng) continue;
        const s = val(e) * (1 + adj * .5) * (objective && Hex.hexDist(e.hex, objective.hex) <= 2 ? 1.5 : 1);
        if (s > bs) { bs = s; best = e }
      }
      if (best) this.act(side, { t: 'bombard', id: a.id, hex: best.hex });
    }
    while (this.air[side].strike > 0) {
      const t = targets().filter(x => !this.units.some(a => a.side === en && UT[a.k].aa && Hex.hexDist(a.hex, x.e.hex) <= 2) || com.trait === 'решительный')
        .sort((a, b) => val(b.e) * (1 + b.adj) - val(a.e) * (1 + a.adj))[0];
      if (!t) break;
      this.act(side, { t: 'air', kind: 'strike', hex: t.e.hex });
    }

    /* 3. атаки группами */
    const thr = com.aggr.ratio * (this.role[side] === 'defender' ? 1.2 : 1) * (this.scen && this.role[side] === 'attacker' ? .85 : 1);
    for (let guard = 0; guard < 14; guard++) if (!this.botAttack(side, thr, objective)) break;

    /* 4. манёвр */
    for (const u of mine().sort((a, b) => (UT[a.k].bomb ? 1 : 0) - (UT[b.k].bomb ? 1 : 0))) {
      if (u.str <= 0 || u.mp <= 0) continue;
      this.botMove(u, objective, dir);
    }
    /* оборона: засады в укрытиях, окопы у противника, сапёры — мины, укрепления, заграждения */
    const near = (u, r) => this.units.some(e => e.side === en && e.str > 0 && this.seen(side, e) && Hex.hexDist(e.hex, u.hex) <= r);
    for (const u of mine()) {
      if (u.str <= 0 || u.acted) continue;
      if (UT[u.k].eng && this.botEngineer(u, objective)) continue;
      const t = this.map.hexes[u.hex].t, cover = t === 'forest' || t === 'city' || this.forts.get(u.hex);
      if ((cover || u.k === 'at') && near(u, 2) && !UT[u.k].bomb && u.k !== 'hq' && UT[u.k].atk.soft >= 2) { this.act(side, { t: 'ambush', id: u.id }); continue }
      if (!u.moved && near(u, 1)) this.act(side, { t: 'dig', id: u.id });
    }
    this.botOrders(side, 'late');
    if (!this.over) this.act(side, { t: 'end' });
  },

  /** приказы штаба: артподготовка перед атаками, груз в котёл, «стоять насмерть» на точках, резерв */
  botOrders(side, phase) {
    const O = W.ORDERS, cp = () => this.cp[side], en = side === N ? S : N;
    const mine = this.units.filter(u => u.side === side && u.str > 0);
    const foes = this.units.filter(u => u.side === en && u.str > 0 && this.seen(side, u));
    if (phase === 'early') {
      for (const u of mine.filter(u => !u.supplied && u.sp <= 1 && u.str >= 4).sort((a, b) => b.str - a.str))
        if (cp() >= O.airdrop.cp + 1 && this.weather.fly) this.act(side, { t: 'order', k: 'airdrop', id: u.id });
      const guns = mine.filter(u => UT[u.k].bomb && !u.acted && u.reload <= 0 && u.sp > 0 && foes.some(e => Hex.hexDist(e.hex, u.hex) <= UT[u.k].bomb.rng));
      if (guns.length >= 2 && cp() >= O.barrage.cp && !this.barrage[side]) this.act(side, { t: 'order', k: 'barrage' });
      if (cp() >= O.reserve.cp && mine.length < W.MAX_UNITS) {
        const k = 'mot', cand = this.spawnHexes(side, k);
        cand.sort((a, b) => Math.abs(this.map.hexes[a].x - this.frontXAt(this.map.hexes[a].y)) - Math.abs(this.map.hexes[b].x - this.frontXAt(this.map.hexes[b].y)));
        if (cand.length) this.act(side, { t: 'order', k: 'reserve', hex: cand[0] });
      }
      return;
    }
    /* поздно: держать точки под угрозой */
    const threatened = mine.filter(u => this.ptAt(u.hex) && UT[u.k].cap && !u.hold &&
      Hex.neighbors(u.hex).filter(h => { const e = this.unitAt(h); return e && e.side === en }).length >= 2)
      .sort((a, b) => this.ptAt(b.hex).w - this.ptAt(a.hex).w);
    for (const u of threatened) if (cp() >= O.hold.cp + 1) this.act(side, { t: 'order', k: 'hold', id: u.id });
  },

  /** главная цель: для наступающего — ценная близкая точка противника, для обороны — угрожаемая своя */
  botObjective(side) {
    const en = side === N ? S : N, own = this.units.filter(u => u.side === side && u.str > 0 && UT[u.k].cap);
    if (!own.length) return null;
    if (this.scen && this.scen.target && this.role[side] === 'attacker') { const p = this.pts.find(q => q.id === this.scen.target); if (p && p.owner !== side) return p }
    let best = null, bs = -1e9;
    for (const p of this.pts) {
      const near = Math.min(...own.map(u => Hex.hexDist(u.hex, p.hex)));
      if (p.owner !== side) {
        if (this.role[side] === 'defender' && near > 4) continue;
        const s = p.w * (p.city ? 1.5 : 1) * 10 - near * 1.5;
        if (s > bs) { bs = s; best = p }
      } else if (this.units.some(e => e.side === en && e.str > 0 && this.seen(side, e) && Hex.hexDist(e.hex, p.hex) <= 3)) {
        const s = p.w * 12 - near;
        if (s > bs) { bs = s; best = p }
      }
    }
    return best;
  },

  /** одна групповая атака: цель, до 4 атакующих на соседних клетках, удары по очереди */
  botAttack(side, thr, objective) {
    const ctx = this.ctxFor(side, false);
    const foes = this.units.filter(u => u.side !== side && u.str > 0 && this.seen(side, u));
    const ready = this.units.filter(u => u.side === side && u.str >= 3 && u.org >= 30 && u.sp > 0 && !u.acted && !UT[u.k].bomb && UT[u.k].atk.soft >= 2 && u.k !== 'hq');
    let plan = null, ps = 0;
    for (const e of foes) {
      const slots = Hex.neighbors(e.hex).filter(h => { const o = this.unitAt(h); return !o || o.side === side });
      const cand = [];
      for (const u of ready) {
        if (Hex.hexDist(u.hex, e.hex) > UT[u.k].mp + 1) continue;
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
      const prio = (objective && Hex.hexDist(e.hex, objective.hex) <= 1 ? 1.6 : 1) * (this.ptAt(e.hex) ? 1.3 : 1);
      const score = (o.expD * val(e) / MAX_STR * (1 + o.retreat) - o.expA * val(lead.u) / MAX_STR) * prio;
      if (o.r * (prio > 1 ? 1.15 : 1) < thr || score <= ps) continue;
      ps = score; plan = { e, group };
    }
    if (!plan) return false;
    for (const c of plan.group) if (c.u.hex !== c.h) this.act(side, { t: 'move', id: c.u.id, to: c.h });
    for (const c of plan.group) {
      const e = this.byId(plan.e.id);
      if (!e || c.u.str <= 0 || c.u.acted || Hex.hexDist(c.u.hex, e.hex) !== 1) continue;
      const o = Rules.odds(this.ctxFor(side, false), c.u, e);
      if (o.r < Math.max(1, thr * .7)) continue;
      this.act(side, { t: 'attack', id: c.u.id, target: e.id });
    }
    return true;
  },

  /** куда идти части, если не атакует */
  botMove(u, objective, dir) {
    const side = u.side, T = UT[u.k];
    /* гарнизон: пехота в своём городе (и в главной точке сценария) остаётся на месте */
    const here = this.ptAt(u.hex);
    if (here && here.owner === side && T.cap && (here.city || (this.scen && this.scen.target === here.id)) && u.str > 3 &&
      (u.k === 'inf' || (this.scen && this.scen.target === here.id) || !this.units.some(v => v !== u && v.side === side && v.str > 0 && Hex.hexDist(v.hex, u.hex) <= 1))) return;
    const ctx = this.ctxFor(side, false), reach = Rules.reachable(ctx, u);
    const supply = this.supplyHex && this.supplyHex[side];
    const known = this.units.filter(e => e.side !== side && e.str > 0 && this.seen(side, e));
    const danger = h => known.filter(e => Hex.hexDist(e.hex, h) === 1).length;
    const front = h => (this.map.hexes[h].x - this.frontXAt(this.map.hexes[h].y)) * dir;   /* >0 — за линией фронта у противника */
    const com = this.commanders[side];
    let goal = null, mode = 'line';
    if ((u.str <= com.aggr.retreat || u.org < 30) && !T.bomb) {
      goal = this.pts.filter(p => p.owner === side && p.city).sort((a, b) => Hex.hexDist(a.hex, u.hex) - Hex.hexDist(b.hex, u.hex))[0];
      mode = 'rest';
    } else if (T.bomb) mode = 'arty';
    else if (u.k === 'hq') mode = 'hq';
    else if (u.k === 'aa') mode = 'aa';
    else if (objective && (this.role[side] !== 'defender' || objective.owner === side)) { goal = objective; mode = 'attack' }
    let best = u.hex, bs = -1e9;
    for (const [h, r] of reach) {
      if (r.through) continue;
      const hx = this.map.hexes[h], dg = danger(h);
      let s = TERR[hx.t] * .8 + (supply && supply.has(h) ? 4 : -8) - r.c * .1;
      if (mode === 'rest') s += -Hex.hexDist(h, goal ? goal.hex : h) * 3 - dg * 6;
      else if (mode === 'attack') s += -Hex.hexDist(h, goal.hex) * 3 - dg * (u.str >= 7 && T.arm === 'hard' ? 1 : 4);
      else if (mode === 'arty') s += -Math.abs(front(h) + 2.5 * Hex.HW) / Hex.HW * 3 - dg * 10 + (known.some(e => Hex.hexDist(e.hex, h) <= T.bomb.rng) ? 4 : 0);
      else if (mode === 'hq' || mode === 'aa') {
        const mates = this.units.filter(v => v.side === side && v.str > 0 && v !== u && !UT[v.k].bomb);
        const cx = mates.reduce((a, v) => a + this.map.hexes[v.hex].x, 0) / Math.max(1, mates.length), cy = mates.reduce((a, v) => a + this.map.hexes[v.hex].y, 0) / Math.max(1, mates.length);
        s += -Math.hypot(hx.x - cx + dir * (mode === 'hq' ? 25 : 12), hx.y - cy) / Hex.HW * 2 - dg * 10;
      } else {
        /* рубеж: держаться у линии фронта со своей стороны, у своих точек */
        const p = this.pts.filter(q => q.owner === side).sort((a, b) => Hex.hexDist(a.hex, h) - Hex.hexDist(b.hex, h))[0];
        s += -Math.abs(front(h) + Hex.HW) / Hex.HW * 2.5 - (p ? Math.max(0, Hex.hexDist(p.hex, h) - 3) : 0) - dg * 2;
        if (h === u.hex) s += 1.5 + u.ent;   /* окопавшиеся неохотно уходят */
      }
      if (s > bs) { bs = s; best = h }
    }
    if (best !== u.hex) this.act(side, { t: 'move', id: u.id, to: best });
  },

  /** сапёры: понтон к цели через реку, мины перед угрожаемой точкой, окопать соседей */
  botEngineer(u, objective) {
    const side = u.side, ctx = this.ctxFor(side, true);
    if (objective && objective.owner !== side) {
      for (let d = 0; d < 6; d++) {
        const h = Hex.nb(u.hex, d);
        if (h < 0) continue;
        const e = Rules.edgeOf(ctx, u.hex, d);
        if ((e & Hex.RIV) && !(e & Hex.BR) && Hex.hexDist(h, objective.hex) < Hex.hexDist(u.hex, objective.hex)) return this.act(side, { t: 'eng', id: u.id, task: 'bridge', hex: h }).ok;
      }
    }
    if (u.mines > 0) {
      const en = side === N ? S : N;
      const threat = this.units.filter(e => e.side === en && e.str > 0 && this.seen(side, e)).sort((a, b) => Hex.hexDist(a.hex, u.hex) - Hex.hexDist(b.hex, u.hex))[0];
      if (threat && Hex.hexDist(threat.hex, u.hex) <= 3) {
        const h = Hex.neighbors(u.hex).filter(x => !this.unitAt(x) && !this.mines.has(x)).sort((a, b) => Hex.hexDist(a, threat.hex) - Hex.hexDist(b, threat.hex))[0];
        if (h !== undefined) return this.act(side, { t: 'eng', id: u.id, task: 'mine', hex: h }).ok;
      }
    }
    /* укрепить угрожаемую свою точку рядом (или клетку с нашей частью), против танков — заграждения */
    const en = side === N ? S : N, foes = this.units.filter(e => e.side === en && e.str > 0 && this.seen(side, e));
    const threatened = h => foes.some(e => Hex.hexDist(e.hex, h) <= 3);
    for (const h of [u.hex, ...Hex.neighbors(u.hex)]) {
      const occ = this.unitAt(h), p = this.ptAt(h);
      if ((occ && occ.side !== side) || this.map.hexes[h].t === 'lake') continue;
      if ((p && p.owner === side || (occ && occ.side === side && UT[occ.k].cap)) && threatened(h) && (this.forts.get(h) || 0) < 2) return this.act(side, { t: 'eng', id: u.id, task: 'fort', hex: h }).ok;
    }
    if (foes.some(e => UT[e.k].arm === 'hard' && Hex.hexDist(e.hex, u.hex) <= 4)) {
      const h = Hex.neighbors(u.hex).filter(x => !this.unitAt(x) && !this.obst.has(x) && this.map.hexes[x].t !== 'lake').sort((a, b) => Math.min(...foes.map(e => Hex.hexDist(e.hex, a))) - Math.min(...foes.map(e => Hex.hexDist(e.hex, b))))[0];
      if (h !== undefined) return this.act(side, { t: 'eng', id: u.id, task: 'obst', hex: h }).ok;
    }
    if (!u.moved && Hex.neighbors(u.hex).some(h => { const v = this.unitAt(h); return v && v.side === side && v.ent < 2 })) return this.act(side, { t: 'dig', id: u.id }).ok;
    return false;
  },

  botBuy(side) {
    const mix = { ...(MIX[this.role[side]] || MIX.both) };
    if (!this.units.some(u => u.side === side && u.k === 'hq' && u.str > 0)) mix.hq = 30;
    const armor = this.units.filter(e => e.side !== side && e.str > 0 && UT[e.k].arm === 'hard' && this.seen(side, e)).length;
    if (armor >= 2) mix.at += 2;
    for (let i = 0; i < 3; i++) {
      if (this.budget[side] < 60) return;
      const k = this.wantKind(side, mix);
      if (!k) return;
      const fx = h => Math.abs(this.map.hexes[h].x - this.frontXAt(this.map.hexes[h].y));
      /* поближе к фронту, но не вплотную: в самой точке — пехота, рядом — остальные */
      const cand = this.spawnHexes(side, k).sort((a, b) => fx(a) - fx(b) + ((this.ptAt(a) ? 1 : 0) - (this.ptAt(b) ? 1 : 0)) * (k === 'inf' ? -3 : 3));
      let ok = false;
      for (const h of cand) if (this.buy(side, k, h, false).ok) { ok = true; break }
      if (!ok) return;
    }
  }
};
