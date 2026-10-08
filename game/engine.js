'use strict';
/* ============================================================
   ДВИЖОК ПАРТИИ «FRONTLINE TACTICS»
   ------------------------------------------------------------
   Состояние партии и действия сторон. Ходят по очереди: сторона
   отдаёт сколько угодно действий своими частями и жмёт «Конец
   хода». Каждое действие проверяется по тем же правилам, что
   показывает клиент (shared/rules.js), но с полной правдой:
   идёшь вслепую — можешь наткнуться на невидимого противника и
   встать.

   Действия: move · attack · bombard · air · eng · dig · ambush · buy ·
   replace · order (приказы штаба за командные очки) ·
   sell / place / ready (расстановка) · end.

   Снабжение: округа от своих городов (вместимость и дальность — по
   весу города) и от тыла (край карты). У части запас 0–3: в котле
   тает по делению за ход — за три хода часть теряет боеспособность,
   дальше несёт потери и сдаётся. В перегруженном округе запас не
   поднимается выше 2.

   Прорыв: танки, мотопехота и разведка, выбившие противника, могут
   действовать ещё раз. Ополчение: пустой город, к которому подошёл
   противник, один раз выставляет защитников. Трофеи: взятый чужой
   город отдаёт склады (очки и командное очко).

   Оборона: укрепления и заграждения (сапёры, готовые — на картах),
   огонь поддержки (артиллерия, не стрелявшая в свой ход, прикрывает
   соседей в чужой ход), засада (часть встречает огнём того, кто
   вошёл рядом), противотанковые дивизионы.
   После хода стороны: окапывание, мораль, снабжение и котлы,
   перевес; потом — ход другой стороны (доход, очки хода, обзор).

   События (this.events) клиент проигрывает по очереди:
   движение по клеткам, бой с потерями, огонь, захват, сводки.
   ============================================================ */
const W = require('../shared/world');
const Hex = require('../shared/hex');
const Rules = require('../shared/rules');
const Terrain = require('../shared/terrain');
const { MAPS } = require('../shared/maps');
const { WEATHER, wxById } = require('../shared/weather');
const { N, S, UT, MAX_STR, POINT_DEF, SIDE_NAME, CS_N, CS_S, TRAITS, GEN_FIRST, GEN_LAST, PRICE_OF, AIR,
  clamp, mulberry, pick, isNight, turnClock } = Object.assign({ PRICE_OF: k => W.UT[k].price }, W);
const { phr } = require('./phrases');
const oppOf = s => s === N ? S : N;

const AGGR = {
  'решительный': { ratio: 1.1, retreat: 3, buyArm: 1.3 },
  'осторожный':  { ratio: 1.8, retreat: 5, buyArm: .9 },
  'методичный':  { ratio: 1.5, retreat: 4, buyArm: 1 },
  'нервный':     { ratio: 1.3, retreat: 5, buyArm: 1 },
  'упрямый':     { ratio: 1.4, retreat: 2, buyArm: 1.1 }
};

class Game {
  constructor(mode, creatorSide, seed, mapId) {
    const scen = require('./scenarios').SCEN[mode];
    this.mapId = scen ? scen.map || 'valley' : typeof mapId === 'string' && Object.prototype.hasOwnProperty.call(MAPS, mapId) ? mapId : 'valley';
    this.mapDef = MAPS[this.mapId];
    this.map = Hex.build(this.mapId);
    this.mode = mode;
    this.role = { n: 'both', s: 'both' };
    if (mode === 'defense') { this.role[creatorSide] = 'defender'; this.role[oppOf(creatorSide)] = 'attacker' }
    else if (mode === 'attack') { this.role[creatorSide] = 'attacker'; this.role[oppOf(creatorSide)] = 'defender' }
    this.rnd = mulberry((seed === undefined ? Date.now() : seed) & 0xffffffff);
    this.units = []; this.events = []; this.idc = 1; this._cs = { n: 0, s: 0 };
    this.turn = 0; this.active = N; this.phase = 'deploy'; this.over = null; this.score = 0;
    this.bots = { n: false, s: false };
    this.br = new Map();              /* мосты: ключ → 'down' | 'pontoon' */
    this.mines = new Map();           /* клетка → { side, str } */
    this.forts = new Map();           /* клетка → уровень укреплений 1–2 */
    this.obst = new Map();            /* клетка → сторона, поставившая заграждения */
    this.smoke = new Map();           /* клетка → сторона, поставившая дым (до её следующего хода) */
    this.militiaUsed = new Set(); this.looted = new Set();
    this.districts = { n: [], s: [] }; this.districtOf = { n: new Map(), s: new Map() };
    this.vis = { n: new Set(), s: new Set() };
    this.mem = { n: new Map(), s: new Map() };
    this.air = { n: { strike: 0, recon: 0 }, s: { strike: 0, recon: 0 } };
    this.recon = { n: new Set(), s: new Set() };
    this.weather = wxById('clear'); this.wxLeft = 3 + Math.floor(this.rnd() * 4);
    this.commanders = { n: this.makeCommander(), s: this.makeCommander() };
    this.pts = this.mapDef.points.map(p => ({ ...p, hex: Hex.hexAt(p.x, p.y), home: p.owner }));
    for (const [side, x, y, lvl] of this.mapDef.forts || []) { const h = Hex.hexAt(x, y); if (h >= 0) this.forts.set(h, lvl || 1) }
    for (const [side, x, y] of this.mapDef.obst || []) { const h = Hex.hexAt(x, y); if (h >= 0) this.obst.set(h, side) }
    for (const [side, x, y] of this.mapDef.mines || []) { const h = Hex.hexAt(x, y); if (h >= 0) this.mines.set(h, { side, str: 1, known: { [side]: true } }) }
    this.ready = { n: false, s: false };
    this.budget = { n: Math.round(W.START_BUDGET * (W.ROLE_BUDGET_MUL[this.role.n] || 1)), s: Math.round(W.START_BUDGET * (W.ROLE_BUDGET_MUL[this.role.s] || 1)) };
    this.income = { n: 0, s: 0 };
    this.cp = { n: W.CP.start, s: W.CP.start };
    this.barrage = { n: false, s: false };
    this.counter = { n: false, s: false };
    this.stats = { n: this.newStats(), s: this.newStats() };
    this.history = [];
    this.limit = W.TURN_LIMIT;
    /* штаб каждой стороне — бесплатно, в глубине */
    this.spawn('hq', N, this.freeHex(45, 220, 'hq')); this.spawn('hq', S, this.freeHex(255, 220, 'hq'));
    this.log('*', 'Расстановка: купите части во вкладке «Закупка» и поставьте их в своей зоне. Потом — «Готов».', 'hq');
    if (require('./scenarios').SCEN[mode]) this.applyScenario(mode);
    this.rebuildFront();
  }
  newStats() { return { spent: 0, lost: {}, killed: {}, lostV: 0, killedV: 0, caps: 0, routs: 0, prisoners: 0 } }
  makeCommander() { const trait = pick(this.rnd, TRAITS); return { trait, name: pick(this.rnd, GEN_FIRST) + ' ' + pick(this.rnd, GEN_LAST), aggr: AGGR[trait] } }
  R(a, b) { return a + this.rnd() * (b - a) }
  chance(p) { return this.rnd() < p }

  /* ---------- события ---------- */
  log(to, text, cls, cs) { if (text) this.events.push({ e: 'log', to, turn: this.turn, text, cls: cls || '', cs: cs || null }) }
  say(u, key, args, cls) { this.log(u.side, phr(key, args || {}, u), cls || '', u.cs) }
  ev(o) { this.events.push(o) }
  drainEvents() { const e = this.events; this.events = []; return e }

  /* ---------- части ---------- */
  spawn(k, side, hex, o) {
    const bag = side === N ? CS_N : CS_S, n = this._cs[side]++;
    const u = {
      id: this.idc++, k, side, hex, str: MAX_STR, org: 100, xp: .15, ent: 0, mp: 0, acted: false, moved: false, sup: false,
      supplied: true, cut: 0, sp: W.SUPPLY.max, reload: 0, mines: UT[k].eng ? 2 : 0, revealed: -1,
      cs: bag[n % bag.length] + '-' + (11 + (n * 7) % 88), trait: pick(this.rnd, TRAITS)
    };
    Object.assign(u, o || {});
    this.units.push(u);
    return u;
  }
  /** проходима ли клетка для части такого типа (озеро — ни для кого, горы — только пешим) */
  passable(k, hex) {
    const t = this.map.hexes[hex].t;
    if (t === 'lake') return false;
    if (t === 'mount' && UT[k].cls !== 'foot') return this.map.hexes[hex].road;
    return true;
  }
  /** ближайшая свободная проходимая клетка к точке */
  freeHex(x, y, k) {
    let h = Hex.hexAt(x, y);
    if (h >= 0 && !this.unitAt(h) && this.passable(k, h)) return h;
    for (let r = 1; r < 6; r++) for (const n of Hex.within(h, r)) if (!this.unitAt(n) && this.passable(k, n)) return n;
    return h;
  }
  unitAt(hex) { return this.units.find(u => u.hex === hex && u.str > 0) }
  byId(id) { return this.units.find(u => u.id === id && u.str > 0) }
  ptAt(hex) { return this.pts.find(p => p.hex === hex) }

  /** что известно стороне о поле: для правил движения и боя */
  ctxFor(side, truth) {
    const occ = new Map();
    for (const u of this.units) {
      if (u.str <= 0) continue;
      if (truth || u.side === side || this.vis[side].has(u.hex) && this.seen(side, u)) occ.set(u.hex, u);
    }
    const support = { n: new Set(), s: new Set() };
    for (const u of this.units) if (u.support && u.str > 0 && (truth || u.side === side || occ.get(u.hex) === u)) for (const h of Hex.within(u.hex, UT[u.k].bomb.rng)) support[u.side].add(h);
    return {
      map: this.map, br: this.br, occ, mines: this.mines, forts: this.forts, obst: this.obst, support, side, smoke: this.smoke,
      mud: !!this.weather.mud && this.weather.mud < .8, night: isNight(this.turn), acc: this.weather.acc || 1,
      cmd: this.cmdHexes(side), counter: this.counterHexes(side)
    };
  }
  /** клетки «Контрудара»: исходные точки стороны и соседние с ними (если приказ отдан в этот ход) */
  counterHexes(side) {
    if (!this.counter || !this.counter[side]) return null;
    const set = new Set();
    for (const p of this.pts) if (p.home === side) for (const h of Hex.within(p.hex, 1)) set.add(h);
    return set;
  }
  /** клетки под управлением штабов стороны */
  cmdHexes(side) {
    const set = new Set();
    for (const h of this.units) if (h.side === side && h.k === 'hq' && h.str > 0) for (const x of Hex.within(h.hex, UT.hq.cmd)) set.add(x);
    return set;
  }

  /* ---------- обзор ---------- */
  /** видна ли чужая часть стороне (клетка в обзоре + не прячется) */
  seen(side, u) {
    if (u.side === side) return true;
    if (!this.vis[side].has(u.hex)) return false;
    if (u.revealed === this.turn || u.revealed === this.turn - 1) return true;
    if (this.smoke.has(u.hex)) return this.units.some(v => v.side === side && v.str > 0 && Hex.hexDist(v.hex, u.hex) <= 1);
    const t = this.map.hexes[u.hex].t, hidden = UT[u.k].stl || t === 'forest' || t === 'city';
    if (!hidden) return true;
    for (const v of this.units) {
      if (v.side !== side || v.str <= 0) continue;
      const d = Hex.hexDist(v.hex, u.hex);
      if (d <= 1 || (v.k === 'rec' && d <= 2)) return true;
    }
    return this.recon[side].has(u.hex);
  }
  updateVision(side) {
    const vis = new Set(), night = isNight(this.turn);
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const T = UT[u.k], hx = this.map.hexes[u.hex];
      let r = T.vis + (hx.t === 'hill' ? 1 : 0) - (night && !T.th ? 1 : 0) - (this.weather.vis < .7 ? 1 : 0);
      for (const h of Hex.within(u.hex, Math.max(1, r))) vis.add(h);
    }
    for (const p of this.pts) if (p.owner === side) for (const h of Hex.within(p.hex, 1)) vis.add(h);
    for (const h of this.recon[side]) vis.add(h);
    this.vis[side] = vis;
    const mem = this.mem[side];
    for (const u of this.units) {
      if (u.side === side || u.str <= 0) continue;
      if (this.seen(side, u)) mem.set(u.id, { hex: u.hex, k: u.k, turn: this.turn, str: u.str });
    }
    for (const [id, m] of mem) {
      const u = this.byId(id);
      if (!u || this.turn - m.turn > 3 || (vis.has(m.hex) && !(u.hex === m.hex && this.seen(side, u)))) mem.delete(id);
    }
  }

  /* ---------- действия ---------- */
  act(side, a) {
    a = a && typeof a === 'object' ? a : {};
    if (this.over) return { ok: false, error: 'партия окончена' };
    const t = a.t;
    if (this.phase === 'deploy') {
      if (t === 'buy') return this.buy(side, a.k, +a.hex, true);
      if (t === 'sell') return this.sell(side, +a.id);
      if (t === 'place') return this.place(side, +a.id, +a.hex);
      if (t === 'ready') { this.ready[side] = true; this.tryStart(); return { ok: true } }
      return { ok: false, error: 'сначала расстановка' };
    }
    if (side !== this.active) return { ok: false, error: 'сейчас ход противника' };
    if (t === 'end') return this.endTurn();
    if (t === 'buy') return this.buy(side, a.k, +a.hex, false);
    if (t === 'air') return this.airAct(side, a.kind, +a.hex);
    if (t === 'order') return this.order(side, a.k, a);
    const u = this.byId(+a.id);
    if (!u || u.side !== side) return { ok: false, error: 'нет такой части' };
    if (t === 'move') return this.move(u, +a.to);
    if (t === 'attack') return this.attack(u, this.byId(+a.target));
    if (t === 'bombard') return this.bombard(u, +a.hex);
    if (t === 'replace') return this.replace(u);
    if (t === 'eng') return this.engAct(u, a.task, +a.hex);
    if (t === 'dig') return this.digIn(u);
    if (t === 'ambush') return this.setAmbush(u);
    return { ok: false, error: 'неизвестное действие' };
  }

  /* ---------- расстановка и закупка ---------- */
  inDeploy(side, hex) {
    if (hex < 0 || hex >= Hex.NH) return false;
    const x = this.map.hexes[hex].x, z = this.scen && this.scen.deploy ? this.scen.deploy[side] : this.mapDef.deploy ? this.mapDef.deploy[side] : W.DEPLOY_X[side];
    return x >= z[0] && x <= z[1];
  }
  buy(side, k, hex, deploy) {
    const T = typeof k === 'string' && Object.prototype.hasOwnProperty.call(UT, k) ? UT[k] : null;
    if (!T) return { ok: false, error: 'неизвестный тип' };
    if (!(hex >= 0 && hex < Hex.NH)) return { ok: false, error: 'нет клетки' };
    if (this.units.filter(u => u.side === side && u.str > 0).length >= W.MAX_UNITS) return { ok: false, error: `лимит частей — ${W.MAX_UNITS}` };
    if (this.budget[side] < T.price) return { ok: false, error: 'не хватает очков' };
    if (this.unitAt(hex)) return { ok: false, error: 'клетка занята' };
    if (!this.passable(k, hex)) return { ok: false, error: 'сюда эта часть не встанет' };
    if (deploy) { if (!this.inDeploy(side, hex)) return { ok: false, error: 'только в своей зоне расстановки' } }
    else { const err = this.spawnErr(side, hex, k); if (err) return { ok: false, error: err } }
    this.budget[side] -= T.price; this.stats[side].spent += T.price;
    const u = this.spawn(k, side, hex, { mp: 0, acted: true, moved: true, xp: .05 });
    if (!deploy) this.log(side, `«${u.cs}» (${W.lc(W.unitName(side, u.k))}) прибыл: ${this.spawnPt(side, hex).n}.`, 'g');
    this.ev({ e: 'spawn', to: side, id: u.id, hex });
    return { ok: true, id: u.id };
  }
  /** точка, у которой можно высадить подкрепления: сама точка или соседняя клетка */
  spawnPt(side, hex) {
    return this.pts.find(p => p.owner === side && p.hex === hex) ||
      this.pts.find(p => p.owner === side && Hex.hexDist(p.hex, hex) === 1 && !(this.unitAt(p.hex) && this.unitAt(p.hex).side !== side));
  }
  spawnErr(side, hex, k) {
    if (!(hex >= 0 && hex < Hex.NH)) return 'нет клетки';
    if (this.unitAt(hex)) return 'клетка занята';
    if (!this.passable(k, hex)) return 'сюда эта часть не встанет';
    if (!this.spawnPt(side, hex)) return 'подкрепления — в своём городе или узле либо на соседней с ним клетке';
    if (Hex.neighbors(hex).some(h => { const e = this.unitAt(h); return e && e.side !== side })) return 'рядом противник — высадка невозможна';
    return null;
  }
  /** клетки, где сторона может высадить подкрепления такого типа */
  spawnHexes(side, k) {
    const out = [];
    for (const p of this.pts) if (p.owner === side) for (const h of Hex.within(p.hex, 1)) if (!out.includes(h) && !this.spawnErr(side, h, k)) out.push(h);
    return out;
  }

  /* ---------- приказы штаба ---------- */
  order(side, k, a) {
    const O = typeof k === 'string' && Object.prototype.hasOwnProperty.call(W.ORDERS, k) ? W.ORDERS[k] : null;
    if (!O) return { ok: false, error: 'неизвестный приказ' };
    if (this.cp[side] < O.cp) return { ok: false, error: `не хватает командных очков: нужно ${O.cp}` };
    const u = O.tgt === 'unit' ? this.byId(+a.id) : null, hex = +a.hex;
    if (O.tgt === 'unit' && (!u || u.side !== side)) return { ok: false, error: 'укажите свою часть' };
    if (O.tgt === 'hex' && !(hex >= 0 && hex < Hex.NH)) return { ok: false, error: 'укажите клетку' };
    if (k === 'barrage') {
      if (this.barrage[side]) return { ok: false, error: 'артподготовка уже идёт' };
      if (!this.units.some(v => v.side === side && v.str > 0 && UT[v.k].bomb && !v.acted)) return { ok: false, error: 'нет готовой артиллерии' };
      this.barrage[side] = true;
      this.log(side, 'Артподготовка! Все стволы — по переднему краю.', 'hq');
    } else if (k === 'counter') {
      if (this.counter[side]) return { ok: false, error: 'контрудар уже объявлен' };
      if (!this.pts.some(p => p.home === side && p.owner !== side)) return { ok: false, error: 'все исходные точки и так наши' };
      this.counter[side] = true;
      const zone = this.counterHexes(side);
      for (const v of this.units) if (v.side === side && v.str > 0 && Hex.neighbors(v.hex).some(h => zone.has(h))) v.org = Math.min(100, v.org + 10);
      this.log(side, 'Контрудар! Вернуть наши города — любой ценой.', 'hq');
    } else if (k === 'march') {
      if (u.march) return { ok: false, error: 'часть уже на марше' };
      if (u.acted) return { ok: false, error: 'часть уже действовала' };
      if (u.sp <= 0) return { ok: false, error: 'нет топлива' };
      u.march = true; u.mp += 3; u.org = Math.max(0, u.org - 10);
      this.say(u, 'march', {}, 'g');
    } else if (k === 'hold') {
      if (u.hold) return { ok: false, error: 'приказ уже отдан' };
      u.hold = true;
      this.say(u, 'hold', {}, 'g');
    } else if (k === 'smoke') {
      if (!this.units.some(v => v.side === side && v.str > 0 && Hex.hexDist(v.hex, hex) <= 3)) return { ok: false, error: 'дым ставят у своих частей — до 3 клеток' };
      for (const h of Hex.within(hex, 1)) this.smoke.set(h, side);
      this.ev({ e: 'smoke', to: '*', hex });
      this.log(side, 'Дымовая завеса поставлена.', 'g');
      this.updateVision(oppOf(side));
    } else if (k === 'airdrop') {
      if (!this.weather.fly) return { ok: false, error: 'погода нелётная' };
      if (u.sp >= W.SUPPLY.max) return { ok: false, error: 'запасы и так полные' };
      u.sp = Math.min(W.SUPPLY.max, u.sp + 2); u.org = Math.min(100, u.org + 10);
      this.ev({ e: 'air', to: side, hex: u.hex, kind: 'drop' });
      this.say(u, 'airdrop', {}, 'g');
    } else if (k === 'reserve') {
      if (this.units.filter(v => v.side === side && v.str > 0).length >= W.MAX_UNITS) return { ok: false, error: `лимит частей — ${W.MAX_UNITS}` };
      const err = this.spawnErr(side, hex, 'mot');
      if (err) return { ok: false, error: err };
      const v = this.spawn('mot', side, hex, { str: 7, mp: 0, acted: true, moved: true, xp: .1 });
      this.log(side, `Резерв ставки: «${v.cs}» (мотопехота) прибыл — ${this.spawnPt(side, hex).n}.`, 'g');
      this.ev({ e: 'spawn', to: side, id: v.id, hex });
    }
    this.cp[side] -= O.cp;
    this.ev({ e: 'order', to: side, k });
    return { ok: true };
  }

  sell(side, id) {
    const u = this.byId(id);
    if (!u || u.side !== side || u.pre) return { ok: false, error: 'эту часть не вернуть' };
    this.units = this.units.filter(x => x !== u);
    this.budget[side] += UT[u.k].price; this.stats[side].spent -= UT[u.k].price;
    return { ok: true };
  }
  place(side, id, hex) {
    const u = this.byId(id);
    if (!u || u.side !== side) return { ok: false, error: 'нет такой части' };
    if (!this.inDeploy(side, hex)) return { ok: false, error: 'только в своей зоне расстановки' };
    if (this.unitAt(hex)) return { ok: false, error: 'клетка занята' };
    if (!this.passable(u.k, hex)) return { ok: false, error: 'сюда эта часть не встанет' };
    u.hex = hex;
    return { ok: true };
  }
  tryStart() {
    if (this.phase !== 'deploy') return;
    for (const side of [N, S]) if (this.bots[side] && !this.ready[side]) this.botDeploy(side);
    if (!(this.ready.n && this.ready.s)) return;
    this.phase = 'battle';
    /* первым ходит наступающий; во встречном бою — по жребию (у первого хода заметное преимущество) */
    this.first = this.role.s === 'attacker' ? S : this.role.n === 'attacker' || this.scen ? N : this.chance(.5) ? N : S;
    this.active = this.first;
    /* подготовленная оборона: обороняющийся встречает наступление в окопах, его точки укреплены */
    for (const side of [N, S]) {
      if (this.role[side] !== 'defender' || this.scen) continue;
      for (const u of this.units) if (u.side === side) u.ent = Math.max(u.ent, 1);
      for (const p of this.pts) if (p.owner === side) this.forts.set(p.hex, Math.max(this.forts.get(p.hex) || 0, 1));
      this.log(side, 'Оборона подготовлена: части окопались, наши точки укреплены.', 'hq');
    }
    this.log('*', `Расстановка окончена. Начало операции — первым ходит ${W.SIDE_NAME[this.first]}.`, 'hq');
    this.startSide(this.active);
  }

  /* ---------- ход стороны ---------- */
  startSide(side) {
    this.active = side;
    this.recon[side] = new Set();
    const night = isNight(this.turn);
    this.air[side] = { strike: AIR.strike[night ? 1 : 0] * (this.weather.fly ? 1 : 0), recon: AIR.recon[night ? 1 : 0] * (this.weather.fly ? 1 : 0) };
    this.updateSupply(side);
    const hqAlive = this.units.some(v => v.side === side && v.k === 'hq' && v.str > 0);
    this.cp[side] = Math.min(W.CP.max, this.cp[side] + W.CP.per + (hqAlive ? W.CP.hq : 0));
    this.barrage[side] = false; this.counter[side] = false;
    for (const [h, s] of this.smoke) if (s === side) this.smoke.delete(h);
    const cmd = this.cmdHexes(side);
    for (const u of this.units) if (u.side !== side) u.hb = 0;   /* «связан боем» — только в чужой ход */
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const T = UT[u.k];
      let mp = T.mp;
      if (!cmd.has(u.hex) && u.k !== 'hq') mp -= 1;
      if (u.sp <= 0) mp = 1; else if (u.sp === 1) mp = Math.ceil(mp / 2); else if (u.sp === 2) mp -= 1;
      if (u.sup) mp -= 1;
      if (u.org < 25) mp = Math.min(mp, 2);
      u.mp = Math.max(1, mp); u.acted = false; u.moved = false; u.sup = false;
      u.amb = false; u.ambUsed = false; u.support = false; u.hold = false; u.march = false; u.exploit = false;
      u.startHex = u.hex;
    }
    this.income[side] = Math.round((W.BASE_INCOME + this.heldWeight(side, true) * W.INCOME_PER_WEIGHT) * (W.ROLE_INCOME_MUL[this.role[side]] || 1));
    this.budget[side] += this.income[side];
    this.updateVision(side); this.updateVision(oppOf(side));
    this.ev({ e: 'turn', to: '*', side, turn: this.turn, clock: turnClock(this.turn), night });
  }

  endTurn() {
    const side = this.active;
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const T = UT[u.k];
      /* окапывание: стояли и не воевали */
      if (!u.moved && !u.acted && !u.hitThisTurn) u.ent = Math.min(T.arm === 'soft' ? 3 : 2, u.ent + 1);
      if (u.moved) u.ent = 0;
      if (u.reload > 0) u.reload--;
      u.hitThisTurn = false;
      if (T.bomb && !u.acted && u.reload <= 0 && u.org >= 30) u.support = true;
    }
    this.updateSupply(side);
    const SP = W.SUPPLY;
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      if (u.supplied) {
        u.cut = 0;
        const lim = u.over ? SP.over : SP.max;
        if (u.sp < lim) u.sp = Math.min(lim, u.sp + SP.regain);
        if (!u.acted) u.org = Math.min(100, u.org + (u.over ? 6 : 12));
        continue;
      }
      /* котёл: запас тает по делению за ход, без запасов — потери и сдача */
      u.cut++;
      u.sp = Math.max(0, u.sp - 1);
      u.org = Math.max(0, u.org - (u.sp === 0 ? 20 : 8));
      if (u.cut === 1) this.say(u, 'cut', {}, 'crit');
      if (u.sp === 0) {
        if (!u.dry) { this.say(u, 'exhausted', {}, 'crit'); u.dry = true }
        this.loss(u, u.cut >= 4 ? 2 : 1, null);
        if (u.str > 0 && u.cut >= 4) this.say(u, 'attrition', {}, 'w');
        if (u.str > 0 && u.org <= 0) {
          const by = this.units.filter(e => e.side !== side && e.str > 0).sort((a, b) => Hex.hexDist(a.hex, u.hex) - Hex.hexDist(b.hex, u.hex))[0];
          this.loss(u, u.str, by && Hex.hexDist(by.hex, u.hex) <= 4 ? by : null, 'surrender');
        }
      } else u.dry = false;
    }
    this.ev({ e: 'endside', to: '*', side });
    const next = oppOf(side), first = this.first || N;
    if (next === first) this.endRound();
    if (this.over) return { ok: true };
    this.startSide(next);
    return { ok: true };
  }
  endRound() {
    const d = this.heldWeight(N) - this.heldWeight(S);
    this.score = clamp(this.score + d * W.SCORE_RATE, -100, 100);
    this.history.push({ turn: this.turn, s: +this.score.toFixed(1), n: this.forceValue(N), e: this.forceValue(S) });
    this.turn++;
    if (--this.wxLeft <= 0) {
      const pool = WEATHER.filter(w => w.id !== this.weather.id);
      let r = this.rnd() * pool.reduce((a, w) => a + w.w, 0);
      for (const w of pool) { r -= w.w; if (r <= 0) { this.weather = w; break } }
      this.wxLeft = 2 + Math.floor(this.rnd() * 4);
      this.log('*', `Метео: ${this.weather.n.toLowerCase()}. ${this.weather.d}`, 'm');
    }
    this.scenarioRound();
    this.rebuildFront();
    this.checkEnd();
  }

  /* ---------- движение ---------- */
  move(u, to) {
    if (u.mp <= 0) return { ok: false, error: 'очки хода кончились' };
    if (u.acted && UT[u.k].bomb) return { ok: false, error: 'артиллерия после огня не двигается' };
    const reach = Rules.reachable(this.ctxFor(u.side, false), u), r = reach.get(to);
    if (!r || to === u.hex) return { ok: false, error: 'туда не дойти' };
    if (r.through) return { ok: false, error: 'клетка занята своей частью' };
    const path = Rules.pathTo(reach, to);
    /* идём по клеткам: невидимый противник останавливает, мины рвутся */
    const done = [u.hex];
    let stopped = null, mineHex = -1;
    for (let i = 1; i < path.length; i++) {
      const h = path[i], occ = this.unitAt(h);
      if (occ && occ.side !== u.side) { stopped = 'contact'; occ.revealed = this.turn; break }
      if (occ && occ.side === u.side && i === path.length - 1) break;
      done.push(h);
      if (this.ambushOn(u, h)) { stopped = 'ambush'; break }
      const m = this.mines.get(h);
      if (m && m.side !== u.side) { stopped = 'mine'; mineHex = h; break }
      /* вошли в зону контроля невидимого противника — встаём */
      if (i < path.length - 1 && Hex.neighbors(h).some(n => { const e = this.unitAt(n); return e && e.side !== u.side })) {
        const e = Hex.neighbors(h).map(n => this.unitAt(n)).find(e => e && e.side !== u.side);
        if (e) e.revealed = this.turn;
        stopped = 'zoc'; break;
      }
    }
    let end = done[done.length - 1];
    while (this.unitAt(end) && this.unitAt(end) !== u && done.length > 1) { done.pop(); end = done[done.length - 1] }
    if (u.str <= 0) { this.ev({ e: 'move', to: '*', id: u.id, side: u.side, path: done, k: u.k }); this.updateVision(oppOf(u.side)); return { ok: true, stopped } }
    const spent = stopped ? u.mp : (reach.get(end) ? reach.get(end).c : u.mp);
    u.hex = end; u.mp = Math.max(0, u.mp - spent); u.moved = true; u.ent = 0;
    if (r.ford && end === to) this.say(u, 'ford', {});
    this.ev({ e: 'move', to: '*', id: u.id, side: u.side, path: done, k: u.k });
    if (stopped === 'mine' && end === mineHex) this.mineBlast(u, end);
    if (stopped === 'contact') { this.say(u, 'contact', {}, 'w'); u.mp = 0 }
    if (stopped === 'zoc') this.say(u, 'zoc', {}, 'q');
    if (stopped === 'ambush') this.say(u, 'ambushed', {}, 'crit');
    if (this.obst.has(end) && UT[u.k].cls !== 'foot') { u.mp = 0; this.say(u, 'obst', {}, 'w') }
    this.capture(u);
    if (u.str > 0) this.militia(u);
    this.updateVision(u.side); this.updateVision(oppOf(u.side));
    return { ok: true, stopped };
  }
  capture(u) {
    const p = this.ptAt(u.hex);
    if (!p || p.owner === u.side || !UT[u.k].cap) return;
    const was = p.owner;
    p.owner = u.side;
    this.stats[u.side].caps++;
    this.log(u.side, `${p.n} — наши!`, 'g');
    if (was && p.city && !this.looted.has(p.id)) {
      this.looted.add(p.id);
      const t = Math.round(20 + 15 * p.w);
      this.budget[u.side] += t; this.cp[u.side] = Math.min(W.CP.max, this.cp[u.side] + 1);
      this.log(u.side, `${p.n}: взяли склады противника — +${t} очков и командное очко.`, 'g');
    }
    if (was) this.log(was, `${p.n} потерян${p.city ? '' : 'а'}.`, 'crit');
    this.ev({ e: 'capture', to: '*', hex: u.hex, side: u.side, n: p.n });
    this.rebuildFront();
    this.checkEnd();
  }
  /** ополчение: пустой свой город, к которому подошёл противник, один раз выставляет защитников */
  militia(u) {
    for (const p of this.pts) {
      if (!p.city || !p.owner || p.owner === u.side || this.militiaUsed.has(p.id)) continue;
      if (Hex.hexDist(p.hex, u.hex) !== 1 || this.unitAt(p.hex)) continue;
      this.militiaUsed.add(p.id);
      const m = this.spawn('inf', p.owner, p.hex, { str: 3 + Math.round(p.w), org: 70, xp: 0, ent: 1, mp: 0, acted: true, moved: true, militia: true });
      this.log(p.owner, `${p.n}: жители взялись за оружие — ополчение заняло оборону.`, 'g');
      this.log(u.side, `${p.n}: в городе нас встретило ополчение!`, 'w');
      this.ev({ e: 'spawn', to: p.owner, id: m.id, hex: p.hex, militia: 1 });
      if (this.vis[u.side].has(p.hex)) m.revealed = this.turn;
    }
  }
  mineBlast(u, hex) {
    const m = this.mines.get(hex);
    if (!m) return;
    this.loss(u, 1 + (this.chance(.4) ? 1 : 0), null);
    u.mp = 0; u.org = Math.max(0, u.org - 10);
    m.str -= .35;
    if (m.str <= 0) this.mines.delete(hex); else m.known = Object.assign(m.known || {}, { [u.side]: true });
    this.ev({ e: 'blast', to: '*', hex, big: 0, mine: 1 });
    if (u.str > 0) this.say(u, 'mine', {}, 'w');
  }

  /* ---------- бой ---------- */
  attack(u, e) {
    const T = UT[u.k];
    if (!e || e.side === u.side) return { ok: false, error: 'нет цели' };
    if (u.acted) return { ok: false, error: 'часть уже атаковала' };
    if (T.bomb) return { ok: false, error: 'артиллерия бьёт огнём — «Огонь»' };
    if (Hex.hexDist(u.hex, e.hex) !== 1) return { ok: false, error: 'цель не рядом' };
    if (!this.seen(u.side, e)) return { ok: false, error: 'цель не видна' };
    if (u.org < 20) return { ok: false, error: 'часть дезорганизована' };
    if (u.sp <= 0) return { ok: false, error: 'нет боеприпасов — запасы кончились' };
    const o = Rules.odds(this.ctxFor(u.side, true), u, e);
    const la = Math.min(u.str, Math.round(o.expA * this.R(.6, 1.4)));
    let ld = Math.min(e.str, Math.round(o.expD * this.R(.6, 1.4)));
    /* брод при занятии клетки разрешён только «с места» — атака ниже съест очки хода */
    const fresh = !u.moved && u.mp >= T.mp;
    u.acted = true; u.mp = T.mp > 5 && u.k !== 'rec' ? Math.min(u.mp, 1) : 0; u.ent = 0; u.revealed = this.turn;
    e.revealed = this.turn; e.hitThisTurn = true; e.hb = (e.hb || 0) | Rules.ARMBIT[T.arm];
    this.ev({ e: 'fight', to: '*', a: u.id, d: e.id, ah: u.hex, dh: e.hex, la, ld, r: +o.r.toFixed(2) });
    this.say(u, 'attack', { lb: W.lc(W.unitName(e.side, e.k)) });
    let retreat = this.chance(o.retreat);
    this.lastVacated = null;
    /* огонь поддержки: своя артиллерия защитника бьёт по атакующим */
    if (o.mods.some(m => m.t === 'огонь поддержки')) {
      const art = this.units.find(a => a.side === e.side && a.support && a.str > 0 && Hex.hexDist(a.hex, e.hex) <= UT[a.k].bomb.rng);
      if (art) {
        art.support = false; art.revealed = this.turn;
        this.ev({ e: 'shell', to: '*', from: art.hex, hex: u.hex, k: art.k });
        this.say(art, 'support', {}, 'g');
        if (this.chance(.5 + .03 * art.str)) this.loss(u, 1, art);
      }
    }
    this.loss(e, ld, u);
    this.loss(u, la, e);
    u.org = Math.max(0, u.org - la * 4); this.gainXp(u, .06);
    if (e.str > 0) {
      e.org = Math.max(0, e.org - ld * 6 - (retreat ? 8 : 0)); this.gainXp(e, .05);
      if (e.org < 15) retreat = true;
      if (e.hold && retreat) { retreat = false; e.org = Math.max(0, e.org - 10) }
      if (this.forts.get(e.hex) && e.org >= 40 && retreat && this.chance(.5)) { retreat = false; this.say(e, 'fortHold', {}) }
      if (retreat) this.retreat(e, u);
      else this.say(e, 'held', {}, '');
    }
    /* занять освободившуюся клетку */
    const vac = this.lastVacated;
    if (u.str > 0 && T.cap && vac !== undefined && vac !== null && !this.unitAt(vac) && Hex.hexDist(u.hex, vac) === 1) {
      const d = Hex.dirTo(u.hex, vac);
      /* через реку без моста — по тому же правилу, что и при движении (shared/rules.js):
         колёсным нельзя вовсе, пешим и гусеничным — только с полным запасом хода,
         и брод съедает ход. Иначе выбитый противник открывал бесплатный переход. */
      const edge = Rules.edgeOf(this.ctxFor(u.side, true), u.hex, d);
      const ford = !Rules.crossable(edge);
      if (!ford || (T.cls !== 'wheel' && fresh)) {
        const from = u.hex;
        u.hex = vac; u.moved = true;
        if (ford) u.mp = 0;
        this.ev({ e: 'move', to: '*', id: u.id, side: u.side, path: [from, vac], k: u.k, adv: 1 });
        this.capture(u);
        /* прорыв: подвижные части развивают успех */
        if (['tnk', 'mot', 'rec'].includes(u.k) && !u.exploit && u.org >= 40 && u.sp >= 2 && u.str >= 4) {
          u.exploit = true; u.acted = false; u.mp = Math.max(u.mp, 2);
          this.say(u, 'exploit', {}, 'g');
        }
        if (u.str > 0) this.militia(u);
      }
    }
    this.lastVacated = null;
    this.updateVision(u.side); this.updateVision(oppOf(u.side));
    return { ok: true, la, ld };
  }
  /** опыт: на порогах 0,3 и 0,6 часть становится «обстрелянной» и «ветеранами» */
  gainXp(u, d) {
    const lv = x => x >= .6 ? 2 : x >= .3 ? 1 : 0, was = lv(u.xp);
    u.xp = Math.min(1, u.xp + d);
    if (u.str > 0 && lv(u.xp) > was) {
      this.ev({ e: 'promote', to: u.side, id: u.id, hex: u.hex, lv: lv(u.xp) });
      this.log(u.side, `«${u.cs}» ${lv(u.xp) >= 2 ? 'теперь ветераны' : 'обстреляны'} — бьют и держатся лучше.`, 'g');
    }
  }
  /** потери шагами; уничтожение; статистика */
  loss(u, n, by, how) {
    if (!(n > 0) || u.str <= 0) return;
    u.str = Math.max(0, u.str - n);
    u.hitThisTurn = true;
    if (by && by.side !== u.side && by.id) this.gainXp(by, .02 * n);
    if (u.str > 0) return;
    const st = this.stats[u.side], price = UT[u.k].price;
    st.lost[u.k] = (st.lost[u.k] || 0) + 1; st.lostV += price;
    if (by && by.side !== u.side) { const ks = this.stats[by.side]; ks.killed[u.k] = (ks.killed[u.k] || 0) + 1; ks.killedV += price; if (how === 'surrender') ks.prisoners++ }
    this.lastVacated = u.hex;
    this.ev({ e: 'dead', to: '*', id: u.id, hex: u.hex, k: u.k, side: u.side, how: how || '' });
    const un = W.lc(W.unitName(u.side, u.k));
    this.log(u.side, how === 'surrender' ? `«${u.cs}» (${un}) в окружении сложил оружие.` : `«${u.cs}» (${un}) уничтожен.`, 'crit');
    if (by && by.str > 0 && by.side !== u.side) this.say(by, how === 'surrender' ? 'prisoners' : 'kill', { lb: un }, 'g');
    if (u.k === 'hq') {
      for (const v of this.units) if (v.side === u.side && v.str > 0 && Hex.hexDist(v.hex, u.hex) <= UT.hq.cmd) v.org = Math.max(0, v.org - 15);
      this.log(u.side, 'Штаб уничтожен! Части без управления.', 'crit');
    }
    /* бегство заразно */
    for (const v of this.units) if (v.side === u.side && v.str > 0 && Hex.hexDist(v.hex, u.hex) === 1) v.org = Math.max(0, v.org - 6);
  }
  /** отход на клетку от атакующего; отрезанным — потери или плен */
  retreat(e, by) {
    const ctx = this.ctxFor(e.side, true), zoc = Rules.zocOf(ctx, e.side);
    let best = -1, bs = -1e9;
    for (let d = 0; d < 6; d++) {
      const h = Hex.nb(e.hex, d);
      if (h < 0 || this.unitAt(h) || !this.passable(e.k, h)) continue;
      const ed = Rules.edgeOf(ctx, e.hex, d);
      if (!Rules.crossable(ed) && UT[e.k].cls === 'wheel') continue;
      const s = Hex.hexDist(h, by.hex) * 3 - (zoc.has(h) ? 4 : 0) + (this.supplyHex[e.side] && this.supplyHex[e.side].has(h) ? 2 : 0) + (Rules.crossable(ed) ? 0 : -3);
      if (s > bs) { bs = s; best = h }
    }
    if (best < 0) {
      this.say(e, 'trapped', {}, 'crit');
      if (!e.supplied && (e.org < 30 || e.sp <= 0)) { this.loss(e, e.str, by, 'surrender'); return }
      this.loss(e, 2, by);
      return;
    }
    const from = e.hex;
    this.lastVacated = from;
    e.hex = best; e.ent = 0; e.org = Math.max(0, e.org - 5);
    this.stats[e.side].routs++;
    this.ev({ e: 'move', to: '*', id: e.id, side: e.side, path: [from, best], k: e.k, retreat: 1 });
    this.say(e, 'retreat', {}, 'w');
    /* отход под огнём: клетка в зоне контроля двух и больше частей противника */
    const around = Hex.neighbors(best).filter(h => { const o = this.unitAt(h); return o && o.side !== e.side }).length;
    if (around >= 2 && e.str > 0) { this.loss(e, 1, by); if (e.str > 0) this.log(e.side, `«${e.cs}»: отходили под перекрёстным огнём — потери.`, 'w') }
  }

  /* ---------- артиллерия, авиация ---------- */
  bombard(u, hex) {
    const T = UT[u.k];
    if (!T.bomb) return { ok: false, error: 'эта часть не стреляет с закрытых позиций' };
    if (u.acted) return { ok: false, error: 'уже стреляли' };
    if (u.reload > 0) return { ok: false, error: 'перезарядка' };
    if (u.sp <= 0) return { ok: false, error: 'нет снарядов — запасы кончились' };
    if (Hex.hexDist(u.hex, hex) > T.bomb.rng) return { ok: false, error: `далеко: дальность ${T.bomb.rng} клетки` };
    const e = this.unitAt(hex);
    if (!e || e.side === u.side || !this.seen(u.side, e)) return { ok: false, error: 'цели не видно' };
    const ctx = this.ctxFor(u.side, true);
    this.ev({ e: 'shell', to: '*', from: u.hex, hex, k: u.k });
    const bar = this.barrage[u.side];
    this.hitByFire(ctx, T.bomb.pow * u.str / MAX_STR * (.85 + .3 * u.xp), e, u, { th: T.th, barrage: bar, sp: u.sp });
    if (T.bomb.area) for (const h of Hex.neighbors(hex)) { const x = this.unitAt(h); if (x && x.side !== u.side) this.hitByFire(ctx, T.bomb.pow * .45 * u.str / MAX_STR, x, u, { barrage: bar, sp: u.sp }) }
    u.acted = true; u.mp = 0; u.revealed = this.turn; u.reload = T.bomb.reload;
    this.say(u, 'fire', {});
    this.counterBattery(u);
    return { ok: true };
  }
  /** контрбатарейная борьба: артиллерия противника, не стрелявшая в свой ход, отвечает по засечённой батарее */
  counterBattery(u) {
    if (u.str <= 0) return;
    const art = this.units.filter(a => a.side !== u.side && a.str > 0 && a.support && UT[a.k].bomb && Hex.hexDist(a.hex, u.hex) <= UT[a.k].bomb.rng)
      .sort((a, b) => UT[b.k].bomb.pow * b.str - UT[a.k].bomb.pow * a.str)[0];
    if (!art) return;
    art.support = false; art.revealed = this.turn;
    this.ev({ e: 'counter', to: '*', hex: art.hex });
    this.ev({ e: 'shell', to: '*', from: art.hex, hex: u.hex, k: art.k });
    this.say(art, 'counter', {}, 'g');
    this.hitByFire(this.ctxFor(art.side, true), UT[art.k].bomb.pow * .6 * art.str / MAX_STR, u, art, { th: UT[art.k].th });
  }
  hitByFire(ctx, pow, e, by, opt) {
    const b = Rules.bombardOdds(ctx, pow, e, opt);
    const n = Math.min(e.str, Math.round(b.exp * this.R(.5, 1.5)));
    this.ev({ e: 'blast', to: '*', hex: e.hex, big: pow > 11 ? 1 : 0, ld: n, id: e.id });
    e.sup = true; e.org = Math.max(0, e.org - 10 - n * 4); e.hitThisTurn = true;
    this.loss(e, n, by);
    if (e.str > 0) this.say(e, 'shelled', {}, 'w');
  }
  airAct(side, kind, hex) {
    if (!(hex >= 0 && hex < Hex.NH)) return { ok: false, error: 'нет клетки' };
    if (!this.weather.fly) return { ok: false, error: 'погода нелётная' };
    if (kind === 'recon') {
      if (this.air[side].recon < 1) return { ok: false, error: 'разведчиков в этот ход больше нет' };
      this.air[side].recon--;
      for (const h of Hex.within(hex, 3)) this.recon[side].add(h);
      this.updateVision(side);
      this.ev({ e: 'air', to: side, hex, kind });
      this.log(side, 'Авиаразведка прошла над районом — данные на карте.', 'q');
      return { ok: true };
    }
    if (kind !== 'strike') return { ok: false, error: 'неизвестный вылет' };
    if (this.air[side].strike < 1) return { ok: false, error: 'ударных вылетов в этот ход больше нет' };
    const e = this.unitAt(hex);
    if (!e || e.side === side || !this.seen(side, e)) return { ok: false, error: 'цели не видно' };
    this.air[side].strike--;
    this.ev({ e: 'air', to: '*', hex, kind, side });
    /* ПВО противника рядом может сорвать удар */
    for (const a of this.units) {
      if (a.side === side || a.str <= 0 || !UT[a.k].aa || Hex.hexDist(a.hex, hex) > UT[a.k].aa) continue;
      if (this.chance(.35 + .03 * a.str)) {
        this.ev({ e: 'aa', to: '*', hex: a.hex, target: hex });
        this.log(side, 'Удар сорван: ПВО противника отогнала штурмовики.', 'w');
        this.log(a.side, `«${a.cs}»: отбили авианалёт!`, 'g');
        return { ok: true, intercepted: true };
      }
    }
    this.hitByFire(this.ctxFor(side, true), AIR.pow, e, { side, xp: 0 }, { air: true, th: true });
    this.log(side, 'Авиаудар нанесён.', 'g');
    return { ok: true };
  }

  /* ---------- пополнение ---------- */
  replace(u) {
    const T = UT[u.k], cost = Math.round(T.price / 10);
    if (u.str >= MAX_STR) return { ok: false, error: 'часть полная' };
    if (u.acted || u.moved) return { ok: false, error: 'пополнение — вместо действий в этот ход' };
    if (!u.supplied) return { ok: false, error: 'нет снабжения' };
    if (Hex.neighbors(u.hex).some(h => { const e = this.unitAt(h); return e && e.side !== u.side })) return { ok: false, error: 'противник рядом' };
    const can = Math.min(3, MAX_STR - u.str, Math.floor(this.budget[u.side] / cost));
    if (can < 1) return { ok: false, error: 'не хватает очков' };
    this.budget[u.side] -= can * cost; this.stats[u.side].spent += can * cost;
    u.xp = (u.xp * u.str + .05 * can) / (u.str + can);
    u.str += can; u.acted = true; u.mp = 0;
    this.ev({ e: 'replace', to: u.side, id: u.id, n: can });
    this.say(u, 'replaced', { n: can }, 'g');
    return { ok: true, n: can };
  }

  /* ---------- сапёры ---------- */
  engAct(u, task, hex) {
    if (!UT[u.k].eng) return { ok: false, error: 'это не сапёры' };
    if (u.acted) return { ok: false, error: 'уже работали в этот ход' };
    if (task === 'dig') return this.digIn(u);
    const d = Hex.dirTo(u.hex, hex);
    if (d < 0 && !['mine', 'fort', 'obst'].includes(task)) return { ok: false, error: 'только у соседней клетки' };
    if (task === 'repair') {
      const key = Hex.edgeKey(u.hex, hex);
      if (this.br.get(key) !== 'down') return { ok: false, error: 'здесь нет взорванного моста' };
      if (Hex.neighbors(hex).concat([hex]).some(h => { const e = this.unitAt(h); return e && e.side !== u.side })) return { ok: false, error: 'под огнём мост не восстановить' };
      this.br.delete(key);
      this.say(u, 'repaired', {}, 'g');
      this.log(oppOf(u.side), `Противник восстановил мост, кв. ${W.sq(this.map.hexes[hex])}.`, 'w');
    } else if (task === 'bridge' || task === 'blow') {
      const e = Rules.edgeOf(this.ctxFor(u.side, true), u.hex, d), key = Hex.edgeKey(u.hex, hex);
      if (!(e & Hex.RIV)) return { ok: false, error: 'между клетками нет реки' };
      if (task === 'bridge') {
        if (e & Hex.BR) return { ok: false, error: 'переправа уже есть' };
        this.br.set(key, 'pontoon');
        this.log('*', `Наведена понтонная переправа, кв. ${W.sq(this.map.hexes[hex])}.`, 'g');
      } else {
        if (!(e & Hex.BR)) return { ok: false, error: 'здесь нет моста' };
        this.br.set(key, 'down');
        this.log('*', `Мост взорван, кв. ${W.sq(this.map.hexes[hex])}.`, 'w');
        this.ev({ e: 'blast', to: '*', hex, big: 1, bridge: key });
      }
    } else if (task === 'mine') {
      if (!(hex === u.hex || d >= 0)) return { ok: false, error: 'только своя или соседняя клетка' };
      if (u.mines < 1) return { ok: false, error: 'мины кончились' };
      const occ = this.unitAt(hex);
      if (occ && occ.side !== u.side) return { ok: false, error: 'там противник' };
      this.mines.set(hex, { side: u.side, str: 1, known: { [u.side]: true } });
      u.mines--;
      this.say(u, 'mined', {}, 'g');
    } else if (task === 'clear') {
      const m = this.mines.get(hex);
      if (m && m.side !== u.side) this.mines.delete(hex);
      else if (this.obst.has(hex)) this.obst.delete(hex);
      else return { ok: false, error: 'там нет чужих мин или заграждений' };
      this.say(u, 'cleared', {}, 'g');
    } else if (task === 'fort') {
      if (!(hex === u.hex || d >= 0)) return { ok: false, error: 'только своя или соседняя клетка' };
      const occ = this.unitAt(hex);
      if (occ && occ.side !== u.side) return { ok: false, error: 'там противник' };
      const lvl = this.forts.get(hex) || 0;
      if (lvl >= 2) return { ok: false, error: 'укрепления уже полные' };
      this.forts.set(hex, lvl + 1);
      this.say(u, 'fortBuilt', { n: lvl + 1 }, 'g');
    } else if (task === 'obst') {
      if (!(hex === u.hex || d >= 0)) return { ok: false, error: 'только своя или соседняя клетка' };
      const occ = this.unitAt(hex);
      if (occ && occ.side !== u.side) return { ok: false, error: 'там противник' };
      this.obst.set(hex, u.side);
      this.say(u, 'obstBuilt', {}, 'g');
    } else return { ok: false, error: 'неизвестная задача' };
    u.acted = true; u.mp = 0;
    this.ev({ e: 'eng', to: '*', id: u.id, hex, task });
    return { ok: true };
  }
  /** засада: часть отказывается от действий и встречает огнём того, кто войдёт рядом в чужой ход */
  setAmbush(u) {
    const T = UT[u.k];
    if (u.acted) return { ok: false, error: 'часть уже действовала' };
    if (T.bomb || T.atk.soft < 2 || u.k === 'hq') return { ok: false, error: 'эта часть в засаду не садится' };
    u.amb = true; u.acted = true; u.mp = 0;
    this.ev({ e: 'eng', to: u.side, id: u.id, hex: u.hex, task: 'ambush' });
    this.say(u, 'ambushSet', {});
    return { ok: true };
  }
  /** мовер вошёл в клетку h — засады противника рядом стреляют; true — встал */
  ambushOn(u, h) {
    let hit = false;
    for (const a of this.units) {
      if (a.side === u.side || !a.amb || a.ambUsed || a.str <= 0 || Hex.hexDist(a.hex, h) !== 1) continue;
      a.ambUsed = true; a.revealed = this.turn;
      const x = Rules.ambushHit(this.ctxFor(a.side, true), a, { ...u, hex: h });
      const n = Math.min(u.str, Math.round(x * this.R(.6, 1.4)));
      this.ev({ e: 'fight', to: '*', a: a.id, d: u.id, ah: a.hex, dh: h, la: 0, ld: n, amb: 1 });
      this.say(a, 'ambushFire', {}, 'g');
      u.org = Math.max(0, u.org - 8 - n * 5);
      this.loss(u, n, a);
      hit = true;
      if (u.str <= 0) break;
    }
    return hit;
  }
  /** окопаться: сапёры окапывают себя и соседей, остальные — себя (+1 сразу) */
  digIn(u) {
    if (u.acted || u.moved) return { ok: false, error: 'окапываются вместо движения и боя' };
    const list = [u];
    if (UT[u.k].eng) for (const h of Hex.neighbors(u.hex)) { const v = this.unitAt(h); if (v && v.side === u.side) list.push(v) }
    for (const v of list) v.ent = Math.min(UT[v.k].arm === 'soft' ? 3 : 2, v.ent + 1);
    u.acted = true; u.mp = 0;
    this.ev({ e: 'eng', to: '*', id: u.id, hex: u.hex, task: 'dig' });
    return { ok: true };
  }

  /* ---------- снабжение ---------- */
  updateSupply(side) {
    this.supplyHex = this.supplyHex || {};
    const SP = W.SUPPLY, ctx = this.ctxFor(side, true), zoc = Rules.zocOf(ctx, side);
    const srcs = [];
    for (const p of this.pts) if (p.owner === side && p.city) srcs.push({ id: p.id, n: p.n, hex: p.hex, seeds: [p.hex], cap: Math.round(SP.cityCap(p.w)), r: SP.cityR(p.w), used: 0 });
    const ex = side === N ? 0 : Hex.COLS - 1, edge = [];
    for (let r = 0; r < Hex.ROWS; r++) edge.push(r * Hex.COLS + ex);
    srcs.push({ id: 'edge', n: 'Тыл', hex: -1, seeds: edge, cap: SP.edgeCap, r: SP.edgeR, used: 0 });
    /* подвоз от каждого источника: шаг — 2 (дорога — 1), не через противника и его зоны контроля */
    const blocked = h => { const o = this.unitAt(h); return o && o.side !== side };
    for (const sr of srcs) {
      const R = sr.r * 2, cost = new Map(), buckets = Array.from({ length: R + 1 }, () => []);
      for (const h of sr.seeds) if (h >= 0 && !blocked(h)) { cost.set(h, 0); buckets[0].push(h) }
      for (let c = 0; c <= R; c++) for (const a of buckets[c]) {
        if (cost.get(a) !== c) continue;
        for (let d = 0; d < 6; d++) {
          const b = Hex.nb(a, d);
          if (b < 0) continue;
          const e = Rules.edgeOf(ctx, a, d);
          if (!Rules.crossable(e) || blocked(b)) continue;
          const o = this.unitAt(b);
          if (zoc.has(b) && !(o && o.side === side)) continue;
          const nc = c + ((e & Hex.RD) ? 1 : 2);
          if (nc > R || (cost.has(b) && cost.get(b) <= nc)) continue;
          cost.set(b, nc); buckets[nc].push(b);
        }
      }
      sr.cost = cost;
    }
    /* округ клетки — источник, от которого подвоз ближе всего (по доле дальности) */
    const mg = new Map(), src = new Map();
    srcs.forEach((sr, i) => { for (const [h, c] of sr.cost) { const m = 1 - c / (sr.r * 2); if (!mg.has(h) || m > mg.get(h)) { mg.set(h, m); src.set(h, i) } } });
    this.supplyHex[side] = mg;
    this.districtOf[side] = src;
    /* вместимость: часть берёт снабжение у любого дотягивающегося источника, где есть место; лишние — впроголодь */
    const list = [];
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      u.over = false; u.supplied = mg.has(u.hex);
      if (u.supplied) list.push({ u, can: srcs.map((sr, i) => sr.cost.has(u.hex) ? i : -1).filter(i => i >= 0) });
    }
    list.sort((a, b) => a.can.length - b.can.length);
    for (const { u, can } of list) {
      const free = can.filter(i => srcs[i].used < srcs[i].cap).sort((a, b) => srcs[a].cost.get(u.hex) - srcs[b].cost.get(u.hex));
      if (free.length) srcs[free[0]].used++; else u.over = true;
    }
    for (const sr of srcs) { delete sr.cost; delete sr.seeds }
    this.districts[side] = srcs;
  }

  /* ---------- точки, фронт, исход ---------- */
  heldWeight(side, cityMul) { return this.pts.reduce((s, p) => s + (p.owner === side ? p.w * (cityMul && p.city ? 1.5 : 1) : 0), 0) }
  forceValue(side) { return Math.round(this.units.filter(u => u.side === side && u.str > 0).reduce((s, u) => s + UT[u.k].price * u.str / MAX_STR, 0)) }
  rebuildFront() {
    const xs = [];
    const inf = (x, y) => {
      let v = 0;
      for (const p of this.pts) { if (!p.owner) continue; const d2 = (x - p.x) ** 2 + (y - p.y) ** 2 + 110; v += (p.owner === N ? 1 : -1) * (p.city ? 2.4 : 1) * p.w / d2 }
      for (const u of this.units) { if (u.str <= 0) continue; const h = this.map.hexes[u.hex]; v += (u.side === N ? 1 : -1) * 4 * u.str / MAX_STR / ((x - h.x) ** 2 + (y - h.y) ** 2 + 160) }
      return v;
    };
    for (let y = 0; y <= W.WH; y += 6) {
      let lo = 6, hi = W.WW - 6;
      for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (inf(m, y) > 0) lo = m; else hi = m }
      xs.push({ x: +((lo + hi) / 2).toFixed(1), y });
    }
    this.frontY = xs;
  }
  frontXAt(y) { const f = this.frontY, i = clamp(Math.round(y / 6), 0, f.length - 1); return f[i] ? f[i].x : W.WW / 2 }
  checkEnd() {
    if (this.over || this.phase !== 'battle') return;
    let over = this.scen ? this.scenarioEnd() : null;
    if (!over && !this.scen) {
      if (this.score >= 100) over = { w: N, t: `Перевес на стороне «${SIDE_NAME[N]}» стал решающим.` };
      else if (this.score <= -100) over = { w: S, t: `Перевес на стороне «${SIDE_NAME[S]}» стал решающим.` };
      else if (this.turn >= this.limit) over = Math.abs(this.score) < 5 ? { w: null, t: 'Срок операции истёк — ничья.' } : { w: this.score > 0 ? N : S, t: `Срок операции истёк, перевес ${Math.round(Math.abs(this.score))} — у стороны «${SIDE_NAME[this.score > 0 ? N : S]}».` };
    }
    if (!over) for (const side of [N, S]) {
      if (!this.units.some(u => u.side === side && u.str > 0 && UT[u.k].cap)) { over = { w: oppOf(side), t: `Сторона «${SIDE_NAME[side]}» лишилась боевых частей.` }; break }
    }
    if (!over) return;
    this.over = over;
    this.history.push({ turn: this.turn, s: +this.score.toFixed(1), n: this.forceValue(N), e: this.forceValue(S) });
    this.log('*', over.t, 'crit');
    this.ev({ e: 'over', to: '*', w: over.w, t: over.t });
  }
}

for (const m of ['./scenarios', './ai', './views']) Object.assign(Game.prototype, require(m));
module.exports = { Game, oppOf, AGGR };
