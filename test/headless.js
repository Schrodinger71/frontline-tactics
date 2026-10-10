'use strict';
/* ============================================================
   ПРОГОН ПРАВИЛ БЕЗ СЕТИ: партии ботов за обе стороны до итога,
   сценарии, мусорные действия, туман войны в снимках.
   Запуск: node test/headless.js [партий на режим]
   ============================================================ */
const assert = require('assert');
const { Game } = require('../game/engine');
const Rules = require('../shared/rules');
const W = require('../shared/world');
const { N, S } = W;
assert.strictEqual(W.GAME_VERSION, require('../package.json').version, 'GAME_VERSION не совпадает с package.json');

function checkView(g, side) {
  const v = g.snapshotFor(side);
  JSON.stringify(v);
  for (const u of v.units) if (u.side !== side) {
    const real = g.byId(u.id);
    assert(real && g.seen(side, real), 'в снимок попала невидимая чужая часть');
    /* мораль чужой части известна только после разведки боем */
    assert((u.org === undefined || g.hasIntel(side, real)) && u.mp === undefined && u.prep === undefined, 'снимок раскрывает чужие подробности');
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
const SCENS = ['tutor', 'bridge', 'breakthrough', 'night'];
const FREE = ['both', 'attack', 'defense'];
const per = +process.argv[2] || 2;
/* партий на сценарий кампании: второй аргумент, иначе столько же, сколько на режим.
   Запуск: node test/headless.js [на режим] [на сценарий] */
const perScen = +process.argv[3] || +process.env.FT_SCEN_GAMES || per;
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
/* механики 3.2: территория, снабжение по клеткам, перезарядка РСЗО */
{
  const Hex = require('../shared/hex');
  const g = new Game('both', N, 5, 'valley');
  g.ready.n = g.ready.s = true; g.tryStart();
  const H = g.H, own = s => s === N ? 1 : 2;
  /* территория: у каждой стороны своя земля, точки — на земле владельца */
  assert(g.terr.every(v => v === 1 || v === 2), 'вся карта поделена');
  for (const p of g.pts) if (p.owner) assert.strictEqual(g.terr[p.hex], own(p.owner), 'точка ' + p.n + ' на своей земле');
  /* снабжение по дорогам: тыловые станции — 10, сеть идёт по дорогам почти без
     потерь, в поле с каждой клеткой −2 и больше, на чужой земле — 0 */
  const rearN = g.svSrc.n.filter(x => x.k === 'rear');
  assert(rearN.length && rearN.every(x => g.map.hexes[x.hex].road && g.sv.n[x.hex] === 10), 'тыловые станции на дорогах, 10');
  for (let h = 0; h < H.NH; h++) {
    if (g.terr[h] !== 1) { assert.strictEqual(g.sv.n[h], 0, 'на чужой земле снабжения нет'); continue }
    if (g.svNet.n[h]) assert(g.map.hexes[h].road, 'линия снабжения — только по дорогам');
  }
  /* в поле снабжение падает: клетка рядом с линией и не на ней — меньше её хотя бы на 2 */
  let fieldChecked = 0;
  for (let h = 0; h < H.NH && fieldChecked < 20; h++) {
    if (g.terr[h] !== 1 || g.svNet.n[h] || !g.sv.n[h]) continue;
    const best = Math.max(...H.neighbors(h).filter(n => g.svNet.n[n]).map(n => g.sv.n[n]), 0);
    if (best) { assert(g.sv.n[h] <= best - 2 + .5, `поле у дороги: ${g.sv.n[h]} при ${best} на дороге`); fieldChecked++ }
  }
  assert(fieldChecked > 0, 'нашлись клетки поля у линии снабжения');
  /* далеко от дорог подвоза нет */
  const far = [...Array(H.NH).keys()].find(h => g.terr[h] === 1 && Math.min(...[...Array(H.NH).keys()].filter(n => g.svNet.n[n]).map(n => H.hexDist(n, h))) >= 6);
  if (far !== undefined) assert.strictEqual(g.sv.n[far], 0, 'в 6 клетках от дороги снабжения нет');
  /* проход части забирает клетки и соседей, не прикрытых противником */
  g.active = N;
  const t = g.spawn('tnk', N, g.freeHex(g.WW / 2, 60, 'tnk'), { seat: N });
  const goal = H.within(t.hex, 3).find(h => g.terr[h] === 2 && !g.unitAt(h) && Rules.reachable(g.ctxFor(N, false), t).has(h));
  if (goal !== undefined) {
    const r = g.act(N, { t: 'move', id: t.id, to: goal });
    if (r.ok) assert.strictEqual(g.terr[t.hex], 1, 'клетка, куда вошли, — наша');
  }
  /* РСЗО: после залпа ход на перезарядку (раньше счётчик сгорал в тот же ход) */
  const m = g.spawn('mlrs', N, g.freeHex(g.WW / 2 - 30, 220, 'mlrs'), { seat: N });
  const e = g.spawn('inf', S, g.freeHex(g.map.hexes[m.hex].x + 20, 220, 'inf'));
  e.revealed = g.turn; g.vis.n.add(e.hex);
  assert(g.act(N, { t: 'bombard', id: m.id, hex: e.hex }).ok, 'залп РСЗО');
  g.endTurn(); g.drainEvents(); g.endTurn(); g.drainEvents();
  g.active = N; m.acted = false; e.revealed = g.turn; g.vis.n.add(e.hex);
  assert(!g.act(N, { t: 'bombard', id: m.id, hex: e.hex }).ok, 'на следующий ход РСЗО ещё перезаряжается');
  console.log('механики 3.2: ok');
}
/* обстрел: огонь с места — клетку не занимаем, окоп не теряем, цель не отходит */
{
  const g = new Game('both', N, 11, 'steppe');
  g.ready.n = g.ready.s = true; g.tryStart();
  const side = g.active, en = side === N ? S : N, H = g.H;
  g.updateSupply(side);
  const h0 = [...Array(H.NH).keys()].find(h => g.sv[side][h] >= 7 && !g.unitAt(h) && g.passable('inf', h) && H.neighbors(h).some(n => !g.unitAt(n) && g.passable('inf', n)));
  const a = g.spawn('inf', side, h0), b = g.spawn('inf', en, H.neighbors(h0).find(n => !g.unitAt(n) && g.passable('inf', n)));
  a.ent = 2; g.updateVision(side);
  const ctx = g.ctxFor(side, true), f = Rules.fireOdds(ctx, a, b), o = Rules.odds(ctx, a, b);
  assert(f.sup > f.kill, 'обстрел больше прижимает, чем убивает');
  assert(f.kill + f.sup / 2 < o.expD && f.back < o.expA, 'обстрел слабее штурма и дешевле для стреляющего');
  const ha = a.hex, hb = b.hex;
  assert(g.act(side, { t: 'fire', id: a.id, target: b.id }).ok, 'обстрел соседней цели');
  assert(a.hex === ha && a.ent === 2 && a.acted, 'стреляющий на месте и в окопе');
  assert(b.str <= 0 || b.hex === hb, 'цель под обстрелом не отходит');
  assert(!g.act(side, { t: 'fire', id: a.id, target: b.id }).ok, 'второй раз за ход — нельзя');
  /* уничтоженную огнём цель не преследуем */
  const c = g.spawn('tnk', side, H.neighbors(hb).find(n => n !== ha && !g.unitAt(n) && g.passable('tnk', n)));
  if (b.str > 0) { b.str = 1; b.su = 0; const hc = c.hex; g.updateVision(side);
    for (let i = 0; i < 40 && b.str > 0; i++) { c.acted = false; g.act(side, { t: 'fire', id: c.id, target: b.id }) }
    assert(c.hex === hc, 'после обстрела клетку не занимают'); }
  const art = g.spawn('art', side, H.neighbors(ha).find(n => !g.unitAt(n) && g.passable('art', n)));
  const d = g.spawn('inf', en, H.neighbors(art.hex).find(n => !g.unitAt(n) && g.passable('inf', n))); g.updateVision(side);
  assert(!g.act(side, { t: 'fire', id: art.id, target: d.id }).ok, 'артиллерия обстрелом в упор не бьёт — у неё «Огонь»');
  console.log('обстрел: ok');
}
/* подготовленная атака, арьергард, разведка боем, остатки, полевой склад */
{
  const mk = seed => {
    const g = new Game('both', N, seed, 'steppe');
    g.ready.n = g.ready.s = true; g.tryStart();
    const side = g.active, en = side === N ? S : N, H = g.H;
    g.updateSupply(side); g.updateSupply(en);
    /* свободная клетка на хорошем снабжении, вокруг которой пусто и проходимо */
    const open = h => !g.unitAt(h) && g.passable('tnk', h) && g.map.hexes[h].t === 'open';
    const spot = sd => [...Array(H.NH).keys()].find(h => g.sv[sd][h] >= 7 && open(h) && H.neighbors(h).length === 6 && H.neighbors(h).every(n => open(n) && H.neighbors(n).every(x => !g.unitAt(x))));
    return { g, side, en, H, spot, open };
  };
  /* --- подготовленная атака --- */
  {
    const { g, side, en, H, spot } = mk(21);
    const h0 = spot(side), a = g.spawn('inf', side, h0), b = g.spawn('inf', en, H.neighbors(h0)[0]);
    g.updateVision(side); g.updateVision(en);
    const ctx = () => g.ctxFor(side, true), has = () => Rules.odds(ctx(), a, b).mods.some(m => m.t === 'подготовленная атака');
    assert(!has(), 'только что подошли — атака с ходу');
    g.endTurn(); g.drainEvents(); g.endTurn(); g.drainEvents();
    assert.strictEqual(g.active, side);
    assert(a.prep && has(), 'простояли ход рядом с противником — атака подготовлена');
    assert(!Rules.fireOdds(ctx(), a, b).mods.some(m => m.t === 'подготовленная атака'), 'обстрелу подготовка не нужна');
    a.moved = true;
    assert(!has(), 'сдвинулись — подготовка пропала');
    a.moved = false;
    const s = g.snapshotFor(side).units.find(x => x.id === a.id), e = g.snapshotFor(en).units.find(x => x.id === a.id);
    assert(s.prep === 1 && (!e || e.prep === undefined), 'готовность видна только своим');
  }
  /* --- арьергард --- */
  {
    const { g, side, en, H, spot } = mk(22);
    const h0 = spot(side), a = g.spawn('tnk', side, h0), b = g.spawn('inf', en, H.neighbors(h0)[0]);
    g.updateVision(side); g.updateVision(en);
    g.active = en; g.cp[en] = 5; b.org = 10;
    assert(g.act(en, { t: 'order', k: 'rear', id: b.id }).ok && b.rear, 'приказ «Арьергард»');
    assert(!g.act(en, { t: 'order', k: 'rear', id: b.id }).ok, 'второй раз — нельзя');
    g.active = side; a.acted = false; a.mp = 5;
    const ha = a.hex, hb = b.hex, s0 = b.str;
    const r = g.act(side, { t: 'attack', id: a.id, target: b.id });
    assert(r.ok, 'атака по части с заслоном');
    if (b.str > 0 && !b.rem && b.hex !== hb) {
      assert.strictEqual(a.hex, ha, 'заслон не дал занять клетку');
      assert(!a.exploit, 'и прорыва нет');
      assert(b.str <= s0 - r.ld - 1 && !b.rear, 'заслон стоил шага, приказ израсходован');
    }
  }
  /* --- разведка боем --- */
  {
    const { g, side, en, H, spot } = mk(23);
    const h0 = spot(side), a = g.spawn('inf', side, h0), b = g.spawn('inf', en, H.neighbors(h0)[0]);
    const rc = g.spawn('rec', side, H.neighbors(b.hex).find(n => n !== h0 && !g.unitAt(n)));
    b.ent = 2; a.ent = 1; g.updateVision(side); g.updateVision(en);
    assert(g.snapshotFor(side).units.find(x => x.id === b.id).org === undefined, 'до разведки мораль противника неизвестна');
    const ctx = g.ctxFor(side, true), p = Rules.probeOdds(ctx, a, b), o = Rules.odds(ctx, a, b);
    assert(p.back < o.expA * .5 && p.dmg < o.expD * .3, 'разведка боем — малой кровью');
    assert(Rules.probeOdds(ctx, rc, b).back < Rules.probeOdds(ctx, { ...rc, k: 'mot' }, b).back, 'разведрота теряет меньше');
    const ha = a.hex;
    assert(g.act(side, { t: 'probe', id: a.id, target: b.id }).ok, 'разведка боем');
    assert(a.hex === ha && a.ent === 1 && a.acted, 'разведчики вернулись на место');
    if (b.str > 0 && !b.rem) {
      assert.strictEqual(b.ent, 1, 'окоп цели — на уровень ниже');
      const v = g.snapshotFor(side).units.find(x => x.id === b.id);
      assert(v.intel === 1 && v.org !== undefined && v.xp !== undefined && v.mp === undefined, 'сведения о цели добыты');
      rc.mp = 5;
      assert(g.act(side, { t: 'probe', id: rc.id, target: b.id }).ok && rc.mp === 5, 'разведрота после разведки боем ещё ходит');
      assert(b.str <= 0 || b.rem || b.ent === 1, 'второй дозор за ход окоп не сбивает');
      /* сведения устаревают */
      g.turn += W.PROBE.intel + 1;
      assert(g.snapshotFor(side).units.find(x => x.id === b.id).intel === undefined, 'через ход сведения устарели');
    }
    const art = g.spawn('art', side, H.neighbors(ha).find(n => !g.unitAt(n)));
    assert(!g.act(side, { t: 'probe', id: art.id, target: b.id }).ok, 'артиллерия разведку боем не ведёт');
  }
  /* --- остатки разбитой части --- */
  {
    const { g, side, en, H, spot } = mk(24);
    const h0 = spot(side), a = g.spawn('tnk', side, h0), b = g.spawn('inf', en, H.neighbors(h0)[0]);
    g.updateVision(side); g.updateVision(en);
    b.str = 1; b.supplied = true; b.att = 'sap';
    const hb = b.hex, lost0 = g.stats[en].lost.inf || 0;
    assert(g.act(side, { t: 'attack', id: a.id, target: b.id }).ok, 'атака по последнему шагу');
    assert(b.str === W.REMNANT.str && b.rem && b.hex !== hb, 'часть не уничтожена: остатки отошли');
    assert.strictEqual(a.hex, hb, 'клетку заняли');
    assert.strictEqual(g.stats[en].lost.inf || 0, lost0, 'потерей часть ещё не считается');
    { const zoc = Rules.zocOf(g.ctxFor(side, true), side); assert(!H.neighbors(b.hex).some(n => zoc.has(n)), 'зоны контроля у остатков нет') }
    g.active = en; b.acted = false;
    for (const t of ['attack', 'fire', 'probe', 'ambush', 'dig']) assert(!g.act(en, { t, id: b.id, target: a.id }).ok, 'остатки не воюют: ' + t);
    /* пополнение возвращает часть в строй, специалист уцелел */
    assert(!g.act(en, { t: 'replace', id: b.id }).ok, 'под носом у противника не пополниться');
    a.hex = h0; b.sv = 9; b.moved = false; g.budget[en] = 500;
    assert(g.act(en, { t: 'replace', id: b.id }).ok, 'пополнение остатков');
    assert(b.str >= W.REMNANT.reform && !b.rem && b.att === 'sap', 'часть снова в строю, специалист при ней');
    /* влиться в соседнюю часть */
    const c = g.spawn('inf', en, H.neighbors(b.hex).find(n => !g.unitAt(n))), d = g.spawn('inf', en, H.neighbors(c.hex).find(n => !g.unitAt(n)));
    c.rem = true; c.str = 1; c.remBy = side; d.str = 6;
    const k0 = g.stats[side].killed.inf || 0;
    assert(!g.act(en, { t: 'merge', id: d.id, target: c.id }).ok, 'вливаются только остатки');
    assert(g.act(en, { t: 'merge', id: c.id, target: d.id }).ok && d.str === 7 && c.str === 0, 'остатки влились в соседа');
    assert.strictEqual(g.stats[side].killed.inf || 0, k0 + 1, 'разбитая часть — в счёт противнику');
    /* остатки берут в плен любой атакой */
    const e2 = g.spawn('inf', en, H.neighbors(a.hex).find(n => !g.unitAt(n)));
    e2.rem = true; e2.str = 1; g.active = side; a.acted = false; g.updateVision(side);
    const pr = g.stats[side].prisoners;
    assert(g.act(side, { t: 'attack', id: a.id, target: e2.id }).ok && e2.str === 0, 'остатки взяты');
    assert.strictEqual(g.stats[side].prisoners, pr + 1, 'пленные посчитаны');
    /* в котле остатков не бывает */
    const { g: g2, side: s2, en: e3, H: H2, spot: sp2 } = mk(25);
    const q0 = sp2(s2), t2 = g2.spawn('tnk', s2, q0), f2 = g2.spawn('inf', e3, H2.neighbors(q0)[0]);
    g2.updateVision(s2); f2.str = 1; f2.supplied = false;
    assert(g2.act(s2, { t: 'attack', id: t2.id, target: f2.id }).ok && f2.str === 0, 'без снабжения часть гибнет целиком');
  }
  /* --- полевой склад --- */
  {
    const { g, side, en, H } = mk(26);
    const sv = () => g.sv[side];
    /* клетка в поле на скудном снабжении, вокруг — без подвоза */
    const h0 = [...Array(H.NH).keys()].find(h => sv()[h] >= 1 && sv()[h] <= 3 && !g.svNet[side][h] && !g.unitAt(h) && g.passable('dep', h) && H.neighbors(h).some(n => g.terr[n] === g.terr[h] && sv()[n] === 0 && g.map.hexes[n].t === 'open'));
    assert(h0 !== undefined, 'нашлась клетка для склада');
    const far = H.neighbors(h0).find(n => g.terr[n] === g.terr[h0] && sv()[n] === 0 && g.map.hexes[n].t === 'open');
    const dp = g.spawn('dep', side, h0);
    assert.strictEqual(dp.lvl, 1);
    g.updateSupply(side);
    assert(dp.fed && sv()[h0] === W.DEPOT.v[1] && sv()[far] > 0, `склад кормит округу: ${sv()[h0]} на клетке, ${sv()[far]} рядом`);
    assert(g.svSrc[side].some(x => x.k === 'depot' && x.hex === h0), 'склад — в списке источников');
    g.budget[side] = W.DEPOT.up; g.active = side;
    assert(g.act(side, { t: 'depot', id: dp.id }).ok && dp.lvl === 2 && g.budget[side] === 0, 'склад расширен за очки');
    assert.strictEqual(sv()[h0], W.DEPOT.v[2], 'расширенный склад даёт больше');
    assert(!g.act(side, { t: 'depot', id: dp.id }).ok, 'расширяют вместо действий — второй раз за ход нельзя');
    assert(!g.act(side, { t: 'attack', id: dp.id, target: 1 }).ok, 'склад не воюет');
    dp.moved = true; g.updateSupply(side);
    assert(sv()[h0] < W.DEPOT.v[1], 'склад на марше не работает');
    dp.moved = false;
    /* отрезанный склад держится на запасах, потом пустеет */
    const cutH = [...Array(H.NH).keys()].find(h => g.terr[h] === g.terr[h0] && sv()[h] === 0 && !g.unitAt(h) && g.passable('dep', h) && H.neighbors(h).every(n => sv()[n] === 0));
    if (cutH !== undefined) {
      dp.hex = cutH; g.updateSupply(side);
      assert(!dp.fed && sv()[cutH] === W.DEPOT.v[2], 'без подвоза склад работает на запасах');
      dp.sp = 0; g.updateSupply(side);
      assert.strictEqual(sv()[cutH], 0, 'пустой отрезанный склад ничего не даёт');
      dp.sp = 3; dp.hex = h0; g.updateSupply(side);
    }
    /* захват склада без охраны */
    const eh = H.neighbors(h0).find(n => !g.unitAt(n) && g.passable('inf', n));
    const e = g.spawn('inf', en, eh); e.sp = 1; g.updateVision(en);
    g.active = en; const b0 = g.budget[en];
    assert(g.act(en, { t: 'attack', id: e.id, target: dp.id }).ok && dp.str === 0, 'склад без охраны захвачен');
    assert(g.budget[en] === b0 + W.DEPOT.loot * 2 && e.sp === W.SUPPLY.max, 'трофеи: очки и полные боеприпасы');
    /* сохранение держит уровень склада и остатки */
    const { Game: G2 } = require('../game/engine');
    const d2 = g.spawn('dep', side, H.neighbors(e.hex).find(n => !g.unitAt(n) && g.passable('dep', n))); d2.lvl = 3;
    const r2 = g.spawn('inf', side, H.neighbors(d2.hex).find(n => !g.unitAt(n) && g.passable('inf', n))); r2.rem = true; r2.str = 1; r2.remBy = en;
    const back = G2.fromState(JSON.parse(JSON.stringify(g.saveState())));
    assert(back.units.find(u => u.id === d2.id).lvl === 3 && back.units.find(u => u.id === r2.id).rem === true, 'сохранение: уровень склада и остатки на месте');
  }
  console.log('механики 3.4: ok');
}
/* отмена хода, оборона по времени, перенос в кампании, обучение, повтор, склады у бота */
{
  /* --- отмена хода --- */
  {
    const g = new Game('both', N, 31, 'steppe');
    g.ready.n = g.ready.s = true; g.tryStart();
    const side = g.active, en = side === N ? S : N, H = g.H;
    const open = h => !g.unitAt(h) && g.passable('tnk', h) && g.map.hexes[h].t === 'open';
    const own = side === N ? 1 : 2;
    const h0 = [...Array(H.NH).keys()].find(h => g.terr[h] === own && open(h) && H.within(h, 3).every(x => !g.unitAt(x)));
    const u = g.spawn('mot', side, h0); u.mp = 6; u.ent = 2;
    g.updateVision(side);
    const to = [...Rules.reachable(g.ctxFor(side, false), u).keys()].find(h => H.hexDist(h, h0) === 2 && open(h));
    assert(g.act(side, { t: 'move', id: u.id, to }).ok && u.hex === to, 'ход');
    assert.strictEqual(g.snapshotFor(side).undo, u.id, 'тихий ход можно отменить');
    assert.strictEqual(g.snapshotFor(en).undo, null, 'противнику чужая отмена не видна');
    assert(!g.act(en, { t: 'undo' }).ok, 'чужой ход не отменить');
    assert(g.act(side, { t: 'move', id: u.id, to: h0 }).ok || true);
    /* заново: ход и сразу отмена */
    u.hex = h0; u.mp = 6; u.moved = false; u.ent = 2; g.undoRec = null;
    const terr0 = String(g.terr);
    assert(g.act(side, { t: 'move', id: u.id, to }).ok);
    assert(g.act(side, { t: 'undo' }).ok, 'отмена');
    assert(u.hex === h0 && u.mp === 6 && !u.moved && u.ent === 2, 'клетка, очки хода и окоп — как до хода');
    assert.strictEqual(String(g.terr), terr0, 'территория — как до хода');
    assert(!g.act(side, { t: 'undo' }).ok, 'дважды не отменить');
    /* после другого действия отмены нет */
    assert(g.act(side, { t: 'move', id: u.id, to }).ok);
    g.act(side, { t: 'dig', id: u.id });
    assert(!g.act(side, { t: 'undo' }).ok, 'после другого действия — поздно');
    /* ход, вскрывший противника, не отменяется */
    u.hex = h0; u.mp = 6; u.moved = false; u.acted = false;
    const hid = g.spawn('inf', en, H.within(to, 2).find(h => H.hexDist(h, to) === 2 && H.hexDist(h, h0) >= 4 && open(h)));
    g.updateVision(side);
    if (hid && !g.seen(side, hid)) {
      g.act(side, { t: 'move', id: u.id, to });
      if (g.seen(side, hid)) assert.strictEqual(g.snapshotFor(side).undo, null, 'увидели противника — отмены нет');
    }
  }
  /* --- время работает на оборону --- */
  {
    const g = new Game('attack', N, 32, 'valley');
    g.ready.n = g.ready.s = true; g.tryStart();
    assert(g.role.n === 'attacker' && g.holdBias() === -W.DEFENDER_HOLD, 'сдвиг — к обороняющемуся Союзу');
    const s0 = g.score, d = g.heldWeight(N) - g.heldWeight(S);
    g.endRound();
    assert(Math.abs(g.score - (s0 + (d - W.DEFENDER_HOLD) * W.SCORE_RATE)) < 1e-6, 'перевес за ход: разница весов минус удержание');
    assert.strictEqual(new Game('both', N, 33, 'valley').holdBias(), 0, 'во встречном бою сдвига нет');
    assert.strictEqual(new Game('bridge', N, 34).holdBias(), 0, 'в сценариях — свои условия победы');
  }
  /* --- перенос в кампании: клиенту не верим --- */
  {
    const carry = { bonus: 99999, vets: [{ k: 'tnk', xp: 5, att: 'atg', cs: '<b>Тигр-11</b>' }, { k: 'zzz', xp: 1 }, { k: 'hq', xp: 1 }, { k: 'art', xp: .7, att: 'hvy', cs: 'Гром-22' }, null, 7] };
    const g = new Game('breakthrough', N, 35, undefined, { carry });
    assert.strictEqual(g.budget.n, 400 + 300, 'очки переноса зажаты потолком');
    const t = g.units.find(u => u.side === N && u.k === 'tnk' && u.vet), a = g.units.find(u => u.side === N && u.k === 'art' && u.vet);
    assert(t && t.xp === 1 && t.att === null && t.cs === 'bТигр-11b', 'ветеран-танкист: опыт зажат, чужой специалист отброшен, позывной вычищен');
    assert(a && a.xp === .7 && a.att === 'hvy' && a.cs === 'Гром-22', 'ветеран-артиллерист перенесён');
    assert.strictEqual(g.units.filter(u => u.vet).length, 2, 'мусорные записи и штаб не перенесены');
    assert(!g.units.some(u => u.side === S && u.vet), 'противнику ветеранов не досталось');
    assert.strictEqual(Game.cleanCarry({ vets: 'x', bonus: 'много' }, N), null, 'мусор вместо переноса — ничего');
    assert.strictEqual(new Game('both', N, 36, 'valley', { carry }).units.filter(u => u.vet).length, 0, 'вне сценария перенос не действует');
  }
  /* --- учебная операция и кадры повтора --- */
  {
    const g = new Game('tutor', N, 37);
    g.bots = { n: true, s: true }; g.tryStart();
    assert.strictEqual(g.phase, 'battle', 'обучение начинается без расстановки');
    g.drainEvents();
    const sn = g.snapshotFor(N).scen;
    assert(sn.tutorial === 1 && sn.tip && sn.tip.n === 1 && sn.tip.of === 6, 'подсказка первого хода — ученику');
    assert.strictEqual(g.snapshotFor(S).scen.tip, null, 'противнику подсказок нет');
    let guard = 0;
    while (!g.over && guard++ < 100) { for (const st of g.seatsOf(g.active)) if (!g.done[st.id]) g.botTurn(st.id); g.drainEvents() }
    assert(g.over, 'обучение доигрывается');
    assert(g.frames.length >= 2 && g.frames[0].u.length && g.frames[0].terr.length === g.H.NH && g.frames[g.frames.length - 1].p.length === g.pts.length, 'кадры повтора записаны');
  }
  /* --- бот покупает и ставит склад --- */
  {
    let bought = 0, worked = 0;
    for (const seed of [41, 42, 43]) {
      const g = new Game('both', N, seed, 'steppe');
      g.bots = { n: true, s: true }; g.tryStart();
      let guard = 0, had = false, fed = false;
      while (!g.over && guard++ < 120) {
        for (const st of g.seatsOf(g.active)) if (!g.done[st.id]) g.botTurn(st.id);
        g.drainEvents();
        const d = g.units.filter(u => u.k === 'dep' && u.str > 0);
        if (d.length) had = true;
        if (d.some(u => g.svSrc[u.side].some(x => x.k === 'depot' && x.hex === u.hex))) fed = true;
        assert(d.filter(u => u.side === N).length <= 1 && d.filter(u => u.side === S).length <= 1, 'не больше склада на командира');
      }
      if (had) bought++; if (fed) worked++;
    }
    assert(bought >= 1 && worked >= 1, `бот пользуется складом: куплен в ${bought} партиях из 3, работал в ${worked}`);
  }
  console.log('механики 3.5: ok');
}
/* механики 3.3: топливо, подавленные шаги, специалисты, погода в снабжении */
{
  const Hex = require('../shared/hex'), W = require('../shared/world');
  const g = new Game('both', N, 9, 'steppe');
  g.ready.n = g.ready.s = true; g.tryStart();
  const side = g.active, en = side === N ? S : N, H = g.H;
  /* топливо: в котле танки встают, пехота идёт пешком */
  const mid = H.hexAt(g.WW / 2, g.WH / 2);
  const tank = g.spawn('tnk', side, mid), inf = g.spawn('inf', side, H.neighbors(mid).find(h => !g.unitAt(h) && g.passable('inf', h)));
  for (const u of [tank, inf]) for (const h of H.neighbors(u.hex)) if (!g.unitAt(h) && g.passable('inf', h)) g.spawn('inf', en, h);
  for (let i = 0; i < 3; i++) { g.active = side; g.endTurn(); g.drainEvents() }
  assert(tank.fu === 0 && !tank.supplied, 'в котле топливо уходит за 3 хода: ' + tank.fu);
  assert(inf.fu === W.SUPPLY.max, 'у пехоты топлива нет и не убывает');
  g.startSide(side); g.drainEvents();
  assert.strictEqual(tank.mp, 0, 'без топлива танк стоит');
  assert(inf.mp > 0, 'пехота в котле ходит пешком');
  /* подавленные шаги: снижают силу в расчёте и возвращаются в начале своего хода */
  g.updateSupply(side);
  const fullH = [...Array(H.NH).keys()].find(h => g.sv[side][h] >= 7 && !g.unitAt(h) && g.passable('tnk', h) && H.neighbors(h).some(n => !g.unitAt(n) && g.passable('inf', n)));
  const a = g.spawn('tnk', side, fullH), b = g.spawn('inf', en, H.neighbors(a.hex).find(h => !g.unitAt(h) && g.passable('inf', h)));
  const ctx = g.ctxFor(side, true), r0 = Rules.odds(ctx, a, b).r;
  b.su = 4;
  const r1 = Rules.odds(ctx, a, b).r;
  assert(r1 > r0 * 1.4, `подавленная цель слабее в обороне: ${r0.toFixed(2)} → ${r1.toFixed(2)}`);
  a.su = 5;
  assert(Rules.odds(ctx, a, b).A < Rules.odds(ctx, { ...a, su: 0 }, b).A * .6, 'подавленный атакует слабее');
  a.su = a.str; a.acted = false; g.active = side;
  assert(!g.act(side, { t: 'attack', id: a.id, target: b.id }).ok, 'все шаги подавлены — атаки нет');
  b.str = 0;   /* убираем соседа противника — иначе его зона контроля режет подвоз */
  g.startSide(side); g.drainEvents();
  assert(W.supTier(a.sv) === 'full' || W.supTier(a.sv) === 'ok', 'часть на снабжении: ' + a.sv);
  assert.strictEqual(a.su, 0, 'на снабжении подавленные шаги возвращаются в начале хода');
  /* огонь даёт и потери, и подавление */
  const ex = Rules.bombardOdds(ctx, 9, b, {});
  assert(ex.sup > ex.kill, 'огонь больше прижимает, чем убивает');
  /* специалисты */
  const g2 = new Game('both', N, 4, 'valley');
  const s2 = g2.seats[0].id, u2 = g2.spawn('inf', g2.sideOf(s2), g2.freeHex(40, 200, 'inf'), { seat: s2 });
  const b0 = g2.budget[s2];
  assert(g2.act(s2, { t: 'attach', id: u2.id, k: 'atg' }).ok && u2.att === 'atg' && g2.budget[s2] === b0 - W.SPECS.atg.price, 'придание за очки');
  assert(!g2.act(s2, { t: 'attach', id: u2.id, k: 'sap' }).ok, 'один специалист на часть');
  assert(!g2.act(s2, { t: 'attach', id: u2.id, k: 'hvy' }).ok || u2.att === 'atg', 'тяжёлая батарея — только артиллерии');
  const tk = { id: -5, k: 'tnk', side: S, hex: H.neighbors(u2.hex)[0], str: 10, org: 100, xp: .2, sp: 3 };
  const c2 = g2.ctxFor(N, true);
  assert(Rules.odds(c2, tk, u2).D > Rules.odds(c2, tk, { ...u2, att: null }).D * 1.2, 'ПТ-взвод держит танки');
  /* погода: в распутицу поле съедает снабжение быстрее, дороги — как были */
  const g3 = new Game('both', N, 6, 'valley'); g3.ready.n = g3.ready.s = true; g3.tryStart();
  g3.weather = require('../shared/weather').wxById('clear'); g3.updateSupply(N);
  const dry = Uint8Array.from(g3.sv.n), net = Uint8Array.from(g3.svNet.n);
  g3.weather = require('../shared/weather').wxById('snow'); g3.updateSupply(N);
  let field = 0, worse = 0;
  for (let h = 0; h < H.NH; h++) { if (net[h]) assert.strictEqual(g3.sv.n[h], dry[h], 'дороги в снег везут как прежде'); else if (dry[h] > 2) { field++; if (g3.sv.n[h] < dry[h]) worse++ } }
  assert(worse > field * .6, `в снег поле снабжается хуже: ${worse} из ${field}`);
  console.log('механики 3.3: ok');
}
/* расстановка: штаб и КП каждого командира — в своей зоне на всех картах;
   «Готов» — у места: второй командир стороны готовится после первого */
{
  for (const map of require('../shared/maps').MAP_ORDER) {
    const g = new Game('both', N, 3, map, { teams: { n: [{}, {}], s: [{}, {}] } });
    for (const u of g.units) if (u.k === 'hq' || u.k === 'fob') assert(g.inDeploy(u.side, u.hex), `${map}: ${u.k} ${u.seat} вне своей зоны расстановки`);
  }
  const g = new Game('both', N, 3, 'corridor', { teams: { n: [{}, {}], s: [{ bot: true }] } });
  g.bots = { s: true };
  const site = seat => { const f = g.units.find(u => u.k === 'fob' && u.seat === seat); return g.act(seat, { t: 'place', id: f.id, hex: f.hex }) };
  for (const st of g.seatsOf(N)) assert(site(st.id).ok, 'КП на своём месте подтверждается: ' + st.id);
  assert(g.act('n', { t: 'ready' }).ok && g.phase === 'deploy', 'первый командир готов, ждём второго');
  assert(g.act('n2', { t: 'ready' }).ok, 'второй командир может нажать «Готов» после первого');
  assert.strictEqual(g.phase, 'battle', 'оба готовы — бой');
  console.log('расстановка по местам: ok');
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
/* ---------- места и команды: 1 на 1, 2 на 2, 2 на 1, 3 на 3 ---------- */
{
  const Hex = require('../shared/hex');
  const mk = (nN, nS, bots = true) => new Game('both', N, 41, 'steppe', {
    teams: { n: Array.from({ length: nN }, () => ({ bot: bots })), s: Array.from({ length: nS }, () => ({ bot: bots })) }
  });

  /* состав мест и имена: первое место стороны носит её букву */
  const g22 = mk(2, 2);
  assert.deepStrictEqual(g22.seats.map(st => st.id), ['n', 'n2', 's', 's2'], 'идентификаторы мест');
  assert.deepStrictEqual(g22.seatsOf(N).map(st => st.id), ['n', 'n2'], 'места стороны');
  assert.strictEqual(g22.sideOf('n2'), N, 'сторона места');

  /* бюджет стороны делится между её местами, 2 на 1 не даёт двойной силы */
  const g21 = mk(2, 1);
  const sumN = g21.seatsOf(N).reduce((a, st) => a + g21.budget[st.id], 0);
  assert(Math.abs(sumN - g21.budget.s) <= 1, `бюджет 2 на 1 не поделён: ${sumN} против ${g21.budget.s}`);

  /* каждое место закупается само и владеет своими частями */
  g22.ready.n = g22.ready.n2 = g22.ready.s = g22.ready.s2 = false;
  g22.tryStart();
  assert.strictEqual(g22.phase, 'battle', 'партия 2 на 2 началась');
  for (const u of g22.units) assert(g22.seatById.has(u.seat), `у части нет места: ${u.k}`);
  const bySeat = {};
  for (const u of g22.units) bySeat[u.seat] = (bySeat[u.seat] || 0) + 1;
  for (const st of g22.seats) assert(bySeat[st.id] > 0, `место ${st.id} осталось без частей`);

  /* чужой частью командовать нельзя */
  {
    const side = g22.active, mySeats = g22.seatsOf(side).map(st => st.id);
    const mine = g22.units.find(u => u.seat === mySeats[0] && u.str > 0);
    const ally = g22.units.find(u => u.seat === mySeats[1] && u.str > 0);
    assert(mine && ally, 'нашлись части у обоих командиров');
    const r = g22.act(mySeats[0], { t: 'move', id: ally.id, to: Hex.neighbors(ally.hex)[0] });
    assert.strictEqual(r.ok, false, 'часть союзника не слушается чужого приказа');
    assert(/другого командира/.test(r.error), 'понятная причина отказа: ' + r.error);
  }

  /* ход переходит только когда закончили все места стороны */
  {
    const side = g22.active, [a, b] = g22.seatsOf(side).map(st => st.id);
    const r1 = g22.act(a, { t: 'end' });
    assert(r1.ok && g22.active === side, 'после первого командира ход остаётся за стороной');
    assert.deepStrictEqual(r1.waiting, [b], 'ждём второго командира');
    assert.strictEqual(g22.act(a, { t: 'move', id: g22.units.find(u => u.seat === a).id, to: 0 }).ok, false,
      'закончивший ход больше не действует');
    g22.act(b, { t: 'end' });
    assert(g22.active !== side, 'после всех командиров ход перешёл');
  }

  /* партии ботов доходят до итога при любом составе */
  for (const [a, b] of [[1, 1], [2, 2], [2, 1], [3, 3]]) {
    const g = mk(a, b);
    g.tryStart();
    assert.strictEqual(g.phase, 'battle', `${a} на ${b}: не стартовала`);
    let guard = 0;
    while (!g.over && guard++ < 600) {
      for (const st of g.seatsOf(g.active)) if (!g.done[st.id]) g.botTurn(st.id);
      g.drainEvents();
      if (!g.over && g.pending(g.active).length) g.act(g.pending(g.active)[0].id, { t: 'end' });
    }
    assert(g.over, `${a} на ${b}: партия не закончилась`);
    assert.strictEqual(g.seats.length, a + b, `${a} на ${b}: мест ${g.seats.length}`);
    console.log(`  ${a} на ${b}: мест ${g.seats.length}, ходов ${g.turn}, победа ${g.over.w || '—'}`);
  }
  console.log('места и команды: ok');
}
/* ---------- ставка: свой штаб у каждого командира, захват без охраны ---------- */
{
  const Hex = require('../shared/hex');
  /* у каждого командира свой подвижный штаб и свой стационарный пункт */
  {
    const g = new Game('both', N, 5, 'valley', { teams: { n: [{ bot: 1 }, { bot: 1 }, { bot: 1 }], s: [{ bot: 1 }] } });
    g.tryStart();
    const hq = g.units.filter(u => u.k === 'hq' && u.side === N && u.str > 0);
    const fob = g.units.filter(u => u.k === 'fob' && u.side === N && u.str > 0);
    assert.strictEqual(hq.length, 3, 'по штабу на командира');
    assert.strictEqual(fob.length, 3, 'по командному пункту на командира');
    assert.strictEqual(new Set(fob.map(u => u.seat)).size, 3, 'пункты принадлежат разным командирам');
    assert(fob.every(u => u.sited), 'бот обязан поставить свой пункт');
    const far = Math.min(Hex.hexDist(fob[0].hex, fob[1].hex), Hex.hexDist(fob[1].hex, fob[2].hex));
    assert(far >= 5, 'пункты союзников разведены по фронту, а не в одном углу: ' + far);
    /* стационарный пункт не передвигают */
    assert.strictEqual(g.move(fob[0], Hex.neighbors(fob[0].hex)[0]).ok, false, 'пункт не ходит');
    assert.strictEqual(fob[0].mp, 0, 'у пункта нет очков хода');
  }

  /* стационарный пункт — один на командира; после потери можно поставить новый */
  {
    const g = new Game('both', N, 19, 'steppe');
    const spot = h => g.map.hexes.findIndex((x, i) => g.inDeploy(N, i) && !g.unitAt(i));
    const first = g.units.find(u => u.k === 'fob' && u.seat === N);
    assert(first, 'пункт выдан сразу');
    const r = g.buy(N, 'fob', spot(), true);
    assert.strictEqual(r.ok, false, 'второй пункт купить нельзя');
    assert(/один на командира/.test(r.error), 'понятная причина: ' + r.error);
    /* потеряли — можно поставить новый */
    first.str = 0;
    assert.strictEqual(g.buy(N, 'fob', spot(), true).ok, true, 'взамен потерянного пункт покупается');
    /* у союзника свой — он не мешает */
    const g2 = new Game('both', N, 19, 'steppe', { teams: { n: [{}, {}], s: [{ bot: 1 }] } });
    assert.strictEqual(g2.units.filter(u => u.k === 'fob' && u.side === N).length, 2, 'по пункту каждому командиру');
  }

  /* пункт обязателен: без него «Готов» не принимается */
  {
    const g = new Game('both', N, 17, 'steppe');
    assert.strictEqual(g.act(N, { t: 'ready' }).ok, false, 'без поставленного пункта нельзя быть готовым');
    const fob = g.units.find(u => u.k === 'fob' && u.seat === N);
    const spot = g.map.hexes.findIndex((h, i) => g.inDeploy(N, i) && !g.unitAt(i));
    assert(g.act(N, { t: 'place', id: fob.id, hex: spot }).ok, 'пункт ставится в своей зоне');
    assert.strictEqual(fob.sited, true, 'пункт отмечен как развёрнутый');
    assert.strictEqual(g.act(N, { t: 'ready' }).ok, true, 'после постановки готовность принимается');
  }

  /* сектор даёт штаб своего командира: чужой не считается */
  {
    const g = new Game('both', N, 9, 'steppe', { teams: { n: [{ bot: 1 }, { bot: 1 }], s: [{ bot: 1 }] } });
    g.tryStart();
    const sets = g.cmdHexes(N);
    assert(sets.get('n') && sets.get('n2'), 'сектор у каждого командира');
    const hq2 = g.units.find(u => u.k === 'hq' && u.seat === 'n2');
    const fob2 = g.units.find(u => u.k === 'fob' && u.seat === 'n2');
    assert(sets.get('n2').has(hq2.hex), 'штаб внутри своего сектора');
    assert(sets.get('n2').has(fob2.hex), 'пункт внутри своего сектора');
    /* подвижный штаб на марше сектора не держит, а стационарный пункт держит всегда */
    hq2.moved = true;
    const afterMarch = g.cmdHexes(N).get('n2');
    assert(!afterMarch.has(hq2.hex) || Hex.hexDist(hq2.hex, fob2.hex) <= W.UT.fob.cmd,
      'штаб на марше сектора не держит');
    assert(afterMarch.has(fob2.hex), 'пункт держит сектор и когда штаб на марше');
    hq2.moved = false;
  }

  /* захват ставки: без охраны берут в плен, с охраной — обычный бой */
  const tryCapture = guarded => {
    const g = new Game('both', N, 13, 'steppe');
    g.ready.n = g.ready.s = true; g.tryStart();
    const side = g.active, en = side === N ? S : N;
    const hq = g.units.find(u => u.k === 'fob' && u.side === en && u.str > 0);
    /* убираем всех соседей вражеского штаба, чтобы он остался один */
    for (const h of Hex.neighbors(hq.hex)) { const v = g.unitAt(h); if (v) g.units = g.units.filter(x => x !== v) }
    const spot = Hex.neighbors(hq.hex).find(h => h >= 0 && !g.unitAt(h) && g.passable('inf', h));
    const att = g.spawn('inf', side, spot, { seat: side });
    if (guarded) {
      const gh = Hex.neighbors(hq.hex).find(h => h >= 0 && h !== spot && !g.unitAt(h) && g.passable('inf', h));
      g.spawn('inf', en, gh);
    }
    att.acted = false; att.sp = 3; att.org = 100; att.str = 10;
    g.active = side; g.updateVision(side);
    const cpBefore = g.cp[side];
    const r = g.act(side, { t: 'attack', id: att.id, target: hq.id });
    return { ok: r.ok, captured: !!r.captured, hqDead: hq.str <= 0, cpGain: g.cp[side] - cpBefore, took: att.hex === hq.hex };
  };
  const free = tryCapture(false);
  assert(free.ok && free.captured, 'ставка без охраны захватывается');
  assert.strictEqual(free.hqDead, true, 'захваченный штаб уходит с карты');
  assert.strictEqual(free.cpGain, W.HQ_CAPTURE_CP, `за ставку ${W.HQ_CAPTURE_CP}★, получено ${free.cpGain}`);
  assert.strictEqual(free.took, true, 'захватчик занимает клетку ставки');
  const held = tryCapture(true);
  assert(held.ok && !held.captured, 'под охраной ставка не сдаётся — обычный бой');
  console.log('ставка командира: ok');
}
/* ---------- авиаудар и ПВО ----------
   Удар по пехоте в поле без прикрытия снимает в среднем около двух шагов;
   под зонтиком ПВО удар заметно слабее, часть налётов сбита, а сбитый
   штурмовик — минус вылет в следующий ход. Расчёт клиента совпадает. */
{
  const Hex = require('../shared/hex').gridFor('steppe');
  const { wxById } = require('../shared/weather');
  const g = new Game('both', N, 77, 'steppe');
  g.bots = { n: true, s: true }; g.tryStart();
  g.weather = wxById('clear'); g.turn = 0; g.active = N;
  const m = g.map, spot = [];
  for (let h = 0; h < Hex.NH && spot.length < 1; h++) {
    const hx = m.hexes[h];
    if (hx.t !== 'open' || hx.x < 120 || hx.x > 200) continue;
    if (Hex.within(h, 3).some(x => g.unitAt(x) || m.hexes[x].t === 'lake')) continue;
    spot.push(h);
  }
  assert(spot.length, 'нет чистого поля для проверки авиации');
  const tgt = spot[0], aaHex = Hex.neighbors(tgt).find(x => m.hexes[x].t !== 'lake' && !g.unitAt(x));
  const trial = withAA => {
    g.units = g.units.filter(u => u.hex !== tgt && u.hex !== aaHex);
    const e = g.spawn('inf', S, tgt, { ent: 0 });
    if (withAA) g.spawn('aa', S, aaHex, {});
    e.revealed = g.turn; g.recon.n.add(tgt); g.updateVision(N);
    g.air.n = { strike: 1, recon: 0 }; g.airLost.n = 0;
    const r = g.act(N, { t: 'air', kind: 'strike', hex: tgt });
    assert(r.ok, 'удар не прошёл: ' + r.error);
    g.drainEvents();
    return { loss: 10 - e.str, down: !!r.down };
  };
  const N0 = 160, open = [], cover = [];
  for (let i = 0; i < N0; i++) open.push(trial(false));
  for (let i = 0; i < N0; i++) cover.push(trial(true));
  const avgL = a => a.reduce((s, x) => s + x.loss, 0) / a.length;
  const downK = cover.filter(x => x.down).length / N0;
  assert(avgL(open) >= 1.5, `авиаудар слабый: в среднем ${avgL(open).toFixed(2)} шага`);
  assert(open.every(x => !x.down), 'без ПВО штурмовик не сбивают');
  assert(downK > .15 && downK < .5, `доля сбитых под одним ПВО ${downK.toFixed(2)}`);
  assert(avgL(cover) < avgL(open) * .5, `ПВО почти не мешает: ${avgL(cover).toFixed(2)} против ${avgL(open).toFixed(2)}`);
  /* сбитый штурмовик — минус вылет в следующий ход */
  g.airLost.n = 1; g.startSide(N);
  assert.strictEqual(g.air.n.strike, W.AIR.strike[0] - 1, 'после потери вылетов меньше');
  /* расчёт для клиента — тот же, что на сервере */
  const ctx = g.ctxFor(N, true), e = g.unitAt(tgt), o = Rules.airOdds(ctx, e);
  assert(o.cover > .9 && o.shot > .2 && o.cut < .6, 'расчёт прикрытия ПВО');
  console.log(`авиация и ПВО: ok (без ПВО −${avgL(open).toFixed(2)}, под ПВО −${avgL(cover).toFixed(2)}, сбито ${Math.round(downK * 100)}%)`);
}
/* ---------- сохранение и загрузка ----------
   Снимок → сжатие → разбор → партия; играется дальше без ошибок. Мусор и
   подмена значений не роняют сервер: либо отказ, либо значения зажаты. */
{
  const Save = require('../game/save');
  const g = new Game('both', N, 31, 'corridor');
  g.bots = { n: true, s: true }; g.tryStart();
  for (let i = 0; i < 8 && !g.over; i++) { g.botTurn(g.active); g.drainEvents() }
  const st = g.saveState(), packed = Save.pack(st);
  const g2 = Game.fromState(Save.unpack(packed));
  assert.strictEqual(g2.turn, g.turn, 'ход после загрузки');
  assert.strictEqual(g2.units.length, g.units.filter(u => u.str > 0).length, 'части после загрузки');
  assert.strictEqual(String(g2.terr), String(g.terr), 'территория после загрузки');
  for (const u of g.units.filter(x => x.str > 0)) {
    const v = g2.units.find(x => x.id === u.id);
    for (const f of ['hex', 'str', 'org', 'sp', 'fu', 'su', 'seat', 'cs']) assert.strictEqual(v[f], u[f], `часть ${u.id}: ${f}`);
  }
  g2.bots = { n: true, s: true };
  for (let guard = 0; !g2.over && guard < 400; guard++) { g2.botTurn(g2.active); g2.drainEvents() }
  assert(g2.over, 'загруженная партия доиграна');
  for (const bad of [null, {}, { fmt: 1 }, { fmt: 1, mode: 'zzz' }, { fmt: 1, mode: 'both', map: 'valley', units: [] }, { fmt: 1, mode: 'both', map: 'valley', units: [{ k: 'tnk', side: 'n', id: 1, hex: 1e9 }] }])
    assert.throws(() => Game.fromState(bad), 'мусор не загружается: ' + JSON.stringify(bad));
  for (const bad of ['', '!!!', 'QUJD', 42, 'A'.repeat(500001)]) assert.throws(() => Save.unpack(bad), 'мусор не распаковывается');
  const st2 = g.saveState();
  st2.units[0].str = 1e9; st2.units[0].cs = '<script>'; st2.budget.n = -1e9; st2.score = 1e9; st2.commanders.n.name = '<b>x</b>';
  const g3 = Game.fromState(st2);
  assert(g3.units.find(u => u.id === st2.units[0].id).str === 10 && g3.budget.n === 0 && g3.score === 100, 'значения зажаты');
  assert(!/[<>]/.test(JSON.stringify(g3.snapshotFor('spec'))), 'разметка не проходит');
  console.log(`сохранение и загрузка: ok (снимок ${packed.length} байт)`);
}
/* ---------- состав по ходу партии ----------
   Новый командир при расстановке и в бою: свой штаб, бюджет стороны
   делится заново (сумма та же), больше MAX_SEATS — нельзя. */
{
  const g = new Game('both', N, 41, 'valley');
  g.bots = { n: true, s: true };
  let r = g.addSeat(N, true);
  assert(r.ok && r.id === 'n2', 'место при расстановке');
  assert(g.units.some(u => u.seat === 'n2' && u.k === 'hq') && g.units.some(u => u.seat === 'n2' && u.k === 'fob' && u.sited), 'штаб и пункт нового командира');
  g.tryStart();
  assert.strictEqual(g.phase, 'battle', 'бот нового места расставился');
  for (let i = 0; i < 4; i++) { g.botTurn(g.active); g.drainEvents() }
  const sum = () => g.seatsOf(S).reduce((a, x) => a + g.budget[x.id], 0), before = Math.floor(sum());
  r = g.addSeat(S, false);
  assert(r.ok && r.id === 's2', 'место в бою');
  assert(Math.abs(sum() - before) < 1, 'очки стороны не появились из воздуха');
  assert(g.units.some(u => u.seat === 's2' && u.k === 'hq'), 'штаб нового командира в бою');
  assert(g.addSeat(S, true).ok && !g.addSeat(S, true).ok, `не больше ${W.MAX_SEATS} мест`);
  for (const sd of [N, S]) for (const st of g.seatsOf(sd)) g.bots[st.id] = true;
  for (let guard = 0; !g.over && guard < 400; guard++) { g.botTurn(g.active); for (const st of g.seatsOf(g.active)) if (!g.done[st.id] && !g.over) g.botTurn(st.id); g.drainEvents() }
  assert(g.over, 'партия с добавленными местами доиграна');
  console.log('состав по ходу партии: ok');
}
/* ---------- зимние карты: своя погода ---------- */
{
  const { MAPS, MAP_ORDER } = require('../shared/maps');
  const { wxPool } = require('../shared/weather');
  const winter = MAP_ORDER.filter(id => MAPS[id].winter);
  assert(winter.length >= 4, 'зимних карт меньше четырёх');
  for (const id of winter) {
    const g = new Game('both', N, 5, id);
    assert(['frost', 'cloud'].includes(g.weather.id), `${id}: погода в начале ${g.weather.id}`);
    assert(!wxPool(MAPS[id]).some(x => x.w.id === 'rain' || x.w.id === 'storm'), `${id}: дождь зимой`);
  }
  assert(!wxPool(MAPS.valley).some(x => x.w.winter), 'метель летом');
  console.log(`зимние карты: ok (${winter.join(', ')})`);
}
/* ============================================================
   ОТЧЁТ ПО БАЛАНСУ: сводка по всем сыгранным партиям.
   Цифры — от ботов, поэтому это не истина, а индикатор: резкий
   сдвиг доли побед или длины партий виден сразу, в том числе в CI.
   ============================================================ */
const MODE_RU = { both: 'встречный бой', attack: 'наступление', defense: 'оборона' };
const SCEN_RU = { tutor: 'Учебная операция', bridge: 'Мост через Тихую', breakthrough: 'Прорыв к Красногору', night: 'Ночной рейд' };
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
  table(['режим', 'партий', W.SIDE_NAME.n, W.SIDE_NAME.s, 'ничьи', 'атакующий', 'ходов', 'до срока', 'потери З/В'], rows, w);
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
  console.log(`всего свободных партий ${free.length}: ${W.SIDE_NAME.n} ${wn}, ${W.SIDE_NAME.s} ${ws}, ничьи ${dr} · средняя длина ${f1(avg(free.map(g => g.turns)))} ходов`);
  const notes = [];
  /* перекос сторон во встречном бою — там силы равны, значит должно быть близко к 50/50 */
  const both = games.filter(g => g.mode === 'both' && !g.sweep);
  if (both.length >= 6) {
    const bn = both.filter(g => g.w === N).length, bs = both.filter(g => g.w === S).length;
    if (Math.max(bn, bs) / both.length > .8) notes.push(`во встречном бою перекос ${bn}:${bs} — силы равны, ожидается примерно поровну`);
  }
  /* сценарий, который боты не берут ни разу, скорее всего непроходим по сроку */
  for (const id of SCENS) {
    const list = games.filter(g => g.mode === id);
    if (list.length >= 5 && !list.some(g => g.w === N)) notes.push(`«${SCEN_RU[id]}» не взят ни в одной из ${list.length} партий — срок ${list[0].span} ходов может быть слишком жёстким`);
  }
  if (notes.length) { console.log(''); for (const t of notes) console.log('  ⚠ ' + t) }
  else console.log('резких перекосов не видно');
}
console.log('');
console.log('headless: ok');
