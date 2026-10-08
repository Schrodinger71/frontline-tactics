'use strict';
/* ============================================================
   КОМНАТА: одна пошаговая партия.
   Человек отдаёт действия в свой ход; ход бота считается сразу,
   а события уходят клиентам списком — клиент проигрывает их по
   очереди (движение по клеткам, бой, огонь). Следующий ход бота
   начинается после паузы на анимацию. В наблюдении (боты за обе
   стороны) пауза зависит от скорости, выбранной зрителем.
   События фильтруются туманом войны: чужое движение видно только
   по видимым клеткам, чужие бои — только рядом с видимым.
   ============================================================ */
const { Game } = require('../game/engine');
const { N, S, SIDE_NAME } = require('../shared/world');

const IDLE_MS = 15 * 60e3;

class Room {
  constructor(id, mode, side, vsBot, watch, map) {
    this.id = id; this.mode = mode;
    this.watch = !!watch; this.vsBot = !!vsBot || this.watch;
    this.engine = new Game(mode, side, undefined, map);
    this.engine.bots = watch ? { n: true, s: true } : vsBot ? { n: side !== N, s: side !== S } : { n: false, s: false };
    this.clients = new Set();
    this.emptySince = Date.now();
    this.pace = 1;            /* наблюдение: 1 — обычно, 2/4 — быстрее */
    this.timer = null;
    this.engine.tryStart();
    this.flush();
    this.kick();
  }

  seats() { const s = { n: 0, s: 0 }; for (const c of this.clients) if (c.side === N || c.side === S) s[c.side]++; return s }
  freeSide() {
    const s = this.seats();
    if (!this.engine.bots.n && !s.n) return N;
    if (!this.engine.bots.s && !s.s) return S;
    return null;
  }
  join(client, want) {
    if (want === 'spec' || this.watch) return this.joinAs(client, 'spec');
    let side = want === N || want === S ? want : null;
    const seats = this.seats();
    if (!side || this.engine.bots[side] || seats[side]) side = this.freeSide();
    if (!side) { client.send({ t: 'error', msg: 'В этой партии уже два игрока' }); return false }
    return this.joinAs(client, side);
  }
  joinAs(client, side) {
    client.room = this; client.side = side;
    this.clients.add(client);
    client.send({ t: 'joined', room: this.id, mode: this.mode, side, vsBot: this.vsBot, watch: this.watch, bots: this.engine.bots });
    client.send({ t: 'snap', v: this.engine.snapshotFor(side) });
    this.note(client, side === 'spec' ? null : `${SIDE_NAME[side]}: игрок подключился`);
    return true;
  }
  leave(client) {
    if (!this.clients.delete(client)) return;
    if (!this.clients.size) this.emptySince = Date.now();
    this.note(null, client.side && client.side !== 'spec' ? `${SIDE_NAME[client.side]}: игрок отключился` : null);
  }
  note(except, text) { for (const c of this.clients) c.send({ t: 'seats', seats: this.seats(), note: c === except ? null : text }) }

  /** действие стороны */
  act(client, id, a) {
    if (client.side !== N && client.side !== S) return client.send({ t: 'res', id, res: { ok: false, error: 'зритель не командует' } });
    let res;
    try { res = this.engine.act(client.side, a) } catch (e) { console.error(`[${this.id}]`, e); res = { ok: false, error: 'ошибка сервера' } }
    client.send({ t: 'res', id, res });
    this.flush();
    this.kick();
  }
  setPace(client, v) { if (client.side === 'spec' && this.watch && [1, 2, 4, 0].includes(+v)) { this.pace = +v; this.kick() } }

  /** если ходит бот — запустить его ход после паузы */
  kick(extra) {
    if (this.timer || this.engine.over) return;
    const g = this.engine;
    if (g.phase !== 'battle' || !g.bots[g.active]) return;
    if (this.watch && this.pace === 0) return;
    if (!this.watch && !this.clients.size) return;
    const delay = (extra || this.lastEvN || 0) * 260 / Math.max(1, this.pace) + (this.watch ? 700 / Math.max(1, this.pace) : 500);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { g.botTurn(g.active) } catch (e) { console.error(`[${this.id}] бот:`, e); try { g.act(g.active, { t: 'end' }) } catch (e2) { /* ход уже передан */ } }
      this.flush();
      this.kick();
    }, Math.min(12000, delay));
  }

  /** разослать события (с туманом войны) и снимки */
  flush() {
    const g = this.engine, evs = g.drainEvents();
    this.lastEvN = evs.filter(e => e.e !== 'log').length;
    for (const c of this.clients) {
      const list = evs.map(e => this.eventFor(c.side, e)).filter(Boolean);
      if (list.length) c.send({ t: 'ev', list });
      c.send({ t: 'snap', v: g.snapshotFor(c.side) });
    }
  }
  eventFor(side, e) {
    const g = this.engine;
    if (side === 'spec') return e;
    if (e.e === 'log') return e.to === '*' || e.to === side ? e : null;
    if (e.to !== '*' && e.to !== side) return null;
    const vis = g.vis[side], see = h => vis.has(h);
    switch (e.e) {
      case 'move': {
        if (e.side === side) return e;
        const path = e.path.filter(see);
        return path.length ? { ...e, path } : null;
      }
      case 'fight': return e.ah !== undefined && (see(e.ah) || see(e.dh)) ? e : null;
      case 'shell': return see(e.from) ? e : see(e.hex) ? { ...e, from: null } : null;
      case 'blast': case 'dead': case 'eng': case 'aa': return see(e.hex) || e.side === side ? e : null;
      case 'spawn': return e.to === side || see(e.hex) ? e : null;
      default: return e;
    }
  }
  idle() { return !this.clients.size && Date.now() - this.emptySince > IDLE_MS }
  close() { clearTimeout(this.timer) }
}

module.exports = { Room };
