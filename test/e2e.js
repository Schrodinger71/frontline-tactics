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
  await act(a, { t: 'ready' });
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
  await act(p1, { t: 'ready' }); await act(p2, { t: 'ready' });
  await p1.wait(m => m.t === 'snap' && m.v.phase === 'battle');
  assert(!(await act(p2, { t: 'end' })).res.ok, 'ход не в свою очередь');
  sp.send({ t: 'join', room: d.room, spec: true });
  assert.strictEqual((await sp.wait(m => m.t === 'joined')).side, 'spec');
  await sp.wait(m => m.t === 'snap');
  assert(sp.snap.units.some(u => u.side === 'n') && sp.snap.units.some(u => u.side === 's'), 'зритель видит обе стороны');
  assert(!(await act(sp, { t: 'end' })).res.ok, 'зритель не ходит');
  for (const u of p2.snap.units) if (u.side === 'n') assert(u.org === undefined, 'туман: чужая мораль скрыта');
  assert((await act(p1, { t: 'end' })).res.ok);
  await p2.wait(m => m.t === 'snap' && m.v.active === 's');

  /* наблюдение ботов */
  const w = client(port); await w.open;
  w.send({ t: 'create', mode: 'both', watch: true, map: 'lakes' });
  assert.strictEqual((await w.wait(m => m.t === 'joined')).side, 'spec');
  assert.strictEqual((await w.wait(m => m.t === 'snap')).v.map, 'lakes', 'карта на выбор');
  w.send({ t: 'pace', value: 4 });
  await w.wait(m => m.t === 'snap' && m.v.turn >= 1, 20000);

  for (const c of [a, p1, p2, sp, w]) c.ws.close();
  server.close();
  for (const r of rooms.values()) r.close();
  console.log('e2e: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1) });
