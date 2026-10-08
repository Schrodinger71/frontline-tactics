'use strict';
/* ============================================================
   СКВОЗНОЙ ТЕСТ: сервер + клиенты по WebSocket.
   Партия против бота (расстановка, ход, ход бота), дуэль по коду
   с очерёдностью ходов, зритель, наблюдение ботов, мусор.
   Запуск: node test/e2e.js
   ============================================================ */
const assert = require('assert');
const WebSocket = require('ws');
const { createServer, rooms } = require('../server/index');

/** КП обязателен перед «Готов»: ставим его туда, где он уже стоит */
async function siteFob(c, act) {
  const fob = (c.snap && c.snap.units || []).find(u => u.k === 'fob' && !u.enemy);
  if (!fob) return;
  await act(c, { t: 'place', id: fob.id, hex: fob.hex });
}
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, msgs: [], snap: null, waiters: [] };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'snap') c.snap = m.v;
    c.msgs.push(m);
    c.waiters = c.waiters.filter(w => !(w.f(m) && (w.res(m), true)));
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (f, ms = 8000) => new Promise((res, rej) => {
    const hit = c.msgs.find(f);
    if (hit) return res(hit);
    c.waiters.push({ f, res });
    setTimeout(() => rej(new Error('не дождались сообщения')), ms);
  });
  c.open = new Promise(r => ws.on('open', r));
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
const act = (c, a) => { const id = ++seq; c.send({ t: 'act', id, a }); return c.wait(m => m.t === 'res' && m.id === id) };

(async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  /* против бота */
  const a = client(port); await a.open;
  a.ws.send('{не json'); a.send({ t: 'act', a: null });
  a.send({ t: 'create', mode: 'both', side: 'n', vsBot: true });
  const j = await a.wait(m => m.t === 'joined');
  assert.strictEqual(j.side, 'n');
  await a.wait(m => m.t === 'snap');
  const zone = [];
  const Hex = require('../shared/hex');
  for (let h = 0; h < Hex.NH; h++) if (Hex.center(h).x < 110) zone.push(h);
  assert((await act(a, { t: 'buy', k: 'tnk', hex: zone[400] })).res.ok, 'покупка в зоне');
  assert(!(await act(a, { t: 'buy', k: 'tnk', hex: Hex.hexAt(250, 200) })).res.ok, 'покупка вне зоны запрещена');
  assert(!(await act(a, { t: 'move', id: 1, to: 5 })).res.ok, 'ходить до боя нельзя');
  (await siteFob(a, act), await act(a, { t: 'ready' }));
  await a.wait(m => m.t === 'snap' && m.v.phase === 'battle' && m.v.active === 'n');
  const tank = a.snap.units.find(u => u.k === 'tnk');
  const end = await act(a, { t: 'end' });
  assert(end.res.ok);
  await a.wait(m => m.t === 'snap' && m.v.turn === 1 && m.v.active === 'n', 15000);
  assert(a.msgs.some(m => m.t === 'ev' && m.list.some(e => e.e === 'turn')), 'события хода приходят');
  assert(a.snap.units.find(u => u.id === tank.id).mp > 0, 'новый ход — новые очки хода');

  /* дуэль: ходы по очереди, чужой ход не принимается */
  const p1 = client(port), p2 = client(port), sp = client(port);
  await p1.open; await p2.open; await sp.open;
  p1.send({ t: 'create', mode: 'both', side: 'n', vsBot: false });
  const d = await p1.wait(m => m.t === 'joined');
  p2.send({ t: 'join', room: d.room });
  assert.strictEqual((await p2.wait(m => m.t === 'joined')).side, 's');
  (await siteFob(p1, act), await act(p1, { t: 'ready' })); (await siteFob(p2, act), await act(p2, { t: 'ready' }));
  const first = (await p1.wait(m => m.t === 'snap' && m.v.phase === 'battle')).v.active;   /* первый ход — по жребию */
  const [cur, other] = first === 'n' ? [p1, p2] : [p2, p1];
  assert(!(await act(other, { t: 'end' })).res.ok, 'ход не в свою очередь');
  sp.send({ t: 'join', room: d.room, spec: true });
  assert.strictEqual((await sp.wait(m => m.t === 'joined')).side, 'spec');
  await sp.wait(m => m.t === 'snap');
  assert(sp.snap.units.some(u => u.side === 'n') && sp.snap.units.some(u => u.side === 's'), 'зритель видит обе стороны');
  assert(!(await act(sp, { t: 'end' })).res.ok, 'зритель не ходит');
  for (const u of p2.snap.units) if (u.side === 'n') assert(u.org === undefined, 'туман: чужая мораль скрыта');
  assert((await act(cur, { t: 'end' })).res.ok);
  await other.wait(m => m.t === 'snap' && m.v.active === (first === 'n' ? 's' : 'n'));

  /* наблюдение ботов */
  const w = client(port); await w.open;
  w.send({ t: 'create', mode: 'both', watch: true, map: 'lakes' });
  assert.strictEqual((await w.wait(m => m.t === 'joined')).side, 'spec');
  assert.strictEqual((await w.wait(m => m.t === 'snap')).v.map, 'lakes', 'карта на выбор');
  w.send({ t: 'pace', value: 4 });
  await w.wait(m => m.t === 'snap' && m.v.turn >= 1, 20000);

  /* ---------- команды: 2 на 2, места занимают игрок или бот ---------- */
  const c1 = client(port), c2 = client(port); await c1.open; await c2.open;
  c1.send({ t: 'create', mode: 'both', side: 'n', map: 'steppe', seats: { n: ['me', 'bot'], s: ['open', 'bot'] } });
  const j1 = await c1.wait(m => m.t === 'joined');
  assert.strictEqual(j1.seat, 'n', 'создатель садится на первое место своей стороны');
  assert.strictEqual(j1.seats.length, 4, 'в партии четыре места');
  assert.deepStrictEqual(j1.seats.map(x => x.who), ['human', 'bot', 'open', 'bot'], 'состав мест');
  c2.send({ t: 'join', room: j1.room });
  const j2 = await c2.wait(m => m.t === 'joined');
  assert.strictEqual(j2.seat, 's', 'второй игрок занял свободное место другой стороны');
  assert.strictEqual(j2.side, 's');
  /* третий человек — мест нет, только зрителем */
  const c3 = client(port); await c3.open;
  c3.send({ t: 'join', room: j1.room });
  assert(/Свободных мест/.test((await c3.wait(m => m.t === 'error')).msg), 'лишний игрок получает отказ');
  (await siteFob(c1, act), await act(c1, { t: 'ready' })); (await siteFob(c2, act), await act(c2, { t: 'ready' }));
  const sn = (await c1.wait(m => m.t === 'snap' && m.v.phase === 'battle', 20000)).v;
  assert.strictEqual(sn.seat, 'n', 'снимок знает своё место');
  assert(sn.seats.length === 4 && sn.seats.every(x => x.id), 'состав мест в снимке');
  assert(typeof sn.budget === 'number', 'бюджет — свой, не стороны');
  /* ход стороны закрывается только когда закончили все её места: человек и бот.
     Пока человек не нажал «конец хода», сторона не передаёт ход — это и проверяем. */
  const human = sn.active === 'n' ? c1 : c2, mySeat = sn.active;
  assert.strictEqual(sn.waiting.length >= 1, true, 'кто-то ещё не закончил ход');
  assert((await act(human, { t: 'end' })).res.ok, 'человек закончил ход');
  /* проверяем именно дождавшийся снимок: боты другой стороны отыгрывают быстро
     и ход может успеть вернуться, поэтому текущее состояние тут не показатель */
  const flipped = await c1.wait(m => m.t === 'snap' && m.v.active !== mySeat, 30000);
  assert.notStrictEqual(flipped.v.active, mySeat, 'после всех командиров ход перешёл другой стороне');

  /* ---------- уборка: доигранные и брошенные комнаты уходят ---------- */
  const before = rooms.size;
  assert(before > 0, 'комнаты есть');
  for (const c of [c1, c2, c3]) c.ws.close();
  await new Promise(r => setTimeout(r, 300));
  const r22 = rooms.get(j1.room);
  assert(r22, 'комната пока жива — игрок может вернуться по коду');
  assert.strictEqual(r22.idle(), false, 'сразу после выхода комнату не убираем');
  assert.strictEqual(r22.timer, null, 'без клиентов таймер ботов остановлен');
  /* отматываем «пусто с» назад: недоигранную держим 15 минут */
  r22.emptySince = Date.now() - 16 * 60e3;
  assert.strictEqual(r22.idle(), true, 'пустая комната через 15 минут убирается');
  /* доигранную отпускаем через минуту */
  r22.engine.over = { w: 'n', t: 'тест' };
  r22.emptySince = Date.now() - 2 * 60e3;
  assert.strictEqual(r22.idle(), true, 'доигранная пустая комната убирается быстрее');
  r22.close();
  assert.strictEqual(r22.engine, null, 'close() отпускает партию');
  assert.strictEqual(r22.clients.size, 0, 'close() отпускает клиентов');
  console.log('команды и уборка: ok');

  for (const c of [a, p1, p2, sp, w]) c.ws.close();
  server.close();
  for (const r of rooms.values()) r.close();
  console.log('e2e: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1) });
