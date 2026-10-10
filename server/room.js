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
const { N, S, SIDE_NAME, MAX_SEATS } = require('../shared/world');

/* уборка комнат: пустую недоигранную держим 15 минут (игрок может вернуться
   по коду), пустую доигранную — минуту, этого хватит дочитать итог. */
const IDLE_MS = 15 * 60e3, OVER_MS = 60e3;

/** план мест: по стороне — список 'me' | 'open' | 'bot'. Из старых флагов строим 1 на 1. */
function planFrom(side, vsBot, watch, raw) {
  const clean = a => (Array.isArray(a) ? a : []).slice(0, MAX_SEATS)
    .map(x => x === 'bot' ? 'bot' : x === 'me' ? 'me' : 'open').filter(Boolean);
  if (raw && (clean(raw[N]).length || clean(raw[S]).length)) {
    const p = { [N]: clean(raw[N]), [S]: clean(raw[S]) };
    if (!p[N].length) p[N] = ['bot'];
    if (!p[S].length) p[S] = ['bot'];
    /* ровно одно место создателя: лишние 'me' становятся открытыми */
    let me = 0;
    for (const sd of [N, S]) p[sd] = p[sd].map(x => x === 'me' ? (me++ ? 'open' : 'me') : x);
    if (!me && !watch) p[side][0] = 'me';
    return p;
  }
  if (watch) return { [N]: ['bot'], [S]: ['bot'] };
  const other = side === N ? S : N;
  return { [side]: ['me'], [other]: [vsBot ? 'bot' : 'open'] };
}

class Room {
  /** pre — готовая партия из сохранения: { engine } (места-боты остаются ботами, людские — открыты) */
  constructor(id, mode, side, vsBot, watch, map, rawPlan, pre) {
    this.id = id; this.mode = mode;
    this.watch = !!watch;
    /* кто сидит на месте: 'bot' держит бот, 'open' ждёт человека */
    this.slot = new Map();
    if (pre && pre.engine) {
      this.engine = pre.engine;
      for (const st of this.engine.seats) this.slot.set(st.id, this.engine.bots[st.id] ? 'bot' : 'open');
    } else {
      const plan = planFrom(side, vsBot, this.watch, rawPlan);
      const teams = { [N]: plan[N].map(x => ({ bot: x === 'bot' })), [S]: plan[S].map(x => ({ bot: x === 'bot' })) };
      this.engine = new Game(mode, side, undefined, map, { teams });
      for (const sd of [N, S]) this.engine.seatsOf(sd).forEach((st, i) => this.slot.set(st.id, plan[sd][i] || 'open'));
    }
    /* хозяин партии — первый севший человек: он может менять состав по ходу игры */
    this.host = null;
    this.taken = new Map();   /* место → клиент */
    this.names = new Map();   /* место → ник игрока (уже очищенный на входе) */
    this.vsBot = this.watch || [...this.slot.values()].includes('bot');
    this.clients = new Set();
    this.emptySince = Date.now();
    this.created = Date.now();
    this.pace = 1;            /* наблюдение: 1 — обычно, 2/4 — быстрее */
    this.timer = null;
    this.engine.tryStart();
    this.flush();
    this.kick();
  }

  /** состав мест для клиентов: кто занят, кем и ждём ли кого-то */
  seats() {
    const g = this.engine;
    return g.seats.map(st => ({
      id: st.id, side: st.side, n: st.n,
      who: this.slot.get(st.id) === 'bot' ? 'bot' : this.taken.has(st.id) ? 'human' : 'open',
      name: this.names.get(st.id) || null,
      ready: !!g.ready[st.id], done: !!g.done[st.id]
    }));
  }
  /** Сетевая партия — создана с открытыми местами для других игроков.
      Одиночные партии против бота в общий список не попадают (их видно только
      по коду), законченные и брошенные — тоже: войти туда не к кому. */
  listed() {
    if (!this.engine || this.watch || this.engine.over) return false;   /* закрытая ещё может ждать уборки */
    if (![...this.slot.values()].includes('open')) return false;
    return [...this.clients].some(c => c.seat);
  }
  /** карточка партии для списка: без ников зрителей и без внутреннего состояния */
  info() {
    const g = this.engine, seats = this.seats();
    return {
      id: this.id, mode: this.mode, map: g.mapId, phase: g.phase, turn: g.turn, limit: g.limit,
      seats: seats.map(st => ({ side: st.side, who: st.who, name: st.who === 'human' ? st.name : null })),
      free: seats.filter(st => st.who === 'open').length,
      viewers: [...this.clients].filter(c => !c.seat).length,
      age: Math.round((Date.now() - this.created) / 1000)
    };
  }
  /** как звать того, кто на месте: ник, иначе «Командир N» */
  who(seat) {
    const st = this.engine.seatById.get(seat);
    return this.names.get(seat) || (st ? `Командир ${st.n}` : 'Командир');
  }
  /** свободное место для человека: сначала на желаемой стороне */
  freeSeat(want) {
    const open = st => this.slot.get(st.id) !== 'bot' && !this.taken.has(st.id);
    const order = want === N || want === S ? [want, want === N ? S : N] : [N, S];
    for (const sd of order) { const st = this.engine.seatsOf(sd).find(open); if (st) return st }
    return null;
  }
  join(client, want) {
    if (want === 'spec' || this.watch) return this.joinAs(client, 'spec', null);
    const st = this.freeSeat(want === N || want === S ? want : null);
    if (!st) { client.send({ t: 'error', msg: 'Свободных мест в этой партии нет' }); return false }
    return this.joinAs(client, st.side, st.id);
  }
  joinAs(client, side, seat) {
    client.room = this; client.side = side; client.seat = seat;
    if (seat) { this.taken.set(seat, client); if (client.name) this.names.set(seat, client.name) }
    if (seat && !this.host) this.host = client;
    this.clients.add(client);
    client.send({
      t: 'joined', room: this.id, mode: this.mode, side, seat, vsBot: this.vsBot, watch: this.watch,
      bots: this.engine.bots, seats: this.seats(), host: this.hostSeat()
    });
    client.send({ t: 'snap', v: this.engine.snapshotFor(seat || 'spec') });
    this.note(client, seat ? `${SIDE_NAME[side]}: ${this.who(seat)} подключился` : null);
    return true;
  }
  leave(client) {
    if (!this.clients.delete(client)) return;
    if (client.seat && this.taken.get(client.seat) === client) this.taken.delete(client.seat);
    if (this.host === client) this.host = [...this.clients].find(c => c.seat) || null;
    if (!this.clients.size) { this.emptySince = Date.now(); clearTimeout(this.timer); this.timer = null }
    if (client.seat) { this.note(null, `${SIDE_NAME[client.side]}: ${this.who(client.seat)} отключился`); this.names.delete(client.seat) }
    else this.note(null, null);
    client.seat = null;
    this.kick();
  }
  note(except, text) { for (const c of this.clients) c.send({ t: 'seats', seats: this.seats(), host: this.hostSeat(), note: c === except ? null : text }) }
  hostSeat() { return this.host && this.host.seat || null }

  /** Состав по ходу партии (только хозяин): добавить место игроку или боту,
      отдать свободное место боту или открыть его для человека. */
  seatOp(client, m) {
    const err = msg => client.send({ t: 'error', msg });
    if (!client.seat || client !== this.host) return err('Менять состав может только хозяин партии');
    if (this.watch || !this.engine || this.engine.over) return err('Состав этой партии не меняется');
    const who = m.who === 'bot' ? 'bot' : 'open';
    let text = '';
    if (m.op === 'add') {
      const side = m.side === N || m.side === S ? m.side : null;
      if (!side) return err('Нет такой стороны');
      const r = this.engine.addSeat(side, who === 'bot');
      if (!r.ok) return err(r.error);
      this.slot.set(r.id, who);
      text = `${SIDE_NAME[side]}: новое место — ${who === 'bot' ? 'бот' : 'ждём игрока'}`;
    } else if (m.op === 'who') {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!this.engine.seatById.has(id)) return err('Нет такого места');
      if (this.taken.has(id)) return err('Место занято игроком');
      if (this.slot.get(id) === who) return;
      this.slot.set(id, who);
      this.engine.setSeatBot(id, who === 'bot');
      text = `${SIDE_NAME[this.engine.sideOf(id)]}: место ${this.engine.seatById.get(id).n} — ${who === 'bot' ? 'теперь бот' : 'ждёт игрока'}`;
    } else return err('Неизвестная операция');
    this.vsBot = this.watch || [...this.slot.values()].includes('bot');
    this.note(null, text);
    this.flush();
    this.kick();
  }

  /** действие стороны */
  act(client, id, a) {
    if (!client.seat) return client.send({ t: 'res', id, res: { ok: false, error: 'зритель не командует' } });
    let res;
    try { res = this.engine.act(client.seat, a) } catch (e) { console.error(`[${this.id}]`, e); res = { ok: false, error: 'ошибка сервера' } }
    client.send({ t: 'res', id, res });
    this.flush();
    this.kick();
  }
  setPace(client, v) { if (client.side === 'spec' && this.watch && [1, 2, 4, 0].includes(+v)) { this.pace = +v; this.kick() } }

  /** если ходит бот — запустить его ход после паузы */
  /** места активной стороны, которые должен отыграть бот (включая брошенные людьми) */
  botSeats() {
    const g = this.engine;
    return g.seatsOf(g.active).filter(st => !g.done[st.id] && (this.slot.get(st.id) === 'bot' || !this.taken.has(st.id)));
  }
  kick(extra) {
    if (this.timer || this.engine.over) return;
    const g = this.engine;
    if (g.phase !== 'battle') return;
    const queue = this.botSeats();
    if (!queue.length) return;
    if (this.watch && this.pace === 0) return;
    /* некому смотреть — не считаем: раньше наблюдение продолжало крутиться впустую */
    if (!this.clients.size) return;
    const delay = (extra || this.lastEvN || 0) * 260 / Math.max(1, this.pace) + (this.watch ? 700 / Math.max(1, this.pace) : 500);
    this.timer = setTimeout(() => {
      this.timer = null;
      const st = this.botSeats()[0];
      if (st) {
        try { g.botTurn(st.id) } catch (e) {
          console.error(`[${this.id}] бот ${st.id}:`, e);
          try { g.act(st.id, { t: 'end' }) } catch (e2) { /* ход уже передан */ }
        }
      }
      this.flush();
      this.kick();
    }, Math.min(12000, delay));
  }

  /** разослать события (с туманом войны) и снимки */
  flush() {
    const g = this.engine, evs = g.drainEvents();
    this.lastEvN = evs.filter(e => e.e !== 'log').length;
    for (const c of this.clients) {
      const list = evs.map(e => this.eventFor(c.seat ? c.side : 'spec', e)).filter(Boolean);
      if (list.length) c.send({ t: 'ev', list });
      c.send({ t: 'snap', v: g.snapshotFor(c.seat || 'spec') });
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
  idle() {
    if (this.clients.size) return false;
    return Date.now() - this.emptySince > (this.engine && this.engine.over ? OVER_MS : IDLE_MS);
  }
  close() {
    clearTimeout(this.timer); this.timer = null;
    /* отпускаем партию и ссылки на клиентов — комнату уже удалили из реестра */
    this.clients.clear(); this.taken.clear(); this.names.clear();
    this.engine = null;
  }
}

module.exports = { Room };
