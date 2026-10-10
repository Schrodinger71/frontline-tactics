'use strict';
/* ============================================================
   СОХРАНЕНИЕ ПАРТИИ
   ------------------------------------------------------------
   saveState()  — снимок всей партии (без тумана войны): части,
                  территория, снабжение, экономика мест, погода,
                  статистика, состояние сценария.
   Game.fromState(st) — партия из снимка.

   Снимок приходит от клиента, поэтому ему не верим: партия строится
   заново обычным конструктором (карта, сетка, места — из белых
   списков), а поверх кладётся только то, что прошло проверку: типы
   частей и специалистов — из таблиц, клетки — в пределах карты, числа
   — конечные и зажатые в свои пределы, строки — короткие и чистые,
   ключи — свои. Чего нет или что не так — берётся по умолчанию.
   Ломаный снимок даёт ошибку загрузки, а не падение сервера.

   На провод снимок идёт сжатым (deflate) в base64: см. pack/unpack.
   ============================================================ */
const zlib = require('zlib');
const W = require('../shared/world');
const Hex = require('../shared/hex');
const { MAPS } = require('../shared/maps');
const { wxById, WEATHER } = require('../shared/weather');
const { N, S, UT, MAX_STR, TRAITS, MAX_SEATS } = W;

const FMT = 1;
const SIDES = [N, S];
const own = (o, k) => o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const num = (v, lo, hi, def) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const int = (v, lo, hi, def) => { const n = num(v, lo, hi, null); return n === null ? def : Math.round(n) };
const bool = v => v === true || v === 1;
/** короткая строка без разметки и управляющих символов */
const str = (v, max, def) => {
  if (typeof v !== 'string') return def;
  const s = v.replace(/[^\p{L}\p{N} .,:;!?«»()'"№+\-–—_/]/gu, '').slice(0, max);
  return s || def;
};
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/* ---------- запись ---------- */
const UNIT_NUM = ['id', 'hex', 'str', 'org', 'xp', 'ent', 'mp', 'sp', 'fu', 'su', 'reload', 'mines', 'revealed', 'cut', 'sv', 'hb', 'startHex'];
const UNIT_BOOL = ['acted', 'moved', 'sup', 'supplied', 'pre', 'militia', 'raid', 'hold', 'march', 'exploit', 'amb', 'ambUsed', 'support', 'fired', 'hitThisTurn', 'dry', 'dryF'];

function saveState() {
  const g = this;
  const per = f => Object.fromEntries(g.seats.map(st => [st.id, f(st.id)]));
  const sideStr = a => String.fromCharCode(...a.map(v => 48 + v));
  return {
    fmt: FMT, v: W.GAME_VERSION, at: Date.now(),
    mode: g.mode, map: g.mapId, role: g.role,
    seats: g.seats.map(st => ({ id: st.id, side: st.side, n: st.n, bot: !!g.bots[st.id] })),
    turn: g.turn, active: g.active, phase: g.phase, first: g.first || null, over: g.over, score: g.score, limit: g.limit,
    wxLeft: g.wxLeft, weather: g.weather.id, idc: g.idc, cs: g._cs,
    units: g.units.filter(u => u.str > 0).map(u => {
      const o = { k: u.k, side: u.side, seat: u.seat, cs: u.cs, trait: u.trait, att: u.att || null };
      for (const f of UNIT_NUM) if (typeof u[f] === 'number') o[f] = u[f];
      for (const f of UNIT_BOOL) if (u[f]) o[f] = 1;
      if (u.sited === false) o.sited = 0;
      return o;
    }),
    pts: g.pts.map(p => ({ id: p.id, owner: p.owner || null, home: p.home || null })),
    br: [...g.br.entries()], forts: [...g.forts.entries()], obst: [...g.obst.entries()], smoke: [...g.smoke.entries()],
    mines: [...g.mines.entries()].map(([h, m]) => [h, m.side, m.str, m.known && m.known.n ? 1 : 0, m.known && m.known.s ? 1 : 0]),
    militiaUsed: [...g.militiaUsed], looted: [...g.looted],
    terr: sideStr(g.terr),
    sv: { n: sideStr(g.sv.n), s: sideStr(g.sv.s) }, svNet: { n: sideStr(g.svNet.n), s: sideStr(g.svNet.s) },
    recon: { n: [...g.recon.n], s: [...g.recon.s] },
    mem: { n: [...g.mem.n.entries()], s: [...g.mem.s.entries()] },
    commanders: { n: { name: g.commanders.n.name, trait: g.commanders.n.trait }, s: { name: g.commanders.s.name, trait: g.commanders.s.trait } },
    ready: per(id => !!g.ready[id]), done: per(id => !!g.done[id]),
    budget: per(id => g.budget[id]), income: per(id => g.income[id] || 0), cp: per(id => g.cp[id] || 0),
    air: per(id => g.air[id] || { strike: 0, recon: 0 }), airLost: per(id => g.airLost[id] || 0),
    sideIncome: g.sideIncome || {}, barrage: g.barrage, counter: g.counter,
    stats: g.stats, history: g.history,
    raidV: g.raidV || 0, reinfDone: g.reinfDone ? [...g.reinfDone] : []
  };
}

/* ---------- чтение ---------- */
function fromState(raw) {
  const { Game } = require('./engine');
  const { SCEN } = require('./scenarios');
  if (!raw || typeof raw !== 'object' || raw.fmt !== FMT) throw new Error('не тот формат сохранения');
  const mode = typeof raw.mode === 'string' && (['defense', 'attack', 'both'].includes(raw.mode) || own(SCEN, raw.mode)) ? raw.mode : null;
  if (!mode) throw new Error('неизвестный режим');
  const map = typeof raw.map === 'string' && own(MAPS, raw.map) ? raw.map : null;
  if (!map && !own(SCEN, mode)) throw new Error('неизвестная карта');
  /* места: по стороне от 1 до MAX_SEATS, имена мест — n, n2, n3 — как у движка */
  const seatsIn = arr(raw.seats, MAX_SEATS * 2);
  const teams = {};
  for (const sd of SIDES) {
    const list = seatsIn.filter(x => x && x.side === sd).slice(0, MAX_SEATS);
    teams[sd] = (list.length ? list : [{}]).map(x => ({ bot: bool(x && x.bot) }));
  }
  const role0 = raw.role && typeof raw.role === 'object' ? raw.role : {};
  /* создатель для ролей «наступление/оборона»: тот, у кого роль задана */
  const creator = role0.n === 'attacker' && mode === 'attack' || role0.n === 'defender' && mode === 'defense' ? N : role0.s === 'attacker' && mode === 'attack' || role0.s === 'defender' && mode === 'defense' ? S : N;
  const g = new Game(mode, creator, undefined, map || undefined, { teams });
  g.events = [];
  const H = g.H, NH = H.NH;
  const hexOk = h => Number.isInteger(h) && h >= 0 && h < NH;
  const seatIds = new Set(g.seats.map(st => st.id));
  for (const sd of SIDES) if (['attacker', 'defender', 'both'].includes(role0[sd])) g.role[sd] = role0[sd];

  /* ход, фаза, погода */
  g.phase = raw.phase === 'battle' ? 'battle' : 'deploy';
  g.turn = int(raw.turn, 0, 400, g.turn);
  g.limit = int(raw.limit, 1, 400, g.limit);
  g.active = SIDES.includes(raw.active) ? raw.active : N;
  g.first = SIDES.includes(raw.first) ? raw.first : null;
  g.score = num(raw.score, -100, 100, 0);
  g.wxLeft = int(raw.wxLeft, 1, 10, 3);
  if (typeof raw.weather === 'string' && WEATHER.some(w => w.id === raw.weather)) g.weather = wxById(raw.weather);
  g.over = raw.over && typeof raw.over === 'object' ? { w: SIDES.includes(raw.over.w) ? raw.over.w : null, t: str(raw.over.t, 200, 'Операция окончена.') } : null;
  g.commanders = {};
  for (const sd of SIDES) {
    const c = raw.commanders && raw.commanders[sd] || {};
    const trait = TRAITS.includes(c.trait) ? c.trait : TRAITS[0];
    const { AGGR } = require('./engine');
    g.commanders[sd] = { trait, name: str(c.name, 40, 'Командир'), aggr: AGGR[trait] };
  }

  /* части */
  const units = [];
  const ids = new Set();
  for (const x of arr(raw.units, 200)) {
    if (!x || typeof x !== 'object' || !own(UT, x.k) || !SIDES.includes(x.side)) continue;
    /* номер и клетку не зажимаем, а проверяем: чужая клетка — не наша часть */
    const id = Number.isInteger(x.id) && x.id >= 1 && x.id < 1e7 ? x.id : null, hex = hexOk(x.hex) ? x.hex : null;
    if (id === null || ids.has(id) || hex === null || g.map.hexes[hex].t === 'lake') continue;
    if (units.some(u => u.hex === hex)) continue;
    const T = UT[x.k];
    ids.add(id);
    const seat = typeof x.seat === 'string' && seatIds.has(x.seat) && g.sideOf(x.seat) === x.side ? x.seat : x.side;
    const u = {
      id, k: x.k, side: x.side, hex, seat,
      str: int(x.str, 1, MAX_STR, MAX_STR), org: num(x.org, 0, 100, 100), xp: num(x.xp, 0, 1, .15), ent: int(x.ent, 0, 3, 0),
      mp: num(x.mp, 0, 20, 0), sp: int(x.sp, 0, W.SUPPLY.max, W.SUPPLY.max), fu: int(x.fu, 0, W.SUPPLY.max, W.SUPPLY.max),
      su: int(x.su, 0, MAX_STR, 0), reload: int(x.reload, 0, 5, 0), mines: int(x.mines, 0, 10, T.eng ? 2 : 0),
      revealed: int(x.revealed, -1, 1000, -1), cut: int(x.cut, 0, 400, 0), sv: int(x.sv, 0, W.SUPPLY.top, 0), hb: int(x.hb, 0, 7, 0),
      startHex: hexOk(x.startHex) ? x.startHex : hex,
      cs: str(x.cs, 24, 'Часть-' + id), trait: TRAITS.includes(x.trait) ? x.trait : TRAITS[0],
      att: typeof x.att === 'string' && own(W.SPECS, x.att) && W.SPECS[x.att].for(T) ? x.att : null
    };
    for (const f of UNIT_BOOL) u[f] = bool(x[f]);
    if (T.fob) u.sited = x.sited === 0 || x.sited === false ? false : true;
    if (u.su > u.str) u.su = u.str;
    units.push(u);
  }
  if (!units.length) throw new Error('в сохранении нет частей');
  g.units = units;
  g.idc = Math.max(int(raw.idc, 1, 1e7, 1), ...units.map(u => u.id + 1));
  g._cs = { n: int(raw.cs && raw.cs.n, 0, 1e5, 0), s: int(raw.cs && raw.cs.s, 0, 1e5, 0) };

  /* точки */
  const ptIn = new Map(arr(raw.pts, 100).filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));
  for (const p of g.pts) {
    const q = ptIn.get(p.id);
    if (!q) continue;
    p.owner = SIDES.includes(q.owner) ? q.owner : null;
    p.home = SIDES.includes(q.home) ? q.home : null;
  }

  /* мосты, укрепления, заграждения, дым, мины */
  const bridges = new Set(Hex.bridgeList(g.mapId).map(b => b.key));
  g.br = new Map();
  for (const e of arr(raw.br, 400)) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !/^\d+-\d+$/.test(e[0])) continue;
    const [a, b] = e[0].split('-').map(Number);
    if (!hexOk(a) || !hexOk(b) || H.dirTo(a, b) < 0 || Hex.edgeKey(a, b) !== e[0]) continue;
    if (e[1] === 'down' && bridges.has(e[0])) g.br.set(e[0], 'down');
    else if (e[1] === 'pontoon') g.br.set(e[0], 'pontoon');
  }
  g.forts = new Map(arr(raw.forts, NH).filter(e => Array.isArray(e) && hexOk(e[0])).map(e => [e[0], int(e[1], 1, 2, 1)]));
  g.obst = new Map(arr(raw.obst, NH).filter(e => Array.isArray(e) && hexOk(e[0]) && SIDES.includes(e[1])).map(e => [e[0], e[1]]));
  g.smoke = new Map(arr(raw.smoke, NH).filter(e => Array.isArray(e) && hexOk(e[0]) && SIDES.includes(e[1])).map(e => [e[0], e[1]]));
  g.mines = new Map();
  for (const e of arr(raw.mines, NH)) {
    if (!Array.isArray(e) || !hexOk(e[0]) || !SIDES.includes(e[1])) continue;
    g.mines.set(e[0], { side: e[1], str: num(e[2], .01, 1, 1), known: { n: bool(e[3]) || e[1] === N, s: bool(e[4]) || e[1] === S } });
  }
  const ptIds = new Set(g.pts.map(p => p.id));
  g.militiaUsed = new Set(arr(raw.militiaUsed, 100).filter(id => ptIds.has(id)));
  g.looted = new Set(arr(raw.looted, 100).filter(id => ptIds.has(id)));

  /* территория и снабжение — строки по символу на клетку */
  const codes = (s, max) => {
    if (typeof s !== 'string' || s.length !== NH) return null;
    const a = new Uint8Array(NH);
    for (let i = 0; i < NH; i++) { const v = s.charCodeAt(i) - 48; if (!(v >= 0 && v <= max)) return null; a[i] = v }
    return a;
  };
  const terr = codes(raw.terr, 2);
  if (terr) g.terr = terr; else g.initTerritory();
  for (const sd of SIDES) {
    const sv = codes(raw.sv && raw.sv[sd], W.SUPPLY.top), net = codes(raw.svNet && raw.svNet[sd], 1);
    if (sv) g.sv[sd] = sv;
    if (net) g.svNet[sd] = net;
    g.recon[sd] = new Set(arr(raw.recon && raw.recon[sd], NH).filter(hexOk));
    g.mem[sd] = new Map();
    for (const e of arr(raw.mem && raw.mem[sd], 200)) {
      if (!Array.isArray(e) || !ids.has(e[0]) || !e[1] || !own(UT, e[1].k) || !hexOk(e[1].hex)) continue;
      g.mem[sd].set(e[0], { hex: e[1].hex, k: e[1].k, turn: int(e[1].turn, 0, 400, g.turn), str: int(e[1].str, 1, MAX_STR, MAX_STR) });
    }
    g.barrage[sd] = bool(raw.barrage && raw.barrage[sd]);
    g.counter[sd] = bool(raw.counter && raw.counter[sd]);
  }
  g.sideIncome = { n: int(raw.sideIncome && raw.sideIncome.n, 0, 1e5, 0), s: int(raw.sideIncome && raw.sideIncome.s, 0, 1e5, 0) };

  /* экономика мест */
  for (const st of g.seats) {
    const id = st.id, pick = (o, f) => (o && typeof o === 'object' && own(o, id) ? f(o[id]) : undefined);
    const b = pick(raw.budget, v => num(v, 0, 1e6, null)); if (typeof b === 'number') g.budget[id] = b;
    const inc = pick(raw.income, v => int(v, 0, 1e5, 0)); if (inc !== undefined) g.income[id] = inc;
    const cp = pick(raw.cp, v => int(v, 0, W.CP.max, W.CP.start)); if (cp !== undefined) g.cp[id] = cp;
    const air = pick(raw.air, v => v && typeof v === 'object' ? { strike: int(v.strike, 0, 6, 0), recon: int(v.recon, 0, 6, 0) } : null); if (air) g.air[id] = air;
    g.airLost[id] = pick(raw.airLost, v => int(v, 0, 6, 0)) || 0;
    g.ready[id] = !!pick(raw.ready, bool);
    g.done[id] = !!pick(raw.done, bool);
  }
  if (g.phase === 'battle') for (const st of g.seats) g.ready[st.id] = true;

  /* статистика и график */
  const stat = o => {
    const e = g.newStats();
    if (!o || typeof o !== 'object') return e;
    for (const f of ['spent', 'lostV', 'killedV', 'caps', 'routs', 'prisoners']) e[f] = int(o[f], -1e6, 1e7, 0);
    for (const f of ['lost', 'killed']) if (o[f] && typeof o[f] === 'object') for (const k of Object.keys(UT)) if (own(o[f], k)) e[f][k] = int(o[f][k], 0, 1e4, 0);
    return e;
  };
  g.stats = { n: stat(raw.stats && raw.stats.n), s: stat(raw.stats && raw.stats.s) };
  g.history = arr(raw.history, 500).filter(h => h && typeof h === 'object')
    .map(h => ({ turn: int(h.turn, 0, 400, 0), s: num(h.s, -100, 100, 0), n: int(h.n, 0, 1e6, 0), e: int(h.e, 0, 1e6, 0) }));

  /* сценарий */
  if (g.scen) {
    g.raidV = num(raw.raidV, 0, 1e6, g.raidV || 0);
    g.reinfDone = new Set(arr(raw.reinfDone, 50).filter(i => Number.isInteger(i) && i >= 0 && i < (g.scen.reinf || []).length));
  }

  /* производное: фронт, обзор, источники снабжения */
  g.rebuildFront();
  for (const sd of SIDES) g.svSrc[sd] = g.supplySources(sd);
  g.updateVision(N); g.updateVision(S);
  g.events = [];
  g.log('*', `Партия загружена: ход ${g.turn + 1}, ${W.turnClock(g.turn)}.`, 'hq');
  return g;
}

/* ---------- упаковка для провода ---------- */
const MAX_PACKED = 400000, MAX_JSON = 4 << 20;
function pack(state) { return zlib.deflateRawSync(Buffer.from(JSON.stringify(state)), { level: 9 }).toString('base64') }
function unpack(s) {
  if (typeof s !== 'string' || !s.length || s.length > MAX_PACKED || !/^[A-Za-z0-9+/=]+$/.test(s)) throw new Error('повреждённое сохранение');
  const buf = zlib.inflateRawSync(Buffer.from(s, 'base64'), { maxOutputLength: MAX_JSON });
  return JSON.parse(buf.toString('utf8'));
}

module.exports = { saveState, fromState, pack, unpack, MAX_PACKED };
