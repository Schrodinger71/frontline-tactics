'use strict';
/* ============================================================
   ПРОГОН ПРАВИЛ БЕЗ СЕТИ: партии ботов за обе стороны до итога,
   сценарии, мусорные действия, туман войны в снимках.
   Запуск: node test/headless.js [партий на режим]
   ============================================================ */
const assert = require('assert');
const { Game } = require('../game/engine');
const W = require('../shared/world');
const { N, S } = W;
assert.strictEqual(W.GAME_VERSION, require('../package.json').version, 'GAME_VERSION не совпадает с package.json');

function checkView(g, side) {
  const v = g.snapshotFor(side);
  JSON.stringify(v);
  for (const u of v.units) if (u.side !== side) {
    const real = g.byId(u.id);
    assert(real && g.seen(side, real), 'в снимок попала невидимая чужая часть');
    assert(u.org === undefined && u.mp === undefined, 'снимок раскрывает чужие подробности');
  }
  return v;
}
function junk(g) {
  for (const side of [N, S]) {
    for (const a of [null, {}, { t: 'zzz' }, { t: 'move', id: 1e9, to: 3 }, { t: 'move', id: 'x' }, { t: 'attack', id: 1, target: 'y' }, { t: 'buy', k: 'zzz', hex: 1 }, { t: 'buy', k: 'tnk', hex: -5 }, { t: 'air', kind: 'strike', hex: 1e9 }])
      assert.strictEqual(g.act(side, a).ok, false, JSON.stringify(a));
  }
  const foe = g.units.find(u => u.side !== g.active);
  if (foe) assert.strictEqual(g.act(g.active, { t: 'move', id: foe.id, to: foe.hex + 1 }).ok, false, 'чужой частью ходить нельзя');
}
function play(mode, seed, map) {
  const g = new Game(mode, N, seed, map);
  g.bots = { n: true, s: true };
  const t0 = Date.now();
  g.tryStart();
  assert.strictEqual(g.phase, 'battle');
  let guard = 0;
  while (!g.over && guard++ < 400) {
    if (guard === 3) junk(g);
    g.botTurn(g.active);
    g.drainEvents();
    if (guard % 4 === 0) { checkView(g, N); checkView(g, S); JSON.stringify(g.snapshotFor('spec')) }
  }
  assert(g.over, 'партия не закончилась');
  for (const u of g.units) for (const f of ['hex', 'str', 'org', 'mp']) assert(Number.isFinite(u[f]), `${u.k}.${f}`);
  return { mode, map: map || g.mapId, seed, ms: Date.now() - t0, turns: g.turn, w: g.over.w || '—', t: g.over.t,
    score: Math.round(g.score), lost: g.stats.n.lostV + '/' + g.stats.s.lostV, caps: g.stats.n.caps + '/' + g.stats.s.caps,
    lostN: g.stats.n.lostV || 0, lostS: g.stats.s.lostV || 0, capsN: g.stats.n.caps || 0, capsS: g.stats.s.caps || 0,
    att: g.role.n === 'attacker' ? N : g.role.s === 'attacker' ? S : null,
    /* срок движок считает как start + turns (game/scenarios.js), поэтому берём g.limit;
       игроку же сценарий обещает turns ходов от своего начала — это elapsed/span */
    limit: g.limit, span: g.scen ? g.scen.turns : g.limit, start: g.scen ? g.scen.start || 0 : 0,
    elapsed: g.turn - (g.scen ? g.scen.start || 0 : 0), scen: !!g.scen,
    sweep: !!map,
    timeout: g.turn >= g.limit };
}
const SCENS = ['bridge', 'breakthrough', 'night'];
const FREE = ['both', 'attack', 'defense'];
const per = +process.argv[2] || 2;
/* партий на сценарий кампании: по умолчанию столько же, сколько на режим */
const perScen = +(process.env.FT_SCEN_GAMES || per);
let seed = 1;
const games = [];
const run = (mode, map) => { const r = play(mode, seed++, map); games.push(r); return r };

for (const mode of FREE.concat(SCENS)) for (let i = 0; i < (SCENS.includes(mode) ? perScen : per); i++) {
  const r = run(mode);
  console.log(`${mode.padEnd(12)} #${r.seed}  ходов ${String(r.elapsed).padStart(2)}/${r.span}  победа ${r.w}  перевес ${String(r.score).padStart(4)}  точки ${r.caps}  потери ${r.lost}  ${r.ms} мс — ${r.t}`);
}
/* все карты: встречный бой ботов */
for (const map of require('../shared/maps').MAP_ORDER) {
  const r = run(map === 'fortline' ? 'attack' : 'both', map);
  console.log(`карта ${map.padEnd(10)} ходов ${String(r.turns).padStart(2)}  победа ${r.w}  перевес ${String(r.score).padStart(4)}  точки ${r.caps}  потери ${r.lost}  ${r.ms} мс`);
}
/* механики 1.2: высадка у точки, котёл, приказы */
{
  const Hex = require('../shared/hex'), W = require('../shared/world');
  const g = new Game('both', N, 11, 'steppe');
  g.ready.n = g.ready.s = true; g.tryStart();
  const side = g.active, p = g.pts.find(q => q.owner === side && q.city);
  const ring = Hex.neighbors(p.hex).find(h => !g.spawnErr(side, h, 'inf'));
  assert(ring !== undefined && g.act(side, { t: 'buy', k: 'inf', hex: ring }).ok, 'высадка на соседней клетке');
  const far = Hex.within(p.hex, 3).find(h => Hex.hexDist(h, p.hex) === 3 && !g.unitAt(h));
  assert(!g.act(side, { t: 'buy', k: 'inf', hex: far }).ok, 'дальше клетки от точки — нельзя');
  assert(g.act(side, { t: 'order', k: 'hold', id: g.unitAt(ring).id }).ok && g.unitAt(ring).hold, 'приказ «стоять насмерть»');
  assert(!g.act(side, { t: 'order', k: 'reserve', hex: ring }).ok, 'резерв — не хватает очков');
  /* котёл: отрезанная часть за 3 хода теряет запасы и атаку */
  const en = side === N ? S : N;
  const lone = g.spawn('tnk', side, Hex.hexAt(150, 120));
  for (const h of Hex.neighbors(lone.hex)) if (!g.unitAt(h) && g.passable('inf', h)) g.spawn('inf', en, h);
  for (let i = 0; i < 3; i++) { g.active = side; g.endTurn(); g.drainEvents() }
  assert(!lone.supplied && lone.sp === 0, 'в котле запас тает до нуля за 3 хода: ' + lone.sp);
  const foe = g.units.find(u => u.side === en && u.str > 0 && Hex.hexDist(u.hex, lone.hex) === 1);
  g.active = side;
  assert(!g.act(side, { t: 'attack', id: lone.id, target: foe.id }).ok, 'без запасов не атакует');
  console.log('механики 1.2: ok');
}
/* механики 2.0: контрбатарея, ремонт моста, рельеф, взаимодействие, контрудар, жребий первого хода */
{
  const Hex = require('../shared/hex'), Rules = require('../shared/rules');
  const g = new Game('both', N, 21, 'valley');
  g.ready.n = g.ready.s = true; g.tryStart();
  assert([N, S].includes(g.first) && g.active === g.first, 'первый ход — по жребию');
  const side = g.active, en = side === N ? S : N;
  /* контрбатарея */
  const a = g.spawn('art', side, Hex.hexAt(120, 300)), b = g.spawn('art', en, Hex.hexAt(140, 300));
  const t = g.spawn('inf', en, Hex.neighbors(a.hex).find(h => !g.unitAt(h) && g.passable('inf', h)));
  b.support = true; a.acted = false; a.reload = 0; a.sp = 3; t.revealed = g.turn; g.updateVision(side);
  g.drainEvents();
  assert(g.act(side, { t: 'bombard', id: a.id, hex: t.hex }).ok, 'огонь артиллерии');
  assert(g.drainEvents().some(e => e.e === 'counter') && !b.support, 'контрбатарейный ответ');
  /* мост: взорвать и восстановить */
  const br = Hex.bridgeList('valley').find(x => !g.unitAt(x.a) && !g.unitAt(x.b) && !Hex.neighbors(x.a).concat(Hex.neighbors(x.b)).some(h => g.unitAt(h)));
  const e1 = g.spawn('eng', side, br.a);
  assert(g.act(side, { t: 'eng', id: e1.id, task: 'blow', hex: br.b }).ok && g.br.get(br.key) === 'down', 'мост взорван');
  e1.acted = false;
  assert(g.act(side, { t: 'eng', id: e1.id, task: 'repair', hex: br.b }).ok && !g.br.has(br.key), 'мост восстановлен');
  /* рельеф и взаимодействие видны в расчёте */
  const ctx = g.ctxFor(side, true), m = g.map;
  let pair = null;
  for (let h = 0; h < Hex.NH && !pair; h++) for (const n of Hex.neighbors(h)) if (m.hexes[n].h - m.hexes[h].h > 70 && m.hexes[n].t !== 'lake' && m.hexes[h].t !== 'lake') { pair = [h, n]; break }
  const att = { id: -1, k: 'tnk', side, hex: pair[0], str: 10, org: 100, xp: .2, sp: 3 }, def = { id: -2, k: 'inf', side: en, hex: pair[1], str: 10, org: 100, xp: .2, sp: 3, hb: Rules.ARMBIT.soft };
  const o = Rules.odds(ctx, att, def);
  assert(o.mods.some(x => x.t === 'атака в гору') && o.mods.some(x => x.t === 'взаимодействие'), 'рельеф и взаимодействие в расчёте');
  /* контрудар: потерянная исходная точка */
  const home = g.pts.find(p => p.home === side);
  home.owner = en; g.cp[side] = 6;
  assert(g.act(side, { t: 'order', k: 'counter' }).ok && g.ctxFor(side, true).counter.has(home.hex), 'приказ «Контрудар»');
  console.log('механики 2.0: ok');
}
/* взорванный мост не открывает бесплатный переход: выбив противника за рекой,
   занять его клетку можно только «с места» — как брод при обычном движении.
   Колёсным брод закрыт вовсе. Регрессия: раньше пешие и гусеничные переходили
   даже после марша, обходя правило о полном запасе хода. */
{
  const Hex = require('../shared/hex'), Rules = require('../shared/rules');
  const ford = (kind, fresh) => {
    const g = new Game('both', N, 31, 'valley');
    g.ready.n = g.ready.s = true; g.tryStart();
    const side = g.active, en = side === N ? S : N;
    const br = Hex.bridgeList('valley').find(x => !g.unitAt(x.a) && !g.unitAt(x.b));
    g.br.set(br.key, 'down');
    const u = g.spawn(kind, side, br.a), e = g.spawn('inf', en, br.b);
    assert(!Rules.crossable(Rules.edgeOf(g.ctxFor(side, true), u.hex, Hex.dirTo(u.hex, e.hex))),
      'грань у снесённого моста должна быть непроходимой');
    e.str = 10; e.org = 1;                    /* выживет, но отойдёт: org < 15 */
    u.str = 10; u.org = 100; u.sp = 3; u.acted = false;
    u.moved = !fresh; u.mp = fresh ? W.UT[kind].mp : 1;
    g.active = side; g.updateVision(side);
    assert(g.act(side, { t: 'attack', id: u.id, target: e.id }).ok, 'атака через реку возможна');
    return u.hex === br.b;
  };
  assert.strictEqual(ford('mot', true), false, 'колёсные не переходят снесённый мост');
  assert.strictEqual(ford('inf', false), false, 'пешие после марша брод не проходят');
  assert.strictEqual(ford('tnk', false), false, 'гусеничные после марша брод не проходят');
  assert.strictEqual(ford('inf', true), true, 'пешие с места брод проходят');
  assert.strictEqual(ford('tnk', true), true, 'гусеничные с места брод проходят');
  console.log('переход через взорванный мост: ok');
}
/* ============================================================
   ОТЧЁТ ПО БАЛАНСУ: сводка по всем сыгранным партиям.
   Цифры — от ботов, поэтому это не истина, а индикатор: резкий
   сдвиг доли побед или длины партий виден сразу, в том числе в CI.
   ============================================================ */
const MODE_RU = { both: 'встречный бой', attack: 'наступление', defense: 'оборона' };
const SCEN_RU = { bridge: 'Мост через Тихую', breakthrough: 'Прорыв к Красногору', night: 'Ночной рейд' };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (k, n) => n ? Math.round(k * 100 / n) + '%' : '—';
const f1 = x => x.toFixed(1);

function row(cells, w) { return cells.map((c, i) => i ? String(c).padStart(w[i]) : String(c).padEnd(w[i])).join('  ') }
function table(head, rows, w) {
  console.log(row(head, w));
  console.log(w.map(n => '─'.repeat(n)).join('  '));
  for (const r of rows) console.log(row(r, w));
}

console.log('\n════════ БАЛАНС ════════');

/* --- свободные режимы --- */
{
  const w = [14, 6, 5, 6, 5, 9, 7, 8, 13];
  const rows = FREE.map(m => {
    const list = games.filter(g => g.mode === m && !g.scen && !g.sweep);
    const n = list.length;
    const wn = list.filter(g => g.w === N).length, ws = list.filter(g => g.w === S).length;
    const dr = list.filter(g => g.w === '—').length;
    const attWins = list.filter(g => g.att && g.w === g.att).length;
    const attGames = list.filter(g => g.att).length;
    return [MODE_RU[m], n, wn, ws, dr, attGames ? pct(attWins, attGames) : '—',
      f1(avg(list.map(g => g.turns))), pct(list.filter(g => g.timeout).length, n),
      Math.round(avg(list.map(g => g.lostN))) + '/' + Math.round(avg(list.map(g => g.lostS)))];
  });
  table(['режим', 'партий', 'Зап', 'Вост', 'ничьи', 'атакующий', 'ходов', 'до срока', 'потери З/В'], rows, w);
}

/* --- кампания --- */
{
  console.log('');
  const w = [22, 6, 7, 8, 9, 13];
  const rows = SCENS.map(id => {
    const list = games.filter(g => g.mode === id);
    const n = list.length;
    const wins = list.filter(g => g.w === N).length;
    const solved = list.filter(g => g.w === N);
    return [SCEN_RU[id], n, pct(wins, n), (list[0] || {}).span || '—',
      solved.length ? f1(avg(solved.map(g => g.elapsed))) : '—',
      pct(list.filter(g => g.timeout).length, n)];
  });
  table(['сценарий кампании', 'партий', 'взят', 'срок', 'ходов*', 'до срока'], rows, w);
  console.log('* ходов — в среднем по выигранным партиям: сколько реально нужно, чтобы уложиться в срок.');
}

/* --- карты --- */
{
  console.log('');
  const list = games.filter(g => g.sweep);
  const byMap = [...new Set(list.map(g => g.map))];
  const w = [12, 6, 5, 6, 7, 13];
  const rows = byMap.map(m => {
    const gs = list.filter(g => g.map === m), n = gs.length;
    return [m, n, gs.filter(g => g.w === N).length, gs.filter(g => g.w === S).length,
      f1(avg(gs.map(g => g.turns))), Math.round(avg(gs.map(g => g.lostN))) + '/' + Math.round(avg(gs.map(g => g.lostS)))];
  });
  table(['карта', 'партий', 'Зап', 'Вост', 'ходов', 'потери З/В'], rows, w);
}

/* --- общий итог и предупреждения --- */
{
  console.log('');
  const free = games.filter(g => !g.scen && !g.sweep);
  const wn = free.filter(g => g.w === N).length, ws = free.filter(g => g.w === S).length, dr = free.filter(g => g.w === '—').length;
  console.log(`всего свободных партий ${free.length}: Запад ${wn}, Восток ${ws}, ничьи ${dr} · средняя длина ${f1(avg(free.map(g => g.turns)))} ходов`);
  const notes = [];
  /* перекос сторон во встречном бою — там силы равны, значит должно быть близко к 50/50 */
  const both = games.filter(g => g.mode === 'both');
  if (both.length >= 6) {
    const bn = both.filter(g => g.w === N).length, bs = both.filter(g => g.w === S).length;
    if (Math.max(bn, bs) / both.length > .8) notes.push(`во встречном бою перекос ${bn}:${bs} — силы равны, ожидается примерно поровну`);
  }
  /* сценарий, который боты не берут ни разу, скорее всего непроходим по сроку */
  for (const id of SCENS) {
    const list = games.filter(g => g.mode === id);
    if (list.length >= 2 && !list.some(g => g.w === N)) notes.push(`«${SCEN_RU[id]}» не взят ни в одной из ${list.length} партий — срок ${list[0].span} ходов может быть слишком жёстким`);
  }
  if (notes.length) { console.log(''); for (const t of notes) console.log('  ⚠ ' + t) }
  else console.log('резких перекосов не видно');
}
console.log('');
console.log('headless: ok');
