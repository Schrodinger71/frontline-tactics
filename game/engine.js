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
const { wxById, wxPool } = require('../shared/weather');
const TCODE = { n: 1, s: 2 };
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
  constructor(mode, creatorSide, seed, mapId, opts) {
    const scen = require('./scenarios').SCEN[mode];
    this.mapId = scen ? scen.map || 'valley' : typeof mapId === 'string' && Object.prototype.hasOwnProperty.call(MAPS, mapId) ? mapId : 'valley';
    this.mapDef = MAPS[this.mapId];
    /* сетка под размеры этой карты: широкие карты шире, чем выше */
    this.H = Hex.gridFor(this.mapId);
    this.WW = this.H.WW; this.WH = this.H.WH;
    this.map = this.H.build(this.mapId);
    this.mode = mode;
    this.role = { n: 'both', s: 'both' };
    if (mode === 'defense') { this.role[creatorSide] = 'defender'; this.role[oppOf(creatorSide)] = 'attacker' }
    else if (mode === 'attack') { this.role[creatorSide] = 'attacker'; this.role[oppOf(creatorSide)] = 'defender' }
    this.rnd = mulberry((seed === undefined ? Date.now() : seed) & 0xffffffff);
    this.units = []; this.events = []; this.idc = 1; this._cs = { n: 0, s: 0 };
    this.turn = 0; this.active = N; this.phase = 'deploy'; this.over = null; this.score = 0;
    this.br = new Map();              /* мосты: ключ → 'down' | 'pontoon' */
    this.mines = new Map();           /* клетка → { side, str } */
    this.forts = new Map();           /* клетка → уровень укреплений 1–2 */
    this.obst = new Map();            /* клетка → сторона, поставившая заграждения */
    this.smoke = new Map();           /* клетка → сторона, поставившая дым (до её следующего хода) */
    this.militiaUsed = new Set(); this.looted = new Set();
    /* территория: клетка → 0 ничья, 1 Альянс (n), 2 Союз (s); снабжение 0–10 по сторонам */
    this.terr = new Uint8Array(this.H.NH);
    this.sv = { n: new Uint8Array(this.H.NH), s: new Uint8Array(this.H.NH) };
    this.svNet = { n: new Uint8Array(this.H.NH), s: new Uint8Array(this.H.NH) };   /* клетка — на линии снабжения */
    this.svSrc = { n: [], s: [] };                                                /* источники снабжения */
    this.vis = { n: new Set(), s: new Set() };
    this.mem = { n: new Map(), s: new Map() };
    this.recon = { n: new Set(), s: new Set() };
    /* зимние карты начинают с мороза и берут погоду из своего набора (MAPS[id].wx) */
    this.weather = wxById(this.mapDef.wx0 || 'clear'); this.wxLeft = 3 + Math.floor(this.rnd() * 4);
    this.commanders = { n: this.makeCommander(), s: this.makeCommander() };
    this.pts = this.mapDef.points.map(p => ({ ...p, hex: this.H.hexAt(p.x, p.y), home: p.owner }));
    for (const [side, x, y, lvl] of this.mapDef.forts || []) { const h = this.H.hexAt(x, y); if (h >= 0) this.forts.set(h, lvl || 1) }
    for (const [side, x, y] of this.mapDef.obst || []) { const h = this.H.hexAt(x, y); if (h >= 0) this.obst.set(h, side) }
    for (const [side, x, y] of this.mapDef.mines || []) { const h = this.H.hexAt(x, y); if (h >= 0) this.mines.set(h, { side, str: 1, known: { [side]: true } }) }
    /* ============================================================
       МЕСТА (командиры). Сторона — это команда; на стороне от одного
       до MAX_SEATS мест, каждое ведёт свои части и свой бюджет.
       Первое место стороны носит её букву ('n' / 's'), остальные —
       'n2', 'n3': так всё одноместное поведение остаётся прежним.
       Бюджет и доход стороны делятся между её местами, поэтому 2 на 1
       не даёт двойной силы. Туман войны, перевес и победа — на сторону.
       ============================================================ */
    this.seats = [];
    const teams = (opts && opts.teams) || {};
    for (const side of [N, S]) {
      const list = Array.isArray(teams[side]) && teams[side].length ? teams[side].slice(0, W.MAX_SEATS) : [{}];
      list.forEach((sl, i) => this.seats.push({ id: i ? side + (i + 1) : side, side, bot: !!(sl && sl.bot), n: i + 1 }));
    }
    this.seatById = new Map(this.seats.map(st => [st.id, st]));
    this.bots = {}; this.ready = {}; this.done = {};
    this.budget = {}; this.income = {}; this.cp = {}; this.air = {};
    this.airLost = {};                /* место → сколько его штурмовиков сбито: столько вылетов меньше в следующий ход */
    for (const side of [N, S]) {
      const mine = this.seatsOf(side);
      const start = Game.split(Math.round(W.START_BUDGET * (W.ROLE_BUDGET_MUL[this.role[side]] || 1)), mine.length);
      mine.forEach((st, i) => {
        this.bots[st.id] = st.bot;
        this.ready[st.id] = false; this.done[st.id] = false;
        this.budget[st.id] = start[i];
        this.income[st.id] = 0;
        this.cp[st.id] = W.CP.start;
        this.air[st.id] = { strike: 0, recon: 0 };
      });
    }
    this.barrage = { n: false, s: false };
    this.counter = { n: false, s: false };
    this.stats = { n: this.newStats(), s: this.newStats() };
    this.history = [];
    this.limit = W.TURN_LIMIT;
    /* штаб каждой стороне — бесплатно, в глубине */
    /* штаб каждому командиру, разнесены по фронту: так сторона с несколькими
       командирами сразу делится на направления */
    for (const side of [N, S]) {
      /* в глубине своей стороны: от своего края, а не от числа под карту в 300 км —
         на широких картах штаб Союза иначе вставал посреди поля, вне зоны расстановки */
      const mine = this.seatsOf(side), x = side === N ? 45 : this.WW - 45;
      mine.forEach((st, i) => {
        const y = Math.round(this.WH * (i + 1) / (mine.length + 1));
        this.spawn('hq', side, this.freeHex(x, y, 'hq'), { seat: st.id });
        /* sited: командир обязан сам выбрать место пункта до начала партии */
        this.spawn('fob', side, this.freeHex(side === N ? x - 12 : x + 12, y, 'fob'), { seat: st.id, sited: false, ent: 2 });
      });
    }
    this.log('*', 'Расстановка: купите части во вкладке «Закупка» и поставьте их в своей зоне. Потом — «Готов».', 'hq');
    if (require('./scenarios').SCEN[mode]) this.applyScenario(mode);
    this.initTerritory();
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
      /* sp — боеприпасы, fu — топливо (только технике), su — подавленные шаги, att — приданный специалист */
      fu: W.SUPPLY.max, su: 0, att: null,
      cs: bag[n % bag.length] + '-' + (11 + (n * 7) % 88), trait: pick(this.rnd, TRAITS),
      /* владелец: место на этой стороне. Без указания — первое место (его id равен букве стороны),
         поэтому одноместные партии и сценарии работают как прежде. */
      seat: side
    };
    Object.assign(u, o || {});
    if (!this.seatById || !this.seatById.has(u.seat)) u.seat = side;
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
    let h = this.H.hexAt(x, y);
    if (h >= 0 && !this.unitAt(h) && this.passable(k, h)) return h;
    for (let r = 1; r < 6; r++) for (const n of this.H.within(h, r)) if (!this.unitAt(n) && this.passable(k, n)) return n;
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
    for (const u of this.units) if (u.support && u.str > 0 && (truth || u.side === side || occ.get(u.hex) === u)) for (const h of this.H.within(u.hex, UT[u.k].bomb.rng)) support[u.side].add(h);
    return {
      H: this.H, map: this.map, br: this.br, occ, mines: this.mines, forts: this.forts, obst: this.obst, support, side, smoke: this.smoke,
      mud: !!this.weather.mud && this.weather.mud < .8, night: isNight(this.turn), acc: this.weather.acc || 1,
      cmd: this.cmdHexes(side), counter: this.counterHexes(side)
    };
  }
  /** клетки «Контрудара»: исходные точки стороны и соседние с ними (если приказ отдан в этот ход) */
  counterHexes(side) {
    if (!this.counter || !this.counter[side]) return null;
    const set = new Set();
    for (const p of this.pts) if (p.home === side) for (const h of this.H.within(p.hex, 1)) set.add(h);
    return set;
  }
  /** клетки под управлением штабов стороны */
  /** Сектор каждого командира: клетки вокруг ЕГО штаба.
      Сектор дают и подвижный штаб, и стационарный пункт, но только СВОЕГО
      командира — так сторона с несколькими командирами делится на направления.
      Штаб, который шёл в этот ход, сектора не держит; пункт держит всегда. */
  cmdHexes(side) {
    const by = new Map();
    for (const st of this.seatsOf(side)) by.set(st.id, new Set());
    for (const h of this.units) {
      if (h.side !== side || h.str <= 0 || !UT[h.k].cmd) continue;
      if (!UT[h.k].fob && h.moved) continue;        /* подвижный штаб в ход марша сектора не держит */
      const set = by.get(h.seat) || by.set(h.seat, new Set()).get(h.seat);
      for (const x of this.H.within(h.hex, UT[h.k].cmd)) set.add(x);
    }
    return by;
  }
  /** клетки сектора для части (по её командиру) */
  cmdFor(ctx, u) { return ctx.cmd && ctx.cmd.get ? ctx.cmd.get(u.seat || u.side) : null }

  /* ---------- командный пункт: тыловой узел ---------- */
  /** живой командный пункт этого командира */
  fobOf(seat) { return this.units.find(u => UT[u.k].fob && u.seat === seat && u.str > 0) }
  /** пункт блокирован: рядом стоит противник, и узел в этот ход не работает */
  fobBlocked(f) { return this.H.neighbors(f.hex).some(h => { const e = this.unitAt(h); return e && e.side !== f.side && e.str > 0 }) }
  /** работающий пункт командира (развёрнут и не блокирован) — или null */
  fobLive(seat) {
    const f = this.fobOf(seat);
    return f && f.sited !== false && !this.fobBlocked(f) ? f : null;
  }
  /** все работающие пункты стороны */
  fobsLive(side) { return this.seatsOf(side).map(st => this.fobLive(st.id)).filter(Boolean) }
  /** клетка в секторе работающего пункта этого командира */
  inFobZone(seat, hex) {
    const f = this.fobLive(seat);
    return !!f && this.H.hexDist(f.hex, hex) <= UT[f.k].cmd;
  }

  /* ---------- обзор ---------- */
  /** видна ли чужая часть стороне (клетка в обзоре + не прячется) */
  seen(side, u) {
    if (u.side === side) return true;
    if (!this.vis[side].has(u.hex)) return false;
    if (u.revealed === this.turn || u.revealed === this.turn - 1) return true;
    if (this.smoke.has(u.hex)) return this.units.some(v => v.side === side && v.str > 0 && this.H.hexDist(v.hex, u.hex) <= 1);
    const t = this.map.hexes[u.hex].t, hidden = UT[u.k].stl || t === 'forest' || t === 'city';
    if (!hidden) return true;
    for (const v of this.units) {
      if (v.side !== side || v.str <= 0) continue;
      const d = this.H.hexDist(v.hex, u.hex);
      if (d <= 1 || (v.k === 'rec' && d <= 2)) return true;
    }
    return this.recon[side].has(u.hex);
  }
  updateVision(side) {
    const vis = new Set(), night = isNight(this.turn);
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const T = UT[u.k], hx = this.map.hexes[u.hex];
      let r = T.vis + (u.att === 'rcn' ? 1 : 0) + (hx.t === 'hill' ? 1 : 0) - (night && !T.th && u.att !== 'rcn' ? 1 : 0) - (this.weather.vis < .7 ? 1 : 0);
      for (const h of this.H.within(u.hex, Math.max(1, r))) vis.add(h);
    }
    for (const p of this.pts) if (p.owner === side) for (const h of this.H.within(p.hex, 1)) vis.add(h);
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
  /** seat — место (командир). Для одноместной стороны это её буква, как раньше. */
  act(seat, a) {
    a = a && typeof a === 'object' ? a : {};
    if (this.over) return { ok: false, error: 'партия окончена' };
    const side = this.sideOf(seat);
    if (!side) return { ok: false, error: 'нет такого места' };
    const t = a.t;
    if (this.phase === 'deploy') {
      if (t === 'buy') return this.buy(seat, a.k, +a.hex, true);
      if (t === 'sell') return this.sell(seat, +a.id);
      if (t === 'place') return this.place(seat, +a.id, +a.hex);
      if (t === 'attach') return this.attachSpec(seat, this.byId(+a.id), a.k, true);
      if (t === 'ready') {
        const hq = this.units.find(v => UT[v.k].fob && v.seat === seat && v.str > 0);
        if (hq && !hq.sited) return { ok: false, error: 'сначала поставьте командный пункт' };
        this.ready[seat] = true; this.tryStart(); return { ok: true };
      }
      return { ok: false, error: 'сначала расстановка' };
    }
    if (side !== this.active) return { ok: false, error: 'сейчас ход противника' };
    if (this.done[seat]) return { ok: false, error: 'вы уже закончили ход' };
    if (t === 'end') return this.seatEnd(seat);
    if (t === 'buy') return this.buy(seat, a.k, +a.hex, false);
    if (t === 'air') return this.airAct(seat, a.kind, +a.hex);
    if (t === 'order') return this.order(seat, a.k, a);
    const u = this.byId(+a.id);
    if (!u || u.side !== side) return { ok: false, error: 'нет такой части' };
    if (u.seat && u.seat !== seat) return { ok: false, error: 'часть другого командира' };
    if (t === 'move') return this.move(u, +a.to);
    if (t === 'attack') return this.attack(u, this.byId(+a.target));
    if (t === 'bombard') return this.bombard(u, +a.hex);
    if (t === 'fire') return this.fire(u, this.byId(+a.target));
    if (t === 'replace') return this.replace(u);
    if (t === 'attach') return this.attachSpec(seat, u, a.k, false);
    if (t === 'eng') return this.engAct(u, a.task, +a.hex);
    if (t === 'dig') return this.digIn(u);
    if (t === 'ambush') return this.setAmbush(u);
    return { ok: false, error: 'неизвестное действие' };
  }

  /* ---------- места ---------- */
  /** Новый командир на стороне прямо по ходу партии (до MAX_SEATS). Денег из
      воздуха не берём: свободные очки стороны делятся между её местами заново.
      Командиру — свой штаб: при расстановке со штабом и командным пунктом, как
      у всех, в бою — штаб у своего города или пункта. Бот сразу расставляется. */
  addSeat(side, bot) {
    if (side !== N && side !== S) return { ok: false, error: 'нет такой стороны' };
    if (this.over) return { ok: false, error: 'партия окончена' };
    if (this.scen && this.scen.noDeploy && this.phase === 'deploy') return { ok: false, error: 'в этой операции состав задан' };
    const mine = this.seatsOf(side);
    if (mine.length >= W.MAX_SEATS) return { ok: false, error: `на стороне не больше ${W.MAX_SEATS} командиров` };
    let n = mine.length + 1;
    while (this.seatById.has(n === 1 ? side : side + n)) n++;
    const id = n === 1 ? side : side + n, st = { id, side, bot: !!bot, n: mine.length + 1 };
    this.seats.splice(this.seats.indexOf(mine[mine.length - 1]) + 1, 0, st);
    this.seatById.set(id, st);
    this.bots[id] = !!bot; this.done[id] = false; this.ready[id] = this.phase !== 'deploy';
    this.income[id] = 0; this.cp[id] = W.CP.start; this.air[id] = { strike: 0, recon: 0 }; this.airLost[id] = 0;
    const all = mine.concat([st]), total = Math.floor(mine.reduce((a, x) => a + (this.budget[x.id] || 0), 0));
    Game.split(total, all.length).forEach((v, i) => { this.budget[all[i].id] = v });
    /* штаб: подальше от штабов союзников, чтобы сторона делилась на направления */
    const hqs = this.units.filter(u => u.side === side && u.str > 0 && UT[u.k].cmd);
    const apart = h => Math.min(99, ...hqs.map(u => this.H.hexDist(u.hex, h)));
    if (this.phase === 'deploy') {
      const x = side === N ? 45 : this.WW - 45;
      let best = -1, bs = -1;
      for (let i = 1; i < 8; i++) { const h = this.freeHex(x, this.WH * i / 8, 'hq'); if (h >= 0 && apart(h) > bs && !this.unitAt(h)) { bs = apart(h); best = h } }
      if (best >= 0) {
        const hq = this.spawn('hq', side, best, { seat: id });
        const c = this.map.hexes[best];
        this.spawn('fob', side, this.freeHex(side === N ? c.x - 12 : c.x + 12, c.y, 'fob'), { seat: id, sited: false, ent: 2 });
        if (!hq) return { ok: false, error: 'нет места для штаба' };
      }
      if (bot) this.botDeploy(id);
    } else {
      const cand = this.spawnHexes(side, 'hq').sort((a, b) => apart(b) - apart(a));
      if (cand.length) this.spawn('hq', side, cand[0], { seat: id, mp: 0, acted: true, moved: true });
      this.updateSupply(side); this.updateVision(side);
    }
    this.log(side, `К операции подключился командир ${st.n}${bot ? ' (бот)' : ''}: свой штаб и доля очков стороны.`, 'hq');
    return { ok: true, id };
  }
  /** место отдаём боту или открываем для человека (меняется только «кто ведёт») */
  setSeatBot(id, bot) {
    if (!this.seatById.has(id)) return { ok: false, error: 'нет такого места' };
    this.bots[id] = !!bot; this.seatById.get(id).bot = !!bot;
    if (bot && this.phase === 'deploy' && !this.ready[id]) { this.botDeploy(id); this.tryStart() }
    return { ok: true };
  }

  /** делёж суммы между местами без потери остатка: лишнее достаётся первым */
  static split(total, n) {
    const base = Math.floor(total / n), rest = total - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
  }
  /** места стороны, по порядку */
  seatsOf(side) { return this.seats.filter(st => st.side === side) }
  /** сторона (команда) этого места */
  sideOf(seat) { const st = this.seatById.get(seat); return st ? st.side : null }
  /** места, которые ещё не закончили ход */
  pending(side) { return this.seatsOf(side).filter(st => !this.done[st.id]) }
  /** место закончило ход: сторона переходит, когда закончили все её места */
  seatEnd(seat) {
    const side = this.sideOf(seat);
    if (side !== this.active) return { ok: false, error: 'сейчас ход противника' };
    this.done[seat] = true;
    const left = this.pending(side);
    if (!left.length) return this.endTurn();
    this.log(side, `Командир ${this.seatById.get(seat).n} закончил ход. Ждём остальных: ${left.length}.`, 'hq');
    return { ok: true, waiting: left.map(st => st.id) };
  }

  /* ---------- расстановка и закупка ---------- */
  inDeploy(side, hex) {
    if (hex < 0 || hex >= this.H.NH) return false;
    const x = this.map.hexes[hex].x, z = this.scen && this.scen.deploy ? this.scen.deploy[side] : this.mapDef.deploy ? this.mapDef.deploy[side] : W.DEPLOY_X[side];
    return x >= z[0] && x <= z[1];
  }
  /** seat — место покупателя: бюджет у места, лимиты и зона — у стороны */
  buy(seat, k, hex, deploy) {
    const side = this.sideOf(seat);
    if (!side) return { ok: false, error: 'нет такого места' };
    const T = typeof k === 'string' && Object.prototype.hasOwnProperty.call(UT, k) ? UT[k] : null;
    if (!T) return { ok: false, error: 'неизвестный тип' };
    if (!(hex >= 0 && hex < this.H.NH)) return { ok: false, error: 'нет клетки' };
    if (this.units.filter(u => u.side === side && u.str > 0).length >= W.MAX_UNITS) return { ok: false, error: `лимит частей — ${W.MAX_UNITS}` };
    /* стационарный пункт — один на командира: второй не нужен, а сектор он не удваивает */
    if (T.fob && this.units.some(u => u.seat === seat && u.k === k && u.str > 0)) return { ok: false, error: 'командный пункт уже есть — он один на командира' };
    if (this.budget[seat] < T.price) return { ok: false, error: 'не хватает очков' };
    if (this.unitAt(hex)) return { ok: false, error: 'клетка занята' };
    if (!this.passable(k, hex)) return { ok: false, error: 'сюда эта часть не встанет' };
    if (deploy) { if (!this.inDeploy(side, hex)) return { ok: false, error: 'только в своей зоне расстановки' } }
    else { const err = this.spawnErr(side, hex, k, seat); if (err) return { ok: false, error: err } }
    this.budget[seat] -= T.price; this.stats[side].spent += T.price;
    const u = this.spawn(k, side, hex, { mp: 0, acted: true, moved: true, xp: .05, seat });
    if (!deploy) this.log(side, `«${u.cs}» (${W.lc(W.unitName(side, u.k))}) прибыл: ${this.spawnPt(side, hex, seat).n}.`, 'g');
    this.ev({ e: 'spawn', to: side, id: u.id, hex });
    return { ok: true, id: u.id };
  }
  /** точка, у которой можно высадить подкрепления: свой город или узел, свой
      работающий командный пункт — сама клетка или соседняя с ней */
  spawnPt(side, hex, seat) {
    const p = this.pts.find(q => q.owner === side && q.hex === hex) ||
      this.pts.find(q => q.owner === side && this.H.hexDist(q.hex, hex) === 1 && !(this.unitAt(q.hex) && this.unitAt(q.hex).side !== side));
    if (p) return p;
    const f = seat ? this.fobLive(seat) : (this.fobsLive(side).find(x => this.H.hexDist(x.hex, hex) <= 1) || null);
    if (f && this.H.hexDist(f.hex, hex) <= 1) return { id: 'fob' + f.id, n: 'командный пункт', hex: f.hex };
    return null;
  }
  spawnErr(side, hex, k, seat) {
    if (!(hex >= 0 && hex < this.H.NH)) return 'нет клетки';
    if (this.unitAt(hex)) return 'клетка занята';
    if (!this.passable(k, hex)) return 'сюда эта часть не встанет';
    if (!this.spawnPt(side, hex, seat)) return 'подкрепления — у своего города, узла или командного пункта (на клетке или рядом)';
    if (this.H.neighbors(hex).some(h => { const e = this.unitAt(h); return e && e.side !== side })) return 'рядом противник — высадка невозможна';
    if (this.phase === 'battle' && !this.sv[side][hex]) return 'сюда не доходит снабжение — высадка невозможна';
    return null;
  }
  /** клетки, где сторона может высадить подкрепления такого типа */
  spawnHexes(side, k, seat) {
    const out = [], seeds = this.pts.filter(p => p.owner === side).map(p => p.hex);
    for (const f of (seat ? [this.fobLive(seat)].filter(Boolean) : this.fobsLive(side))) seeds.push(f.hex);
    for (const c of seeds) for (const h of this.H.within(c, 1)) if (!out.includes(h) && !this.spawnErr(side, h, k, seat)) out.push(h);
    return out;
  }

  /* ---------- приказы штаба ---------- */
  /** командные очки — у места, действие приказа — на сторону */
  order(seat, k, a) {
    const side = this.sideOf(seat);
    if (!side) return { ok: false, error: 'нет такого места' };
    const O = typeof k === 'string' && Object.prototype.hasOwnProperty.call(W.ORDERS, k) ? W.ORDERS[k] : null;
    if (!O) return { ok: false, error: 'неизвестный приказ' };
    const u = O.tgt === 'unit' ? this.byId(+a.id) : null, hex = +a.hex;
    /* связь налажена: приказ части или по клетке в секторе своего пункта дешевле */
    const tgtHex = O.tgt === 'unit' ? (u ? u.hex : -1) : O.tgt === 'hex' ? hex : -1;
    const cp = tgtHex >= 0 && this.inFobZone(seat, tgtHex) ? Math.max(1, O.cp - W.FOB.orderOff) : O.cp;
    if (this.cp[seat] < cp) return { ok: false, error: `не хватает командных очков: нужно ${cp}` };
    if (O.tgt === 'unit' && (!u || u.side !== side)) return { ok: false, error: 'укажите свою часть' };
    if (O.tgt === 'unit' && u.seat && u.seat !== seat) return { ok: false, error: 'часть другого командира' };
    if (O.tgt === 'hex' && !(hex >= 0 && hex < this.H.NH)) return { ok: false, error: 'укажите клетку' };
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
      for (const v of this.units) if (v.side === side && v.str > 0 && this.H.neighbors(v.hex).some(h => zone.has(h))) v.org = Math.min(100, v.org + 10);
      this.log(side, 'Контрудар! Вернуть наши города — любой ценой.', 'hq');
    } else if (k === 'march') {
      if (u.march) return { ok: false, error: 'часть уже на марше' };
      if (u.acted) return { ok: false, error: 'часть уже действовала' };
      if (W.usesFuel(UT[u.k]) && u.fu <= 0) return { ok: false, error: 'нет топлива' };
      u.march = true; u.mp += 3; u.org = Math.max(0, u.org - 10);
      this.say(u, 'march', {}, 'g');
    } else if (k === 'hold') {
      if (u.hold) return { ok: false, error: 'приказ уже отдан' };
      u.hold = true;
      this.say(u, 'hold', {}, 'g');
    } else if (k === 'smoke') {
      if (!this.units.some(v => v.side === side && v.str > 0 && this.H.hexDist(v.hex, hex) <= 3)) return { ok: false, error: 'дым ставят у своих частей — до 3 клеток' };
      for (const h of this.H.within(hex, 1)) this.smoke.set(h, side);
      this.ev({ e: 'smoke', to: '*', hex });
      this.log(side, 'Дымовая завеса поставлена.', 'g');
      this.updateVision(oppOf(side));
    } else if (k === 'airdrop') {
      if (!this.weather.fly) return { ok: false, error: 'погода нелётная' };
      const motorU = W.usesFuel(UT[u.k]);
      if (u.sp >= W.SUPPLY.max && (!motorU || u.fu >= W.SUPPLY.max)) return { ok: false, error: 'боеприпасы и топливо и так полные' };
      u.sp = Math.min(W.SUPPLY.max, u.sp + 2); if (motorU) u.fu = Math.min(W.SUPPLY.max, u.fu + 2); u.org = Math.min(100, u.org + 10);
      this.ev({ e: 'air', to: side, hex: u.hex, kind: 'drop' });
      this.say(u, 'airdrop', {}, 'g');
    } else if (k === 'reserve') {
      if (this.units.filter(v => v.side === side && v.str > 0).length >= W.MAX_UNITS) return { ok: false, error: `лимит частей — ${W.MAX_UNITS}` };
      const err = this.spawnErr(side, hex, 'mot', seat);
      if (err) return { ok: false, error: err };
      const v = this.spawn('mot', side, hex, { str: 7, mp: 0, acted: true, moved: true, xp: .1, seat });
      this.log(side, `Резерв ставки: «${v.cs}» (мотопехота) прибыл — ${this.spawnPt(side, hex, seat).n}.`, 'g');
      this.ev({ e: 'spawn', to: side, id: v.id, hex });
    }
    this.cp[seat] -= cp;
    this.ev({ e: 'order', to: side, k });
    return { ok: true };
  }

  sell(seat, id) {
    const side = this.sideOf(seat), u = this.byId(id);
    if (!u || u.side !== side || u.pre) return { ok: false, error: 'эту часть не вернуть' };
    if (u.seat && u.seat !== seat) return { ok: false, error: 'часть другого командира' };
    this.units = this.units.filter(x => x !== u);
    const back = UT[u.k].price + (u.att ? W.SPECS[u.att].price : 0);
    this.budget[seat] += back; this.stats[side].spent -= back;
    return { ok: true };
  }
  place(seat, id, hex) {
    const side = this.sideOf(seat), u = this.byId(id);
    if (!u || u.side !== side) return { ok: false, error: 'нет такой части' };
    if (u.seat && u.seat !== seat) return { ok: false, error: 'часть другого командира' };
    if (!this.inDeploy(side, hex)) return { ok: false, error: 'только в своей зоне расстановки' };
    /* на свою же клетку — можно: так подтверждают место, предложенное по умолчанию */
    if (hex !== u.hex && this.unitAt(hex)) return { ok: false, error: 'клетка занята' };
    if (!this.passable(u.k, hex)) return { ok: false, error: 'сюда эта часть не встанет' };
    u.hex = hex;
    if (UT[u.k].fob) { u.sited = true; this.log(side, 'Командный пункт развёрнут.', 'hq') }
    return { ok: true };
  }
  tryStart() {
    if (this.phase !== 'deploy') return;
    for (const st of this.seats) if (this.bots[st.id] && !this.ready[st.id]) this.botDeploy(st.id);
    if (this.seats.some(st => !this.ready[st.id])) return;
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
    /* фронт — по тому, как встали: зоны расстановки, точки и части */
    this.initTerritory();
    this.updateSupply(N); this.updateSupply(S);
    this.startSide(this.active);
  }

  /* ---------- ход стороны ---------- */
  startSide(side) {
    this.active = side;
    this.recon[side] = new Set();
    const night = isNight(this.turn);
    const mySeats = this.seatsOf(side);
    /* вылеты и командные очки — каждому месту; на сторону их столько же,
       сколько было у одного командира, поэтому делим между местами */
    const share = mySeats.length;
    const fly = this.weather.fly ? 1 : 0;
    const strikes = Game.split(AIR.strike[night ? 1 : 0] * fly, share);
    const recons = Game.split(AIR.recon[night ? 1 : 0] * fly, share);
    mySeats.forEach((st, i) => {
      this.done[st.id] = false;
      /* сбитые в прошлый ход штурмовики — минус вылеты */
      const lost = Math.min(strikes[i], this.airLost[st.id] || 0);
      if (lost) this.log(side, `Потери авиации: ${lost === 1 ? 'один штурмовик сбит' : 'сбиты штурмовики'} — ударных вылетов в этот ход меньше.`, 'w');
      this.airLost[st.id] = 0;
      this.air[st.id] = { strike: strikes[i] - lost, recon: recons[i] };
    });
    this.updateSupply(side);
    const hqAlive = this.units.some(v => v.side === side && v.k === 'hq' && v.str > 0);
    for (const st of mySeats) {
      /* пункт даёт очко только пока работает: блокированный узел молчит */
      const f = this.fobOf(st.id), live = this.fobLive(st.id);
      this.cp[st.id] = Math.min(W.CP.max, this.cp[st.id] + W.CP.per + (hqAlive ? W.CP.hq : 0) + (live ? W.CP.fob : 0));
      if (f && !live && f.sited !== false) this.log(side, 'Командный пункт блокирован: противник рядом. Подвоза, подкреплений и очка за пункт нет.', 'w');
    }
    this.barrage[side] = false; this.counter[side] = false;
    for (const [h, s] of this.smoke) if (s === side) this.smoke.delete(h);
    const cmd = this.cmdHexes(side);
    for (const u of this.units) if (u.side !== side) u.hb = 0;   /* «связан боем» — только в чужой ход */
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const T = UT[u.k];
      let mp = T.mp;
      const cz = cmd.get(u.seat) || cmd.get(u.side);
      if (!(cz && cz.has(u.hex)) && u.k !== 'hq') mp -= 1;
      /* топливо — только технике: без него она стоит, пехота идёт пешком */
      const motor = W.usesFuel(T), dry = motor && u.fu <= 0;
      if (motor && !dry) { if (u.fu === 1) mp = Math.ceil(mp / 2); else if (u.fu === 2) mp -= 1 }
      /* подавленные шаги возвращаются в начале своего хода — сколько, зависит от снабжения */
      if (u.su > 0) {
        mp -= 1;
        const tier = W.supTier(u.sv);
        u.su = tier === 'none' ? Math.max(0, u.su - 1) : tier === 'low' ? Math.floor(u.su / 2) : 0;
      }
      if (u.org < 25) mp = Math.min(mp, 2);
      u.mp = T.fob || dry ? 0 : Math.max(1, mp); u.acted = false; u.moved = false; u.sup = u.su > 0;
      u.amb = false; u.ambUsed = false; u.support = false; u.hold = false; u.march = false; u.exploit = false;
      u.startHex = u.hex;
    }
    /* доход стороны — от удержанных точек; делится между её местами поровну,
       остаток достаётся первым, так что сумма по команде ровно равна доходу стороны */
    const inc = Math.round((W.BASE_INCOME + this.heldWeight(side, true) * W.INCOME_PER_WEIGHT) * (W.ROLE_INCOME_MUL[this.role[side]] || 1));
    this.sideIncome = this.sideIncome || {};
    this.sideIncome[side] = inc;
    const parts = Game.split(inc, share);
    mySeats.forEach((st, i) => { this.income[st.id] = parts[i]; this.budget[st.id] += parts[i] });
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
      /* перезарядка считается со следующего хода: иначе счётчик сгорал в конце
         того же хода, что и залп, и РСЗО стреляли каждый ход */
      if (u.reload > 0 && !u.fired) u.reload--;
      u.fired = false;
      u.hitThisTurn = false;
      if (T.bomb && !u.acted && u.reload <= 0 && u.org >= 30) u.support = true;
    }
    this.updateSupply(side);
    const SP = W.SUPPLY, cmd = this.cmdHexes(side);
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      const tier = W.supTier(u.sv);
      if (tier !== 'none') {
        u.cut = 0; u.dry = false;
        /* запас: полное и нормальное снабжение — до полного, скудное — не выше 2 */
        const lim = tier === 'low' ? SP.lowCap : SP.max;
        if (u.sp < lim) u.sp = Math.min(lim, u.sp + SP.regen[tier]);
        if (W.usesFuel(UT[u.k]) && u.fu < lim) u.fu = Math.min(lim, u.fu + SP.regen[tier]);
        u.dryF = false;
        /* мораль: отдых даёт больше, но и в бою она возвращается */
        const rest = !u.moved && !u.acted, cz = cmd.get(u.seat) || cmd.get(u.side);
        const gain = SP.org[tier][rest ? 0 : 1] + (cz && cz.has(u.hex) ? SP.orgCmd : 0);
        u.org = Math.min(100, u.org + gain);
        continue;
      }
      /* котёл: запас тает по делению за ход, без запасов — потери и сдача */
      u.cut++;
      u.sp = Math.max(0, u.sp - 1);
      /* в котле техника сжигает топливо и встаёт; пехота уходит пешком */
      if (W.usesFuel(UT[u.k])) {
        u.fu = Math.max(0, u.fu - 1);
        if (u.fu === 0 && !u.dryF) { u.dryF = true; this.log(side, `«${u.cs}»: кончилось топливо — техника встала.`, 'crit') }
      }
      u.org = Math.max(0, u.org - (u.sp === 0 ? 20 : 8));
      if (u.cut === 1) this.say(u, 'cut', {}, 'crit');
      if (u.sp === 0) {
        if (!u.dry) { this.say(u, 'exhausted', {}, 'crit'); u.dry = true }
        this.loss(u, u.cut >= 4 ? 2 : 1, null);
        if (u.str > 0 && u.cut >= 4) this.say(u, 'attrition', {}, 'w');
        if (u.str > 0 && u.org <= 0) {
          const by = this.units.filter(e => e.side !== side && e.str > 0).sort((a, b) => this.H.hexDist(a.hex, u.hex) - this.H.hexDist(b.hex, u.hex))[0];
          this.loss(u, u.str, by && this.H.hexDist(by.hex, u.hex) <= 4 ? by : null, 'surrender');
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
      const pool = wxPool(this.mapDef).filter(x => x.w.id !== this.weather.id);
      let r = this.rnd() * pool.reduce((a, x) => a + x.k, 0);
      for (const x of pool) { r -= x.k; if (r <= 0) { this.weather = x.w; break } }
      this.wxLeft = 2 + Math.floor(this.rnd() * 4);
      this.log('*', `Метео: ${this.weather.n.toLowerCase()}. ${this.weather.d}`, 'm');
    }
    this.scenarioRound();
    this.rebuildFront();
    this.checkEnd();
  }

  /* ---------- движение ---------- */
  move(u, to) {
    if (UT[u.k].fob) return { ok: false, error: 'командный пункт не передвигают' };
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
      if (i < path.length - 1 && this.H.neighbors(h).some(n => { const e = this.unitAt(n); return e && e.side !== u.side })) {
        const e = this.H.neighbors(h).map(n => this.unitAt(n)).find(e => e && e.side !== u.side);
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
    this.claimPath(u.side, done);
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
      if (this.H.hexDist(p.hex, u.hex) !== 1 || this.unitAt(p.hex)) continue;
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
  /** штаб без охраны: рядом нет ни одной живой части своей стороны */
  hqAlone(e) {
    return !this.H.neighbors(e.hex).some(h => { const v = this.unitAt(h); return v && v.side === e.side && v.str > 0 });
  }
  /** Захват ставки: брошенный штаб не уничтожают, а берут — вместе со штабными
      документами. Захватчику командные очки и вскрытый сектор противника. */
  captureHQ(e, u) {
    const seat = e.seat || e.side, zone = this.H.within(e.hex, UT[e.k].cmd);
    this.ev({ e: 'dead', to: '*', id: e.id, hex: e.hex, k: e.k, side: e.side, how: 'captured' });
    e.str = 0;
    const st = this.stats[e.side], price = UT[e.k].price;
    st.lost[e.k] = (st.lost[e.k] || 0) + 1; st.lostV += price;
    const ks = this.stats[u.side];
    ks.killed[e.k] = (ks.killed[e.k] || 0) + 1; ks.killedV += price;
    this.lastVacated = e.hex;
    /* трофей: командные очки захватившему командиру */
    const mySeat = u.seat || u.side;
    this.cp[mySeat] = Math.min(W.CP.max, (this.cp[mySeat] || 0) + W.HQ_CAPTURE_CP);
    /* штабные документы: сектор противника вскрыт до конца его следующего хода */
    for (const h of zone) this.recon[u.side].add(h);
    this.updateVision(u.side);
    /* части бывшего сектора теряют управление и мораль */
    for (const v of this.units) if (v.side === e.side && v.str > 0 && this.H.hexDist(v.hex, e.hex) <= UT[e.k].cmd) v.org = Math.max(0, v.org - 20);
    this.log(e.side, `Ставка командира ${this.seatById.get(seat) ? this.seatById.get(seat).n : ''} захвачена! Документы у противника, части без управления.`, 'crit');
    this.log(u.side, `Взята ставка противника: +${W.HQ_CAPTURE_CP}★ и вскрытый сектор.`, 'g');
    return { ok: true, captured: 1 };
  }

  attack(u, e) {
    const T = UT[u.k];
    if (!e || e.side === u.side) return { ok: false, error: 'нет цели' };
    if (u.acted) return { ok: false, error: 'часть уже атаковала' };
    if (T.bomb) return { ok: false, error: 'артиллерия бьёт огнём — «Огонь»' };
    if (this.H.hexDist(u.hex, e.hex) !== 1) return { ok: false, error: 'цель не рядом' };
    if (!this.seen(u.side, e)) return { ok: false, error: 'цель не видна' };
    if (u.org < 20) return { ok: false, error: 'часть дезорганизована' };
    if (u.sp <= 0) return { ok: false, error: 'нет боеприпасов — запасы кончились' };
    if (Rules.effStr(u) <= 0) return { ok: false, error: 'все шаги подавлены — ждите своего хода' };
    /* штаб без охраны берут в плен, а не вышибают: за это командные очки и документы */
    if (UT[e.k].cmd && T.cap && this.hqAlone(e)) {
      u.acted = true; u.mp = 0; u.revealed = this.turn;
      const res = this.captureHQ(e, u);
      this.advanceAfterFight(u, T, true);
      this.updateVision(u.side); this.updateVision(oppOf(u.side));
      return res;
    }
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
      const art = this.units.find(a => a.side === e.side && a.support && a.str > 0 && this.H.hexDist(a.hex, e.hex) <= UT[a.k].bomb.rng);
      if (art) {
        art.support = false; art.revealed = this.turn;
        this.ev({ e: 'shell', to: '*', from: art.hex, hex: u.hex, k: art.k });
        this.say(art, 'support', {}, 'g');
        if (this.chance(.5 + .03 * art.str)) this.loss(u, 1, art);
      }
    }
    this.loss(e, ld, u);
    this.loss(u, la, e);
    /* сверх потерь бой прижимает: часть шагов подавлена до начала своего хода */
    if (e.str > 0) { e.su = Math.min(e.str, (e.su || 0) + Math.round(ld * .5 * this.R(.6, 1.4))); e.sup = e.su > 0 }
    if (u.str > 0) { u.su = Math.min(u.str, (u.su || 0) + Math.round(la * .5 * this.R(.6, 1.4))); u.sup = u.su > 0 }
    u.org = Math.max(0, u.org - la * 4); this.gainXp(u, .06);
    if (e.str > 0) {
      e.org = Math.max(0, e.org - ld * 6 - (retreat ? 8 : 0)); this.gainXp(e, .05);
      if (e.org < 15) retreat = true;
      if (Rules.effStr(e) <= 0) retreat = true;   /* все шаги прижаты — держать нечем */
      if (e.hold && retreat) { retreat = false; e.org = Math.max(0, e.org - 10) }
      if (this.forts.get(e.hex) && e.org >= 40 && retreat && this.chance(.5)) { retreat = false; this.say(e, 'fortHold', {}) }
      if (retreat) this.retreat(e, u);
      else this.say(e, 'held', {}, '');
    }
    this.advanceAfterFight(u, T, fresh);
    this.updateVision(u.side); this.updateVision(oppOf(u.side));
    return { ok: true, la, ld };
  }
  /** обстрел: огневой бой с места по соседней цели — прижать, не штурмуя. Клетку не занимаем,
      окоп не теряем, цель не отходит; ответный огонь слабее, чем в атаке (W.FIREFIGHT) */
  fire(u, e) {
    const T = UT[u.k];
    if (!e || e.side === u.side) return { ok: false, error: 'нет цели' };
    if (u.acted) return { ok: false, error: 'часть уже действовала' };
    if (T.bomb) return { ok: false, error: 'артиллерия бьёт огнём — «Огонь»' };
    if (this.H.hexDist(u.hex, e.hex) !== 1) return { ok: false, error: 'цель не рядом' };
    if (!this.seen(u.side, e)) return { ok: false, error: 'цель не видна' };
    if (!(T.atk[UT[e.k].arm] > 0)) return { ok: false, error: 'по этой цели бить нечем' };
    if (u.org < 20) return { ok: false, error: 'часть дезорганизована' };
    if (u.sp <= 0) return { ok: false, error: 'нет боеприпасов — запасы кончились' };
    if (Rules.effStr(u) <= 0) return { ok: false, error: 'все шаги подавлены — ждите своего хода' };
    const o = Rules.fireOdds(this.ctxFor(u.side, true), u, e);
    const ld = Math.min(e.str, Math.round(o.kill * this.R(.5, 1.5)));
    const la = Math.min(u.str, Math.round(o.back * this.R(.5, 1.5)));
    const sp = Math.round(o.sup * this.R(.6, 1.4));
    u.acted = true; u.mp = 0; u.revealed = this.turn;
    e.revealed = this.turn; e.hitThisTurn = true; e.hb = (e.hb || 0) | Rules.ARMBIT[T.arm];
    this.ev({ e: 'fight', to: '*', a: u.id, d: e.id, ah: u.hex, dh: e.hex, la, ld, r: +o.r.toFixed(2), fire: 1, su: sp });
    this.say(u, 'firefight', { lb: W.lc(W.unitName(e.side, e.k)) });
    this.loss(e, ld, u);
    this.loss(u, la, e);
    if (e.str > 0) {
      if (sp) { e.su = Math.min(e.str, (e.su || 0) + sp); e.sup = true }
      e.org = Math.max(0, e.org - 4 - ld * 3 - sp); this.gainXp(e, .02);
      this.say(e, 'pinned', {}, 'w');
    }
    if (u.str > 0) { u.org = Math.max(0, u.org - la * 4); this.gainXp(u, .03) }
    /* уничтоженную огнём цель не преследуем: клетка остаётся пустой */
    this.lastVacated = null;
    this.updateVision(u.side); this.updateVision(oppOf(u.side));
    return { ok: true, la, ld, su: sp };
  }
  /** занять освободившуюся клетку после боя (отход, гибель или захват ставки) */
  advanceAfterFight(u, T, fresh) {
    const vac = this.lastVacated;
    if (u.str > 0 && T.cap && vac !== undefined && vac !== null && !this.unitAt(vac) && this.H.hexDist(u.hex, vac) === 1) {
      const d = this.H.dirTo(u.hex, vac);
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
        this.claimPath(u.side, [vac]);
        this.capture(u);
        /* прорыв: подвижные части развивают успех */
        if (['tnk', 'mot', 'rec'].includes(u.k) && !u.exploit && u.org >= 40 && u.sp >= 2 && u.fu >= 2 && u.str >= 4) {
          u.exploit = true; u.acted = false; u.mp = Math.max(u.mp, 2);
          this.say(u, 'exploit', {}, 'g');
        }
        if (u.str > 0) this.militia(u);
      }
    }
    this.lastVacated = null;
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
    if (u.su > u.str) u.su = u.str;
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
    if (UT[u.k].cmd) {
      for (const v of this.units) if (v.side === u.side && v.str > 0 && this.H.hexDist(v.hex, u.hex) <= UT[u.k].cmd) v.org = Math.max(0, v.org - 15);
      this.log(u.side, 'Штаб уничтожен! Части без управления.', 'crit');
    }
    /* бегство заразно */
    for (const v of this.units) if (v.side === u.side && v.str > 0 && this.H.hexDist(v.hex, u.hex) === 1) v.org = Math.max(0, v.org - 6);
  }
  /** отход на клетку от атакующего; отрезанным — потери или плен */
  retreat(e, by) {
    const ctx = this.ctxFor(e.side, true), zoc = Rules.zocOf(ctx, e.side);
    let best = -1, bs = -1e9;
    for (let d = 0; d < 6; d++) {
      const h = this.H.nb(e.hex, d);
      if (h < 0 || this.unitAt(h) || !this.passable(e.k, h)) continue;
      const ed = Rules.edgeOf(ctx, e.hex, d);
      if (!Rules.crossable(ed) && UT[e.k].cls === 'wheel') continue;
      const s = this.H.hexDist(h, by.hex) * 3 - (zoc.has(h) ? 4 : 0) + (this.sv[e.side][h] > 0 ? 2 : 0) + (this.terr[h] === TCODE[e.side] ? 3 : 0) + (Rules.crossable(ed) ? 0 : -3);
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
    const around = this.H.neighbors(best).filter(h => { const o = this.unitAt(h); return o && o.side !== e.side }).length;
    if (around >= 2 && e.str > 0) { this.loss(e, 1, by); if (e.str > 0) this.log(e.side, `«${e.cs}»: отходили под перекрёстным огнём — потери.`, 'w') }
  }

  /* ---------- артиллерия, авиация ---------- */
  bombard(u, hex) {
    const T = UT[u.k];
    if (!T.bomb) return { ok: false, error: 'эта часть не стреляет с закрытых позиций' };
    if (u.acted) return { ok: false, error: 'уже стреляли' };
    if (u.reload > 0) return { ok: false, error: 'перезарядка' };
    if (u.sp <= 0) return { ok: false, error: 'нет снарядов — запасы кончились' };
    if (Rules.effStr(u) <= 0) return { ok: false, error: 'все расчёты подавлены — ждите своего хода' };
    if (this.H.hexDist(u.hex, hex) > T.bomb.rng) return { ok: false, error: `далеко: дальность ${T.bomb.rng} клетки` };
    const e = this.unitAt(hex);
    if (!e || e.side === u.side || !this.seen(u.side, e)) return { ok: false, error: 'цели не видно' };
    const ctx = this.ctxFor(u.side, true);
    this.ev({ e: 'shell', to: '*', from: u.hex, hex, k: u.k });
    const bar = this.barrage[u.side];
    this.hitByFire(ctx, Rules.firePow(u), e, u, { th: T.th, barrage: bar, sp: u.sp });
    if (T.bomb.area) for (const h of this.H.neighbors(hex)) { const x = this.unitAt(h); if (x && x.side !== u.side) this.hitByFire(ctx, Rules.firePow(u) * T.bomb.area, x, u, { barrage: bar, sp: u.sp, splash: true }) }
    u.acted = true; u.mp = 0; u.revealed = this.turn; u.reload = T.bomb.reload; u.fired = true;
    this.say(u, 'fire', {});
    this.counterBattery(u);
    return { ok: true };
  }
  /** контрбатарейная борьба: артиллерия противника, не стрелявшая в свой ход, отвечает по засечённой батарее */
  counterBattery(u) {
    if (u.str <= 0) return;
    const art = this.units.filter(a => a.side !== u.side && a.str > 0 && a.support && UT[a.k].bomb && this.H.hexDist(a.hex, u.hex) <= UT[a.k].bomb.rng)
      .sort((a, b) => UT[b.k].bomb.pow * b.str - UT[a.k].bomb.pow * a.str)[0];
    if (!art) return;
    art.support = false; art.revealed = this.turn;
    this.ev({ e: 'counter', to: '*', hex: art.hex });
    this.ev({ e: 'shell', to: '*', from: art.hex, hex: u.hex, k: art.k });
    this.say(art, 'counter', {}, 'g');
    this.hitByFire(this.ctxFor(art.side, true), Rules.firePow(art) * .6, u, art, { th: UT[art.k].th });
  }
  hitByFire(ctx, pow, e, by, opt) {
    const b = Rules.bombardOdds(ctx, pow, e, opt);
    /* огонь больше прижимает, чем убивает: потери и подавленные шаги отдельно */
    const n = Math.min(e.str, Math.round(b.kill * this.R(.5, 1.5)));
    const sp = Math.round(b.sup * this.R(.6, 1.4));
    this.ev({ e: 'blast', to: '*', hex: e.hex, big: pow > 11 ? 1 : 0, ld: n, id: e.id });
    e.org = Math.max(0, e.org - (opt && opt.splash ? 3 : 7) - n * 3 - sp); e.hitThisTurn = true;
    this.loss(e, n, by);
    if (e.str > 0) {
      if (sp) { e.su = Math.min(e.str, (e.su || 0) + sp); e.sup = true }
      this.say(e, 'shelled', {}, 'w');
    }
  }
  /** вылеты — ресурс места, видимость и цели — на сторону */
  airAct(seat, kind, hex) {
    const side = this.sideOf(seat);
    if (!side) return { ok: false, error: 'нет такого места' };
    if (!(hex >= 0 && hex < this.H.NH)) return { ok: false, error: 'нет клетки' };
    if (!this.weather.fly) return { ok: false, error: 'погода нелётная' };
    if (kind === 'recon') {
      if (this.air[seat].recon < 1) return { ok: false, error: 'разведчиков в этот ход больше нет' };
      this.air[seat].recon--;
      /* под зонтиком ПВО противника разведчик не проходит — эти клетки остаются тёмными */
      const zone = Rules.aaZone(this.ctxFor(side, true), oppOf(side));
      let shut = 0;
      for (const h of this.H.within(hex, 3)) { if (zone.has(h)) shut++; else this.recon[side].add(h) }
      this.updateVision(side);
      this.ev({ e: 'air', to: side, hex, kind });
      this.log(side, shut ? 'Авиаразведка прошла над районом, но часть его прикрыта ПВО — там ничего не видно.' : 'Авиаразведка прошла над районом — данные на карте.', 'q');
      return { ok: true, shut };
    }
    if (kind !== 'strike') return { ok: false, error: 'неизвестный вылет' };
    if (this.air[seat].strike < 1) return { ok: false, error: 'ударных вылетов в этот ход больше нет' };
    const e = this.unitAt(hex);
    if (!e || e.side === side || !this.seen(side, e)) return { ok: false, error: 'цели не видно' };
    this.air[seat].strike--;
    this.ev({ e: 'air', to: '*', hex, kind, side });
    /* ПВО над целью (зенитные дивизионы рядом и приданный взвод): удар слабее,
       а с шансом штурмовик сбит — тогда удара нет, и у командира в следующий
       ход на вылет меньше. Всё это видно в расчёте до клика. */
    const ctx = this.ctxFor(side, true), o = Rules.airOdds(ctx, e);
    if (o.cover > 0) {
      const a = o.by[0] || e;
      if (this.chance(o.shot)) {
        this.airLost[seat] = (this.airLost[seat] || 0) + 1;
        this.ev({ e: 'aa', to: '*', hex: a.hex, target: hex, down: 1 });
        if (a !== e || e.att === 'aaa') { a.revealed = this.turn; this.gainXp(a, .04) }
        this.log(side, 'Штурмовик сбит ПВО над целью: удара нет, в следующий ход вылетов на один меньше.', 'w');
        this.log(e.side, a === e ? `«${e.cs}»: зенитный взвод сбил штурмовик!` : `«${a.cs}»: сбит штурмовик противника!`, 'g');
        return { ok: true, intercepted: true, down: true };
      }
      this.ev({ e: 'aa', to: '*', hex: a.hex, target: hex });
    }
    this.hitByFire(ctx, AIR.pow, e, { side, xp: 0 }, { air: true, th: true, kill: AIR.kill, cap: AIR.cap, aaCut: o.cut });
    this.log(side, o.cover > 0 ? `Авиаудар нанесён сквозь ПВО — эффект ×${o.cut.toFixed(2).replace('.', ',')}.` : 'Авиаудар нанесён.', 'g');
    return { ok: true };
  }

  /* ---------- приданные специалисты ----------
     Один на часть, за очки. При расстановке — свободно; в бою — вместо действий
     в этот ход, на снабжении 3+ и без противника рядом. */
  attachSpec(seat, u, k, deploy) {
    const side = this.sideOf(seat);
    const S = typeof k === 'string' && Object.prototype.hasOwnProperty.call(W.SPECS, k) ? W.SPECS[k] : null;
    if (!S) return { ok: false, error: 'неизвестный специалист' };
    if (!u || u.side !== side || u.str <= 0) return { ok: false, error: 'нет такой части' };
    if (u.seat && u.seat !== seat) return { ok: false, error: 'часть другого командира' };
    if (u.att) return { ok: false, error: 'специалист уже придан — один на часть' };
    if (!S.for(UT[u.k])) return { ok: false, error: 'этой части такого не придать' };
    if (this.budget[seat] < S.price) return { ok: false, error: `не хватает очков: нужно ${S.price}` };
    if (!deploy) {
      if (u.acted || u.moved) return { ok: false, error: 'придать — вместо действий в этот ход' };
      if ((u.sv || 0) < W.SUPPLY.replaceMin) return { ok: false, error: `нужно снабжение от ${W.SUPPLY.replaceMin}` };
      if (this.H.neighbors(u.hex).some(h => { const e = this.unitAt(h); return e && e.side !== side })) return { ok: false, error: 'противник рядом' };
    }
    this.budget[seat] -= S.price; this.stats[side].spent += S.price;
    u.att = k;
    if (!deploy) { u.acted = true; u.mp = 0 }
    this.log(side, `«${u.cs}»: придан специалист — ${S.n.toLowerCase()}.`, 'g');
    if (k === 'rcn') this.updateVision(side);
    return { ok: true };
  }

  /* ---------- пополнение ---------- */
  replace(u) {
    const T = UT[u.k];
    /* в секторе своего работающего пункта пополнение идёт с его складов — дешевле */
    const near = this.inFobZone(u.seat || u.side, u.hex);
    const cost = Math.max(1, Math.round(T.price / 10 * (near ? 1 - W.FOB.replaceOff : 1)));
    if (u.str >= MAX_STR) return { ok: false, error: 'часть полная' };
    if (u.acted || u.moved) return { ok: false, error: 'пополнение — вместо действий в этот ход' };
    if ((u.sv || 0) < W.SUPPLY.replaceMin) return { ok: false, error: `снабжение ${u.sv || 0} из 10 — для пополнения нужно от ${W.SUPPLY.replaceMin}` };
    if (this.H.neighbors(u.hex).some(h => { const e = this.unitAt(h); return e && e.side !== u.side })) return { ok: false, error: 'противник рядом' };
    /* сколько шагов за раз — от снабжения: 3–5 → 1, 6–8 → 2, 9–10 → 3 */
    const can = Math.min(Math.floor((u.sv || 0) / 3), MAX_STR - u.str, Math.floor(this.budget[u.side] / cost));
    if (can < 1) return { ok: false, error: 'не хватает очков' };
    this.budget[u.side] -= can * cost; this.stats[u.side].spent += can * cost;
    u.xp = (u.xp * u.str + .05 * can) / (u.str + can);
    u.str += can; u.acted = true; u.mp = 0;
    this.ev({ e: 'replace', to: u.side, id: u.id, n: can });
    this.say(u, 'replaced', { n: can }, 'g');
    if (near) this.log(u.side, `«${u.cs}» пополнен со складов командного пункта — дешевле на треть.`, 'g');
    return { ok: true, n: can };
  }

  /* ---------- сапёры ---------- */
  engAct(u, task, hex) {
    if (!UT[u.k].eng) return { ok: false, error: 'это не сапёры' };
    if (u.acted) return { ok: false, error: 'уже работали в этот ход' };
    if (task === 'dig') return this.digIn(u);
    const d = this.H.dirTo(u.hex, hex);
    if (d < 0 && !['mine', 'fort', 'obst'].includes(task)) return { ok: false, error: 'только у соседней клетки' };
    if (task === 'repair') {
      const key = Hex.edgeKey(u.hex, hex);
      if (this.br.get(key) !== 'down') return { ok: false, error: 'здесь нет взорванного моста' };
      if (this.H.neighbors(hex).concat([hex]).some(h => { const e = this.unitAt(h); return e && e.side !== u.side })) return { ok: false, error: 'под огнём мост не восстановить' };
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
      if (a.side === u.side || !a.amb || a.ambUsed || a.str <= 0 || this.H.hexDist(a.hex, h) !== 1) continue;
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
    if (UT[u.k].eng) for (const h of this.H.neighbors(u.hex)) { const v = this.unitAt(h); if (v && v.side === u.side) list.push(v) }
    for (const v of list) v.ent = Math.min(UT[v.k].arm === 'soft' ? 3 : 2, v.ent + 1);
    u.acted = true; u.mp = 0;
    this.ev({ e: 'eng', to: '*', id: u.id, hex: u.hex, task: 'dig' });
    return { ok: true };
  }

  /* ---------- снабжение ---------- */
  /* ---------- снабжение по дорогам, как в Unity of Command ----------
     Два прохода. Сеть: от источников по рёбрам-дорогам (мосты целы), по своей
     земле, мимо противника. Поле: с каждой клетки сети — в стороны, с большой
     потерей за клетку; в сеть поле не возвращается. Зона контроля противника,
     где нет своей части, принимает снабжение, но дальше его не пропускает. */
  supplySources(side) {
    const SP = W.SUPPLY, t = TCODE[side], out = [], H = this.H;
    const enemyOn = h => { const o = this.unitAt(h); return o && o.side !== side && o.str > 0 };
    /* тыловые станции: свои дорожные клетки ближе всего к своему краю */
    const colOf = h => h % H.COLS, rear = side === N ? c => c : c => H.COLS - 1 - c;
    let edgeMost = 1e9;
    for (let h = 0; h < H.NH; h++) if (this.map.hexes[h].road && this.terr[h] === t) edgeMost = Math.min(edgeMost, rear(colOf(h)));
    for (let h = 0; h < H.NH; h++) {
      if (!this.map.hexes[h].road || this.terr[h] !== t || enemyOn(h)) continue;
      if (rear(colOf(h)) <= edgeMost + SP.rearCols) out.push({ hex: h, v: SP.rear, n: 'Тыловая станция', k: 'rear' });
    }
    for (const p of this.pts) if (p.owner === side && p.city && this.terr[p.hex] === t && !enemyOn(p.hex)) out.push({ hex: p.hex, v: SP.city(p.w), n: p.n, k: 'city' });
    for (const f of this.fobsLive(side)) out.push({ hex: f.hex, v: SP.fob, n: 'Командный пункт', k: 'fob' });
    return out;
  }
  updateSupply(side) {
    const SP = W.SUPPLY, t = TCODE[side], NH = this.H.NH, ctx = this.ctxFor(side, true);
    const zoc = Rules.zocOf(ctx, side);
    const enemyOn = h => { const o = this.unitAt(h); return o && o.side !== side && o.str > 0 };
    const ownOn = h => { const o = this.unitAt(h); return o && o.side === side && o.str > 0 };
    /* зона контроля противника без своей части: принять можно, передать дальше — нет */
    const choke = h => zoc.has(h) && !ownOn(h);
    const ok = h => h >= 0 && this.terr[h] === t && !enemyOn(h);
    /* «куча» по убыванию значения — карты небольшие, линейный поиск максимума хватает */
    const run = (best, heap, step) => {
      while (heap.length) {
        let bi = 0; for (let i = 1; i < heap.length; i++) if (heap[i][0] > heap[bi][0]) bi = i;
        const [v, a] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
        if (v < best[a] || v <= 0 || choke(a)) continue;
        for (let d = 0; d < 6; d++) {
          const h = this.H.nb(a, d);
          if (!ok(h)) continue;
          const c = step(a, d, h);
          if (c === null) continue;
          if (v - c > best[h]) { best[h] = v - c; heap.push([v - c, h]) }
        }
      }
    };
    /* 1. сеть: только по дорогам и целым мостам */
    const net = new Float64Array(NH).fill(-1), q1 = [];
    const srcs = this.supplySources(side);
    for (const sr of srcs) if (sr.v > net[sr.hex]) { net[sr.hex] = sr.v; q1.push([sr.v, sr.hex]) }
    run(net, q1, (a, d) => {
      const e = Rules.edgeOf(ctx, a, d);
      return (e & Hex.RD) && Rules.crossable(e) ? SP.net : null;
    });
    /* 2. поле: с каждой клетки сети (и от источников вне дорог) — в стороны.
          В распутицу и снег грунтовки раскисают: поле съедает снабжение быстрее */
    const wxF = (1 - (this.weather.mud || 1)) * SP.wx;
    const field = Float64Array.from(net), q2 = [];
    for (let h = 0; h < NH; h++) if (net[h] > 0) q2.push([net[h], h]);
    run(field, q2, (a, d, h) => {
      const e = Rules.edgeOf(ctx, a, d), hx = this.map.hexes[h];
      return SP.field + wxF + (SP.fterr[hx.t] || 0) + (Rules.crossable(e) ? 0 : SP.ford);
    });
    const sv = this.sv[side], isNet = this.svNet[side];
    for (let h = 0; h < NH; h++) {
      sv[h] = field[h] <= 0 ? 0 : Math.min(SP.top, Math.round(field[h]));
      isNet[h] = net[h] > 0 && this.map.hexes[h].road ? 1 : 0;
    }
    this.svSrc[side] = srcs;
    for (const u of this.units) {
      if (u.side !== side || u.str <= 0) continue;
      u.sv = sv[u.hex]; u.supplied = u.sv > 0;
    }
  }

  /* ---------- территория и линия фронта ----------
     Каждая клетка принадлежит стороне. Часть, прошедшая через клетку, берёт
     её и соседние — если те не прикрыты противником (рядом нет его частей)
     и это не его город. Пустые карманы чужой земли, окружённые нашей,
     переходят к нам. Линия фронта — граница территорий. */
  initTerritory() {
    const NH = this.H.NH, inf = this.frontInfluence();
    for (let h = 0; h < NH; h++) {
      const hx = this.map.hexes[h];
      this.terr[h] = this.inDeploy(N, h) && !this.inDeploy(S, h) ? 1 : this.inDeploy(S, h) && !this.inDeploy(N, h) ? 2 : inf(hx.x, hx.y) > 0 ? 1 : 2;
    }
    for (const p of this.pts) if (p.owner && p.hex >= 0) this.terr[p.hex] = TCODE[p.owner];
    for (const u of this.units) if (u.str > 0) this.terr[u.hex] = TCODE[u.side];
    this.rebuildFront();
  }
  /** поле влияния сторон: города и части тянут фронт к себе */
  frontInfluence() {
    return (x, y) => {
      let v = 0;
      for (const p of this.pts) { if (!p.owner) continue; const d2 = (x - p.x) ** 2 + (y - p.y) ** 2 + 110; v += (p.owner === N ? 1 : -1) * (p.city ? 2.4 : 1) * p.w / d2 }
      for (const u of this.units) { if (u.str <= 0) continue; const h = this.map.hexes[u.hex]; v += (u.side === N ? 1 : -1) * 4 * u.str / MAX_STR / ((x - h.x) ** 2 + (y - h.y) ** 2 + 160) }
      /* свой тыловой край — тоже якорь */
      v += .02 / ((x + 20) ** 2 / 400 + 1) - .02 / ((this.WW + 20 - x) ** 2 / 400 + 1);
      return v;
    };
  }
  /** часть стороны прошла по клеткам path — забрать их и не прикрытых соседей */
  claimPath(side, path) {
    const t = TCODE[side], foe = oppOf(side);
    const foeOn = h => { const o = this.unitAt(h); return !!o && o.side === foe && o.str > 0 };
    const covered = h => foeOn(h) || this.H.neighbors(h).some(foeOn);
    let changed = false;
    for (const hex of path) {
      if (this.terr[hex] !== t) { this.terr[hex] = t; changed = true }
      for (const n of this.H.neighbors(hex)) {
        if (this.terr[n] === t || covered(n)) continue;
        const p = this.ptAt(n);
        if (p && p.owner === foe) continue;         /* чужой город берут, только войдя в него */
        this.terr[n] = t; changed = true;
      }
    }
    if (changed) { this.sweepPockets(side); this.rebuildFront() }
  }
  /** пустые карманы чужой земли, со всех сторон окружённые нашей, — наши */
  sweepPockets(side) {
    const t = TCODE[side], ft = TCODE[oppOf(side)], NH = this.H.NH, seen = new Uint8Array(NH);
    for (let h0 = 0; h0 < NH; h0++) {
      if (seen[h0] || this.terr[h0] !== ft) continue;
      const comp = [h0]; seen[h0] = 1;
      let open = false;
      for (let i = 0; i < comp.length; i++) {
        const a = comp[i], o = this.unitAt(a), p = this.ptAt(a);
        if ((o && o.side !== side && o.str > 0) || (p && p.owner && p.owner !== side)) open = true;
        const nb = this.H.neighbors(a);
        if (nb.length < 6) open = true;             /* выходит к краю карты — не карман */
        for (const n of nb) if (!seen[n] && this.terr[n] === ft) { seen[n] = 1; comp.push(n) }
      }
      if (!open) for (const h of comp) this.terr[h] = t;
    }
  }
  /** линия фронта для ИИ и мини-карты: доля своей земли в каждом ряду */
  rebuildFront() {
    const xs = [];
    for (let y = 0; y <= this.WH; y += 6) {
      let n = 0, all = 0;
      for (let x = 2; x < this.WW; x += this.H.HW) { const h = this.H.hexAt(x, y); if (h < 0) continue; all++; if (this.terr[h] === 1) n++ }
      xs.push({ x: +(all ? this.WW * n / all : this.WW / 2).toFixed(1), y });
    }
    this.frontY = xs;
  }

  /* ---------- точки, фронт, исход ---------- */
  heldWeight(side, cityMul) { return this.pts.reduce((s, p) => s + (p.owner === side ? p.w * (cityMul && p.city ? 1.5 : 1) : 0), 0) }
  forceValue(side) { return Math.round(this.units.filter(u => u.side === side && u.str > 0).reduce((s, u) => s + UT[u.k].price * u.str / MAX_STR, 0)) }
  frontXAt(y) { const f = this.frontY, i = clamp(Math.round(y / 6), 0, f.length - 1); return f[i] ? f[i].x : this.WW / 2 }
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
/* сохранение партии и загрузка из снимка (с проверкой всего, что пришло) — game/save.js */
Game.prototype.saveState = require('./save').saveState;
Game.fromState = st => require('./save').fromState(st);
module.exports = { Game, oppOf, AGGR };
