'use strict';
/* ============================================================
   СЕРВЕР «FRONTLINE TACTICS»
   HTTP: раздаёт client/ и shared/. WebSocket (/ws): лобби и
   партии. Правила — в game/, у клиента — ввод и отрисовка.

   Протокол (JSON), клиент → сервер:
     { t:'create', mode, side, vsBot, watch, map }   новая партия на карте map (watch — боты за обе стороны)
     { t:'join', room, side?, spec? }            войти по коду (spec — зрителем)
     { t:'leave' }
     { t:'act', id, a:{ t, … } }                 действие: move · attack · bombard · air · eng · dig ·
                                                 ambush · buy · replace · sell · place · ready · end
     { t:'pace', value }                         скорость наблюдения: 0 (пауза) · 1 · 2 · 4
     { t:'save' }                                сохранить партию (игроку за столом) → { t:'saved', data, meta }
     { t:'load', data, seat?, side? }            новая партия из сохранения (data — сжатый снимок)
     { t:'seat', op:'add', side, who }           хозяин: новое место на стороне — 'bot' | 'open'
     { t:'seat', op:'who', id, who }             хозяин: свободное место — боту или открыть для игрока
   сервер → клиент:
     { t:'joined', room, mode, side, vsBot, watch, bots, host }
     { t:'snap', v }                             снимок стороны (game/views.js)
     { t:'ev', list }                            события хода — клиент проигрывает по очереди
     { t:'res', id, res }   { t:'seats', seats, note }   { t:'error', msg }
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');
const { N, S } = require('../shared/world');
const { SCEN } = require('../game/scenarios');
const { MAPS } = require('../shared/maps');
const { Game } = require('../game/engine');
const Save = require('../game/save');

const ROOT = path.join(__dirname, '..');
const STATIC = [['/shared/', path.join(ROOT, 'shared')], ['/', path.join(ROOT, 'client')]];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const MODES = ['defense', 'attack', 'both'].concat(Object.keys(SCEN));
const rooms = new Map();
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/* Ник приходит от клиента, поэтому чистим его здесь, а не доверяем вводу.
   Белый список: латиница, кириллица, цифры, пробел и - _ . Всё остальное
   вырезается, поэтому из ника не может получиться ни разметка, ни
   управляющие символы, ни «невидимки» (нулевой ширины, разделители строк) —
   независимо от того, как его потом отрисуют. Длина — 16 знаков. */
const NAME_MAX = 16;
const NAME_OK = /[^A-Za-z\u0410-\u044F\u0401\u04510-9 _.-]/g;
function cleanName(v) {
  if (typeof v !== 'string') return null;
  let s = v.slice(0, 200);
  try { s = s.normalize('NFC') } catch (e) { /* и без нормализации сойдёт */ }
  s = s.replace(NAME_OK, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || null;
}

/* защита от флуда: не больше комнат и соединений, создание партий и действия — не чаще предела */
const MAX_ROOMS = 200, MAX_CONN = 600;
function tooOften(client, key, n, ms) {
  const now = Date.now(), r = client[key] || (client[key] = { t: now, n: 0 });
  if (now - r.t > ms) { r.t = now; r.n = 0 }
  return ++r.n > n;
}
function canCreate(client) {
  if (tooOften(client, '_create', 3, 5000)) { client.send({ t: 'error', msg: 'Слишком часто — подождите пару секунд' }); return false }
  if (rooms.size >= MAX_ROOMS) { client.send({ t: 'error', msg: 'Сервер переполнен — попробуйте позже' }); return false }
  return true;
}
function newCode() { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += ABC[Math.random() * ABC.length | 0]; if (!rooms.has(c)) return c } }

function serveStatic(req, res) {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch (e) { res.writeHead(400); return res.end() }
  if (url === '/') url = '/index.html';
  /* нулевой байт роняет fs синхронно — отсекаем сразу */
  if (url.includes('\0')) { res.writeHead(400); return res.end() }
  for (const [prefix, dir] of STATIC) {
    if (!url.startsWith(prefix)) continue;
    const file = path.join(dir, url.slice(prefix.length));
    if (!file.startsWith(dir + path.sep)) break;
    try { return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Не найдено') }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    }) } catch (e) { res.writeHead(400); return res.end() }
  }
  res.writeHead(404); res.end('Не найдено');
}

function createServer() {
  const server = http.createServer(serveStatic);
  /* сообщения короткие, кроме загрузки сохранения (сжатый снимок партии) */
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: Save.MAX_PACKED + 4096 });
  wss.on('connection', ws => {
    if (wss.clients.size > MAX_CONN) return ws.close(1013, 'busy');
    const client = { room: null, side: null, seat: null, name: null, send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)) } };
    const leave = () => { if (client.room) client.room.leave(client); client.room = null; client.side = null };
    ws.on('message', raw => {
      /* длинным может быть только сообщение загрузки */
      if (raw.length > 8192 && !(raw.length <= Save.MAX_PACKED + 4096 && String(raw.subarray ? raw.subarray(0, 16) : raw).startsWith('{"t":"load"'))) return;
      let m;
      try { m = JSON.parse(raw) } catch (e) { return }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'create') {
        if (!MODES.includes(m.mode)) return client.send({ t: 'error', msg: 'Неизвестный режим' });
        if (!canCreate(client)) return;
        leave();
        const side = m.side === S ? S : N;
        const map = typeof m.map === 'string' && Object.prototype.hasOwnProperty.call(MAPS, m.map) ? m.map : 'valley';
        const room = new Room(newCode(), m.mode, side, !!m.vsBot, !!m.watch, map, m.seats);
        rooms.set(room.id, room);
        client.name = cleanName(m.name);
        room.join(client, m.watch ? 'spec' : side);
      } else if (m.t === 'join') {
        const room = rooms.get(String(m.room || '').toUpperCase());
        if (!room) return client.send({ t: 'error', msg: 'Партия не найдена: код неверный или она закрылась' });
        leave();
        client.name = cleanName(m.name);
        room.join(client, m.spec ? 'spec' : m.side);
      } else if (m.t === 'list') {
        /* список сетевых партий: сначала со свободными местами, внутри — свежие выше */
        if (tooOften(client, '_list', 6, 3000)) return;
        const list = [...rooms.values()].filter(r => r.listed()).map(r => r.info())
          .sort((a, b) => (b.free > 0) - (a.free > 0) || a.age - b.age).slice(0, 60);
        client.send({ t: 'rooms', list });
      } else if (m.t === 'leave') leave();
      else if (m.t === 'act') {
        if (!client.room) return client.send({ t: 'res', id: m.id, res: { ok: false, error: 'нет партии' } });
        if (tooOften(client, '_act', 40, 1000)) return client.send({ t: 'res', id: m.id, res: { ok: false, error: 'слишком часто' } });
        client.room.act(client, m.id, m.a);
      } else if (m.t === 'pace') { if (client.room) client.room.setPace(client, m.value) }
      else if (m.t === 'seat') { if (client.room) client.room.seatOp(client, m) }
      else if (m.t === 'save') {
        const room = client.room;
        if (!room || !room.engine || !client.seat || room.watch) return client.send({ t: 'error', msg: 'Сохранять может только игрок за столом' });
        if (tooOften(client, '_save', 4, 5000)) return client.send({ t: 'error', msg: 'Слишком часто — подождите пару секунд' });
        try {
          const g = room.engine, st = g.saveState();
          client.send({ t: 'saved', auto: !!m.auto, data: Save.pack(st), meta: {
            map: g.mapId, mode: g.mode, turn: g.turn, phase: g.phase, side: client.side, seat: client.seat, at: st.at, v: st.v,
            seats: g.seats.length, bots: g.seats.filter(x => room.slot.get(x.id) === 'bot').length, over: !!g.over
          } });
        } catch (e) { console.error(`[${room.id}] сохранение:`, e); client.send({ t: 'error', msg: 'Сохранить не удалось' }) }
      } else if (m.t === 'load') {
        if (!canCreate(client)) return;
        let g;
        try { g = Game.fromState(Save.unpack(m.data)) } catch (e) { return client.send({ t: 'error', msg: 'Сохранение повреждено или от другой игры' }) }
        leave();
        const room = new Room(newCode(), g.mode, N, true, false, g.mapId, null, { engine: g });
        rooms.set(room.id, room);
        client.name = cleanName(m.name);
        /* садимся на своё прежнее место, если оно людское; иначе — на любое свободное */
        const want = typeof m.seat === 'string' && g.seatById.has(m.seat) && room.slot.get(m.seat) !== 'bot' ? m.seat : null;
        const st = want ? g.seatById.get(want) : room.freeSeat(m.side === N || m.side === S ? m.side : null);
        if (st) room.joinAs(client, st.side, st.id); else room.join(client, 'spec');
      }
    });
    ws.on('close', leave);
    /* ошибки сокета (слишком большое сообщение, обрыв) — закрыть соединение, а не уронить сервер */
    ws.on('error', () => { try { ws.terminate() } catch (e) { /* уже закрыт */ } });
  });
  const sweep = setInterval(() => { for (const [id, r] of rooms) if (r.idle()) { r.close(); rooms.delete(id) } }, 30e3);
  server.on('close', () => { clearInterval(sweep); for (const r of rooms.values()) r.close(); rooms.clear(); wss.close() });
  return server;
}

module.exports = { createServer, rooms, cleanName };
if (require.main === module) {
  const port = Number(process.env.PORT) || 8082;
  createServer().listen(port, () => console.log('Frontline Tactics — http://localhost:' + port));
}
