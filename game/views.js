'use strict';
/* ============================================================
   СНИМОК «ГЛАЗАМИ СТОРОНЫ» — туман войны.
   Свои части целиком; чужие — только видимые (тип, сила, окоп);
   «призраки» — где противника видели последний раз. Видимые
   клетки (vis) клиент рисует светлее, остальное — в дымке.
   Зритель ('spec') видит всё.
   ============================================================ */
const W = require('../shared/world');
const Hex = require('../shared/hex');
const { N, S, UT, GAME_VERSION, isNight, turnClock, dayOfTurn } = W;

module.exports = {
  unitView(u, full) {
    const o = { id: u.id, k: u.k, side: u.side, hex: u.hex, str: u.str, ent: u.ent, sup: u.sup ? 1 : 0, sp: u.sp, hold: u.hold ? 1 : 0, mil: u.militia ? 1 : 0, hb: u.hb || 0 };
    if (!full) return Object.assign(o, { enemy: 1 });
    return Object.assign(o, {
      org: Math.round(u.org), xp: +u.xp.toFixed(2), mp: +u.mp.toFixed(1), acted: u.acted ? 1 : 0, moved: u.moved ? 1 : 0,
      supplied: u.supplied ? 1 : 0, cut: u.cut, reload: u.reload, mines: u.mines, cs: u.cs, trait: u.trait, pre: u.pre ? 1 : 0,
      /* чьё это: своё или союзного командира. Только для своей стороны — противнику состав не раскрываем */
      seat: u.seat,
      amb: u.amb ? 1 : 0, support: u.support ? 1 : 0, over: u.over ? 1 : 0, march: u.march ? 1 : 0, exploit: u.exploit ? 1 : 0
    });
  },
  /** seat — место зрителя снимка; для одноместной стороны это её буква.
      Туман войны, перевес и статистика — на сторону, кошелёк и вылеты — на место. */
  snapshotFor(seat) {
    const spec = seat === 'spec';
    const side = spec ? 'spec' : (this.sideOf ? this.sideOf(seat) || seat : seat);
    const units = [];
    for (const u of this.units) {
      if (u.str <= 0) continue;
      if (spec || u.side === side) units.push(this.unitView(u, true));
      else if (this.phase === 'battle' && this.seen(side, u)) units.push(this.unitView(u, false));
    }
    const ghosts = [];
    if (!spec) for (const [id, m] of this.mem[side]) if (!units.some(x => x.id === id)) ghosts.push({ id, hex: m.hex, k: m.k, age: this.turn - m.turn });
    const mines = [];
    for (const [h, m] of this.mines) if (spec || m.side === side || (m.known && m.known[side])) mines.push({ hex: h, side: m.side });
    const sv = s => { const e = this.stats[s]; return { lost: e.lost, killed: e.killed, lostV: e.lostV, killedV: e.killedV, spent: e.spent, caps: e.caps, routs: e.routs, prisoners: e.prisoners } };
    return {
      v: GAME_VERSION, side, spec: spec ? 1 : 0, mode: this.mode, map: this.mapId,
      forts: [...this.forts.entries()], obst: [...this.obst.keys()], role: this.role, phase: this.phase, ready: this.ready, over: this.over,
      /* состав команд: клиент показывает, кто на каком месте и кто ещё не закончил ход */
      seat: spec ? null : seat,
      seats: (this.seats || []).map(st => ({ id: st.id, side: st.side, n: st.n, bot: !!this.bots[st.id], ready: !!this.ready[st.id], done: !!this.done[st.id] })),
      waiting: spec ? null : (this.pending ? this.pending(this.active).map(st => st.id) : []),
      turn: this.turn, limit: this.limit, active: this.active, clock: turnClock(this.turn), day: dayOfTurn(this.turn), night: isNight(this.turn),
      weather: this.weather.id, score: +this.score.toFixed(1),
      commanders: { n: { name: this.commanders.n.name, trait: this.commanders.n.trait }, s: { name: this.commanders.s.name, trait: this.commanders.s.trait } },
      budget: spec ? { n: Math.floor(this.budget.n), s: Math.floor(this.budget.s) } : Math.floor(this.budget[seat]),
      income: spec ? this.income : this.income[seat], air: spec ? this.air : this.air[seat],
      pts: this.pts.map(p => ({ id: p.id, n: p.n, city: p.city, hex: p.hex, w: p.w, owner: p.owner, home: p.home })),
      units, ghosts, mines, br: [...this.br.entries()],
      vis: spec ? null : [...this.vis[side]],
      supply: spec ? null : [...((this.supplyHex && this.supplyHex[side]) || new Map()).keys()],
      dist: spec ? null : [].concat(...[...this.districtOf[side]].map(([h, i]) => [h, i])),
      districts: spec ? null : this.districts[side].map(d => ({ n: d.n, hex: d.hex, cap: d.cap, used: d.used })),
      cp: spec ? this.cp : this.cp[seat], barrage: spec ? this.barrage : this.barrage[side], counter: spec ? this.counter : this.counter[side], smoke: [...this.smoke.keys()],
      frontY: this.frontY,
      scen: this.scen ? { id: this.scenId, n: this.scen.n, brief: this.scen.brief, target: this.scen.target, left: this.limit - this.turn, deploy: this.scen.deploy && !spec ? this.scen.deploy[side] : null, raid: this.raidV ? this.raidLeft() : null } : null,
      stats: spec ? sv(N) : sv(side), enemyStats: spec || this.over ? sv(spec ? S : side === N ? S : N) : null,
      history: this.history
    };
  },
  raidLeft() {
    const left = this.units.filter(u => u.raid && u.str > 0).reduce((s, u) => s + UT[u.k].price * u.str / 10, 0);
    return Math.round(100 * (1 - left / this.raidV));
  }
};
