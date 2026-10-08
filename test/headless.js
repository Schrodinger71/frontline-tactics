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
  return { mode, seed, ms: Date.now() - t0, turns: g.turn, w: g.over.w || '—', t: g.over.t, score: Math.round(g.score), lost: g.stats.n.lostV + '/' + g.stats.s.lostV, caps: g.stats.n.caps + '/' + g.stats.s.caps };
}
const per = +process.argv[2] || 2;
let seed = 1;
const wins = { n: 0, s: 0, '—': 0 };
for (const mode of ['both', 'attack', 'defense', 'bridge', 'breakthrough', 'night']) for (let i = 0; i < (['bridge', 'breakthrough', 'night'].includes(mode) ? 1 : per); i++) {
  const r = play(mode, seed++);
  if (!['bridge', 'breakthrough', 'night'].includes(mode)) wins[r.w]++;
  console.log(`${mode.padEnd(12)} #${r.seed}  ходов ${String(r.turns).padStart(2)}  победа ${r.w}  перевес ${String(r.score).padStart(4)}  точки ${r.caps}  потери ${r.lost}  ${r.ms} мс — ${r.t}`);
}
/* все карты: встречный бой ботов */
for (const map of require('../shared/maps').MAP_ORDER) {
  const r = play(map === 'fortline' ? 'attack' : 'both', seed++, map);
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
console.log(`итого свободных: Запад ${wins.n}, Восток ${wins.s}, ничьи ${wins['—']}`);
console.log('headless: ok');
