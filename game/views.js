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
  unitView(u, full, intel) {
    const o = { id: u.id, k: u.k, side: u.side, hex: u.hex, str: u.str, ent: u.ent, sup: u.su > 0 ? 1 : 0, su: u.su || 0, att: u.att || null, sp: u.sp, hold: u.hold ? 1 : 0, mil: u.militia ? 1 : 0, hb: u.hb || 0 };
    if (u.rem) o.rem = 1;
    if (UT[u.k].depot) o.lvl = u.lvl || 1;
    /* разведка боем: о вскрытой части известно то же, что о своей в бою */
    if (!full && intel) Object.assign(o, { intel: 1, org: Math.round(u.org), xp: +u.xp.toFixed(2), fu: u.fu, supplied: u.supplied ? 1 : 0, sv: u.sv || 0, amb: u.amb ? 1 : 0, rear: u.rear ? 1 : 0 });
    if (!full) return Object.assign(o, { enemy: 1 });
    Object.assign(o, { rear: u.rear ? 1 : 0, prep: u.prep ? 1 : 0, fed: u.fed ? 1 : 0 });
    return Object.assign(o, {
      org: Math.round(u.org), xp: +u.xp.toFixed(2), fu: u.fu, mp: +u.mp.toFixed(1), acted: u.acted ? 1 : 0, moved: u.moved ? 1 : 0,
      supplied: u.supplied ? 1 : 0, cut: u.cut, reload: u.reload, mines: u.mines, cs: u.cs, trait: u.trait, pre: u.pre ? 1 : 0,
      /* чьё это: своё или союзного командира. Только для своей стороны — противнику состав не раскрываем */
      seat: u.seat,
      amb: u.amb ? 1 : 0, support: u.support ? 1 : 0, sv: u.sv || 0, march: u.march ? 1 : 0, exploit: u.exploit ? 1 : 0,
      /* командный пункт: развёрнут ли. Клиент по этому полю ведёт командира
         через обязательный шаг расстановки */
      sited: u.sited === false ? 0 : 1
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
      else if (this.phase === 'battle' && this.seen(side, u)) units.push(this.unitView(u, false, this.hasIntel(side, u)));
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
      /* экономика союзников — только своей команде: сколько у кого очков и дохода.
         Сумма долей равна доходу стороны (движок делит остаток без потерь). */
      team: spec ? null : this.seatsOf(side).map(st => ({
        id: st.id, budget: Math.floor(this.budget[st.id]), income: this.income[st.id] || 0, cp: this.cp[st.id] || 0
      })),
      sideIncome: spec ? null : ((this.sideIncome || {})[side] || 0),
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
      /* территория (видна обеим сторонам, как в Order of Battle) и своё поле снабжения:
         по символу на клетку — компактно, ~2 тыс. знаков на снимок */
      terr: String.fromCharCode(...this.terr.map(v => 48 + v)),
      /* снабжение: '0'–'9','a' — поле, 'A'–'K' — клетка на линии снабжения (дорога) */
      sv: spec ? null : String.fromCharCode(...this.sv[side].map((v, h) => this.svNet[side][h] ? 65 + v : v < 10 ? 48 + v : 97)),
      svSrc: spec ? null : (this.svSrc[side] || []).map(x => ({ hex: x.hex, v: x.v, n: x.n, k: x.k })),
      cp: spec ? this.cp : this.cp[seat], barrage: spec ? this.barrage : this.barrage[side], counter: spec ? this.counter : this.counter[side], smoke: [...this.smoke.keys()],
      frontY: this.frontY, pockets: this.phase === 'battle' ? this.pockets(side) : [],
      scen: this.scen ? { id: this.scenId, n: this.scen.n, brief: this.scen.brief, target: this.scen.target, left: this.limit - this.turn, deploy: this.scen.deploy && !spec ? this.scen.deploy[side] : null, raid: this.raidV ? this.raidLeft() : null } : null,
      stats: spec ? sv(N) : sv(side), enemyStats: spec || this.over ? sv(spec ? S : side === N ? S : N) : null,
      history: this.history
    };
  },
  /** свежи ли сведения разведки боем о части u у стороны side */
  hasIntel(side, u) {
    const t = this.intel && this.intel[side] && this.intel[side].get(u.id);
    return t !== undefined && this.turn - t <= W.PROBE.intel;
  },
  /** котлы: острова земли стороны, где нет ни тыловой станции, ни своего города.
      У противника считаются по открытым сведениям (территория и точки видны обеим
      сторонам): его командные пункты и склады в расчёт не идут — их положение не выдаём.
      Свои (и для зрителя) — со всеми источниками. */
  pockets(viewer) {
    const out = [], NH = this.H.NH, seen = new Uint8Array(NH);
    for (const side of [N, S]) {
      const t = side === N ? 1 : 2;
      const all = viewer === side || viewer === 'spec';
      const src = new Set(this.supplySources(side).concat(all ? this.depotSources(side) : []).filter(x => all || x.k === 'rear' || x.k === 'city').map(x => x.hex));
      for (let h0 = 0; h0 < NH; h0++) {
        if (seen[h0] || this.terr[h0] !== t) continue;
        const comp = [h0]; seen[h0] = 1;
        let fed = false;
        for (let i = 0; i < comp.length; i++) {
          if (src.has(comp[i])) fed = true;
          for (const n of this.H.neighbors(comp[i])) if (!seen[n] && this.terr[n] === t) { seen[n] = 1; comp.push(n) }
        }
        if (!fed && comp.length <= 60) out.push({ side, hexes: comp });
      }
    }
    return out;
  },
  raidLeft() {
    const left = this.units.filter(u => u.raid && u.str > 0).reduce((s, u) => s + UT[u.k].price * u.str / 10, 0);
    return Math.round(100 * (1 - left / this.raidV));
  }
};
