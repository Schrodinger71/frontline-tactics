'use strict';
/* ============================================================
   СЦЕНАРИИ «FRONTLINE TACTICS» — те же операции, что в «Линии», на
   гексах. Силы ставятся по координатам (клетка под точкой),
   подкрепления приходят в начале указанного хода (раунда).
     start  — номер хода начала (0 — 06:00, 4 — 22:00)
     turns  — сколько ходов на задачу
     deploy — зоны расстановки докупленного (x от — до)
   ============================================================ */
const W = require('../shared/world');
const Hex = require('../shared/hex');
const { N, S, UT } = W;

const SCEN = {
  bridge: {
    n: 'Мост через Тихую',
    brief: 'Восток держит большой мост у посёлка Мост. Западу нужно взять переправу за 6 ходов, пока не подошли резервы. Мост могут взорвать — тогда понадобятся сапёры и понтон.',
    map: 'valley', roles: { n: 'attacker', s: 'defender' }, start: 0, turns: 6, weather: 'cloud', budget: { n: 250, s: 150 }, target: 'most',
    deploy: { n: [100, 150], s: [175, 230] },
    forces: {
      n: [['hq', 128, 160], ['tnk', 150, 145], ['tnk', 150, 160], ['tnk', 142, 152], ['mot', 140, 168], ['mot', 145, 138], ['inf', 155, 152], ['inf', 155, 168],
        ['art', 132, 150], ['art', 132, 170], ['mlrs', 122, 155], ['rec', 158, 140], ['eng', 145, 175], ['aa', 136, 160]],
      s: [['hq', 205, 150], ['inf', 168, 154, { ent: 3 }], ['inf', 163, 147, { ent: 3 }], ['inf', 163, 162, { ent: 3 }], ['inf', 172, 140, { ent: 2 }], ['inf', 168, 168, { ent: 2 }],
        ['tnk', 176, 154, { ent: 1 }], ['tnk', 180, 165, { ent: 1 }], ['art', 192, 150], ['art', 195, 162], ['eng', 185, 165], ['rec', 176, 130, { ent: 2 }], ['aa', 190, 160]]
    },
    mines: [[S, 155, 147], [S, 155, 162], [S, 158, 154]],
    reinf: [
      { turn: 2, side: S, units: [['tnk', 225, 155], ['mot', 228, 145]], msg: 'Из Заречья подошла танковая рота с мотопехотой.' },
      { turn: 3, side: N, units: [['tnk', 115, 150], ['mot', 115, 165]], msg: 'Второй эшелон на подходе.' },
      { turn: 4, side: S, units: [['inf', 230, 150], ['art', 235, 160]], msg: 'Подтянулась пехота и вторая батарея.' }
    ],
    win(g) { return g.pts.find(p => p.id === 'most').owner === N ? { w: N, t: 'Переправа у Моста в руках Запада.' } : null },
    timeout() { return { w: S, t: 'Мост не взят: Восток подтянул резервы, наступление захлебнулось.' } }
  },
  breakthrough: {
    n: 'Прорыв к Красногору',
    brief: 'Первая полоса у Бродов прорвана. За 12 ходов взять Красногор — узел дорог и столицу Востока. Перед Степным — мины, к Востоку подходят резервы.',
    map: 'valley', roles: { n: 'attacker', s: 'defender' }, start: 0, turns: 12, weather: 'clear', budget: { n: 400, s: 250 }, target: 'kras',
    deploy: { n: [120, 175], s: [205, 296] }, owner: { brod: N, most: N, olh: N },
    forces: {
      n: [['hq', 145, 210], ['tnk', 165, 200], ['tnk', 168, 215], ['tnk', 160, 228], ['tnk', 170, 190], ['mot', 160, 185], ['mot', 162, 240], ['mot', 172, 225],
        ['inf', 158, 205], ['inf', 156, 220], ['art', 145, 200], ['art', 148, 225], ['mlrs', 138, 212], ['eng', 155, 232], ['aa', 150, 212], ['rec', 175, 205]],
      s: [['hq', 275, 205], ['inf', 198, 250, { ent: 3 }], ['inf', 205, 238, { ent: 2 }], ['inf', 195, 262, { ent: 2 }], ['inf', 262, 210, { ent: 3 }], ['inf', 228, 86, { ent: 2 }],
        ['tnk', 235, 215, { ent: 1 }], ['tnk', 225, 240], ['art', 245, 230], ['art', 240, 205], ['aa', 250, 215], ['rec', 210, 225, { ent: 2 }], ['eng', 230, 228], ['mot', 250, 245]]
    },
    mines: [[S, 188, 245], [S, 190, 258], [S, 205, 225], [S, 214, 214]],
    reinf: [
      { turn: 3, side: S, units: [['tnk', 285, 220], ['mot', 285, 205]], msg: 'С востока подошла бригадная группа.' },
      { turn: 6, side: S, units: [['mot', 285, 230], ['art', 285, 195], ['inf', 285, 212]], msg: 'Ещё одна колонна резервов вошла в Красногор.' },
      { turn: 5, side: N, units: [['tnk', 130, 210], ['mot', 130, 225]], msg: 'Командование выделило ещё танковую роту.' }
    ],
    win(g) { return g.pts.find(p => p.id === 'kras').owner === N ? { w: N, t: 'Красногор взят. Фронт Востока расколот.' } : null },
    timeout() { return { w: S, t: 'Срок вышел, Красногор устоял.' } }
  },
  night: {
    n: 'Ночной рейд',
    brief: 'Ночь. Под Заречьем Восток собрал артиллерию, РСЗО и штаб армии. За 3 хода до рассвета рейдовая группа Запада должна уничтожить больше половины этого кулака.',
    map: 'valley', roles: { n: 'attacker', s: 'defender' }, start: 4, turns: 3, weather: 'cloud', budget: { n: 0, s: 0 }, target: 'zar', noDeploy: true,
    forces: {
      n: [['hq', 150, 110], ['rec', 175, 98], ['rec', 172, 122], ['mot', 165, 105], ['mot', 160, 118], ['mot', 162, 92], ['tnk', 155, 100], ['tnk', 155, 115], ['eng', 150, 125]],
      s: [['hq', 250, 92, { raid: 1, ent: 1 }], ['art', 236, 100, { raid: 1 }], ['art', 240, 108, { raid: 1 }], ['art', 232, 112, { raid: 1 }], ['mlrs', 245, 115, { raid: 1 }], ['mlrs', 250, 105, { raid: 1 }],
        ['inf', 215, 95, { ent: 2 }], ['inf', 220, 112, { ent: 2 }], ['inf', 210, 80, { ent: 2 }], ['aa', 242, 98], ['rec', 200, 100, { ent: 2 }], ['tnk', 228, 125, { ent: 1 }]]
    },
    reinf: [{ turn: 5, side: S, units: [['mot', 275, 100], ['tnk', 275, 112]], msg: 'Тревога — из тыла идёт дежурная группа.' }],
    win(g) {
      const left = g.units.filter(u => u.side === S && u.raid && u.str > 0).reduce((s, u) => s + UT[u.k].price * u.str / 10, 0);
      return left < g.raidV * .5 ? { w: N, t: 'Артиллерийский кулак Востока разгромлен до рассвета.' } : null;
    },
    timeout() { return { w: S, t: 'Рассвело — рейд не удался, батареи Востока уцелели.' } }
  }
};
const CAMPAIGN = ['bridge', 'breakthrough', 'night'];

module.exports = {
  SCEN, CAMPAIGN,
  applyScenario(id) {
    const sc = SCEN[id];
    this.scen = sc; this.scenId = id;
    this.role = { ...sc.roles };
    this.turn = sc.start; this.limit = sc.start + sc.turns;
    this.weather = require('../shared/weather').wxById(sc.weather);
    this.budget = { n: sc.budget.n, s: sc.budget.s };
    this.units = []; this._cs = { n: 0, s: 0 };
    for (const [pid, side] of Object.entries(sc.owner || {})) { const p = this.pts.find(q => q.id === pid); if (p) p.owner = side }
    for (const side of [N, S]) for (const [k, x, y, o] of sc.forces[side]) this.placeAt(side, k, x, y, o);
    for (const [side, x, y] of sc.mines || []) { const h = Hex.hexAt(x, y); if (h >= 0) this.mines.set(h, { side, str: 1, known: { [side]: true } }) }
    this.raidV = this.units.filter(u => u.raid).reduce((s, u) => s + UT[u.k].price, 0);
    this.events = [];
    this.log('*', `${sc.n}. ${sc.brief}`, 'hq');
  },
  /** поставить часть в клетку под точкой (или в ближайшую свободную рядом) */
  placeAt(side, k, x, y, o) {
    const h = this.freeHex(x, y, k);
    if (h < 0 || this.unitAt(h)) return null;
    const u = this.spawn(k, side, h, Object.assign({ pre: true }, o || {}));
    return u;
  },
  scenarioRound() {
    const sc = this.scen;
    if (!sc) return;
    this.reinfDone = this.reinfDone || new Set();
    (sc.reinf || []).forEach((r, i) => {
      if (this.reinfDone.has(i) || this.turn - sc.start < r.turn) return;
      this.reinfDone.add(i);
      for (const [k, x, y] of r.units) this.placeAt(r.side, k, x, y, {});
      this.log(r.side, 'Подкрепление: ' + r.msg, 'g');
      this.log(r.side === N ? S : N, 'Разведка: к противнику подходят резервы.', 'w');
    });
  },
  scenarioEnd() {
    const sc = this.scen, r = sc.win(this);
    if (r) return r;
    if (this.turn >= this.limit) return sc.timeout(this);
    return null;
  }
};
