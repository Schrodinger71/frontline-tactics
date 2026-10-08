'use strict';
/* ============================================================
   FRONTLINE TACTICS — клиент.
   Правила и бот — на сервере (game/). Здесь: сеть, панели, ввод,
   подсветка ходов по тем же правилам (shared/rules.js) и
   проигрывание событий хода (js/map.js).

   Управление: ЛКМ по своей части — выбрать; по подсвеченной
   клетке — идти; по цели с шансами — атаковать (артиллерия —
   огонь). ПКМ — снять выбор. Tab — следующая часть с
   действиями, D — окопаться, Enter — конец хода. Колесо —
   масштаб, перетаскивание ПКМ/СКМ или стрелки — карта.
   ============================================================ */

const MODE_LABEL = { defense: 'Оборона', attack: 'Наступление', both: 'Встречный бой' };
const ROLE_LABEL = { attacker: 'наступление', defender: 'оборона', both: 'равные силы' };
const $ = q => document.querySelector(q);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const G = {
  roomId: null, side: null, spec: false, watch: false, vsBot: true, phase: null,
  units: [], ghosts: [], pts: [], vis: null, supply: null, br: [], mines: [], frontY: [],
  turn: 0, active: null, clock: '06:00', day: 1, night: false, weather: 'clear', budget: 0, income: 0, air: null, score: 0,
  scen: null, stats: null, enemyStats: null, history: [], commanders: null, role: null, over: null, limit: 30,
  mapId: null, forts: [], obst: [], cp: 0, barrage: false, smoke: [], dist: null, districts: null, mapPick: (() => { try { return localStorage.getItem('turn.map') || 'valley' } catch (e) { return 'valley' } })(),
  sel: null, reach: null, targets: [], hover: -1, mode: null, deploy: null, isMyTurn: false,
  view: { x: 150, y: 220, s: 5 }, pace: 1, showSupply: false, showTypes: false, visV: 0, selRiv: '', mouse: null, speed: 1, pendingSnap: null, tabR: 'unit', tabL: 'log', _overShown: false
};
function nightK() { return G.night ? 1 : 0 }
const selUnit = () => G.units.find(u => u.id === G.sel);
const myUnit = u => u && !G.spec && u.side === G.side;

/* ---------- сеть ---------- */
let ws = null, wsRetry = 0, queue = [], seq = 0;
function netConnect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
  ws.onopen = () => { wsRetry = 0; const q = queue; queue = []; q.forEach(netSend) };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data) } catch (err) { return } onMsg(m) };
  ws.onclose = () => setTimeout(netConnect, Math.min(5000, 400 * Math.pow(1.7, wsRetry++)));
}
function netSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else { queue.push(o); if (!ws || ws.readyState === 3) netConnect() } }
function act(a) { netSend({ t: 'act', id: ++seq, a }) }

function onMsg(m) {
  if (m.t === 'joined') return onJoined(m);
  if (m.t === 'snap') {
    /* вкладка скрыта — анимации не идут: показываем итог сразу */
    if (document.hidden || G.first) { skipAnims(); applySnapshot(m.v) }
    else if (animBusy()) { G.pendingSnap = m.v; G.pendingAt = G.pendingAt || performance.now() }
    else applySnapshot(m.v);
    return;
  }
  if (m.t === 'ev') { for (const e of m.list) { if (e.e === 'log') radio(e); else playEvent(e) } return }
  if (m.t === 'res') { if (m.res && !m.res.ok && m.res.error) toast(m.res.error); return }
  if (m.t === 'seats') { if (Array.isArray(m.seats)) G.lobby = m.seats; if (m.note) toast(m.note); renderLobby(); return }
  if (m.t === 'error') { toast(m.msg); if (!G.roomId) showMenu() }
}
function onJoined(m) {
  Object.assign(G, { roomId: m.room, side: m.side === 'spec' ? N : m.side, spec: m.side === 'spec', watch: !!m.watch, vsBot: m.vsBot, sel: null, mode: null, over: null, _overShown: false, units: [], first: true });
  ANIMS.q.length = 0; ANIMS.cur = null; ANIMS.pos.clear(); ANIMS.hidden.clear(); marksReset();
  document.body.classList.toggle('spec', G.spec);
  $('#paceBox').hidden = !G.watch;
  $('#lc_log').innerHTML = '';
  $('#hdRoomBox').style.display = G.vsBot && !G.spec ? 'none' : '';
  $('#hdRoom').textContent = m.room;
  G.mySeat = m.seat || null;
  G.lobby = Array.isArray(m.seats) ? m.seats : [];
  /* лобби показываем, пока ждём живых игроков */
  G.lobbyHidden = !G.lobby.some(x => x.who === 'open');
  hideMenu(); hideModal(); renderLobby();
}
/* ---------- лобби: кто на каком месте ---------- */
function lobbyHTML() {
  const list = G.lobby || [];
  if (!list.length) return '';
  const side = sd => {
    const rows = list.filter(x => x.side === sd).map(x => {
      const mine = x.id === G.mySeat;
      const who = x.who === 'bot' ? '<i class="lb bot">бот</i>'
        : x.who === 'open' ? '<i class="lb open">ждём игрока</i>'
        : `<b>${esc(x.name || 'Командир ' + x.n)}</b>${mine ? '<i class="lb me">вы</i>' : ''}`;
      const st = x.who === 'open' ? '' : x.ready ? '<span class="good">готов</span>' : '<span class="mu">расставляет</span>';
      return `<tr class="${mine ? 'on' : ''}"><td>${x.n}</td><td>${who}</td><td>${st}</td></tr>`;
    }).join('');
    return `<div class="lcol"><div class="lhd" style="color:${COL[sd]}">${esc(SIDE_NAME[sd])}</div>
      <table class="ltab">${rows}</table></div>`;
  };
  const open = list.filter(x => x.who === 'open').length;
  return `<div class="lbox">
    <h2>Партия ${esc(G.roomId || '')}</h2>
    <p class="mu">${open ? `Ждём игроков: ${open}. Передайте им код — кнопка «Войти» в меню.` : 'Все места заняты.'}</p>
    <div class="lcols">${side(N)}${side(S)}</div>
    <p class="acts"><button class="btn pri" id="btnLobbyClose">К расстановке</button></p></div>`;
}
function renderLobby() {
  const el = $('#lobby');
  if (!el) return;
  const show = !!G.roomId && !G.spec && G.phase === 'deploy' && !G.lobbyHidden && (G.lobby || []).length > 1;
  el.hidden = !show;
  if (show) el.innerHTML = lobbyHTML();
}

function skipAnims() { ANIMS.q.length = 0; ANIMS.cur = null; ANIMS.pos.clear(); G.pendingAt = 0 }
function applySnapshot(v) {
  G.pendingAt = 0;
  /* готовность мест приходит в снимке, ники — в сообщении seats: сводим вместе */
  if (Array.isArray(v.seats) && (G.lobby || []).length) {
    const by = new Map(v.seats.map(x => [x.id, x]));
    G.lobby = G.lobby.map(x => Object.assign({}, x, by.get(x.id) ? { ready: by.get(x.id).ready, done: by.get(x.id).done } : {}));
  } else if (Array.isArray(v.seats) && !(G.lobby || []).length) G.lobby = v.seats;
  if (v.seat) G.mySeat = v.seat;
  G.waiting = v.waiting || [];
  Object.assign(G, {
    phase: v.phase, units: v.units, ghosts: v.ghosts, pts: v.pts, vis: v.vis ? new Set(v.vis) : null, supply: v.supply ? new Set(v.supply) : null,
    mapId: v.map, forts: v.forts, obst: v.obst, cp: v.cp, barrage: v.barrage, counter: v.counter, smoke: v.smoke || [], districts: v.districts,
    dist: v.dist ? (() => { const m = new Map(); for (let i = 0; i < v.dist.length; i += 2) m.set(v.dist[i], v.dist[i + 1]); return m })() : null,
    br: v.br, mines: v.mines, frontY: v.frontY, turn: v.turn, active: v.active, clock: v.clock, day: v.day, night: v.night, weather: v.weather,
    budget: v.budget, income: v.income, air: v.air, score: v.score, scen: v.scen, stats: v.stats, enemyStats: v.enemyStats, history: v.history,
    commanders: v.commanders, role: v.role, over: v.over, limit: v.limit, mode0: v.mode, ready: v.ready
  });
  ANIMS.hidden.clear(); ANIMS.pos.clear();
  G.visV++;
  G.isMyTurn = !G.spec && G.phase === 'battle' && G.active === G.side && !G.over;
  G.deploy = G.phase === 'deploy' && !G.spec ? deployHexes() : null;
  G.spawn = G.mode && /^(buy:|ord:reserve)/.test(G.mode) ? spawnHexes(G.mode === 'ord:reserve' ? 'mot' : G.mode.slice(4)) : null;
  if (G.first) { G.first = false; marksReset(); firstView(); if (G.scen && !G.spec) showBrief(); else if (!G.spec && !localStorage.getItem('turn.help')) { showHelp(); try { localStorage.setItem('turn.help', 1) } catch (e) { /* приватный режим */ } } }
  if (G.sel && !G.units.some(u => u.id === G.sel)) G.sel = null;
  computeSel();
  renderUI(true);
  renderLobby();
  if (G.over && !G._overShown) { G._overShown = true; setTimeout(showEnd, 700) }
}
function firstView() {
  const own = G.units.filter(u => G.spec || u.side === G.side);
  let x = WW / 2, y = WH / 2;
  if (G.phase === 'deploy' && !G.spec && G.deploy && G.deploy.length) { const cs = G.deploy.map(h => Hex.center(h)); x = cs.reduce((a, c) => a + c.x, 0) / cs.length; y = WH / 2 }
  else if (own.length) { const cs = own.map(u => Hex.center(u.hex)); x = cs.reduce((a, c) => a + c.x, 0) / cs.length; y = cs.reduce((a, c) => a + c.y, 0) / cs.length }
  const s = G.spec ? sMin() : clamp(S_WORK() * .8, sMin(), S_MAX);
  G.view.x = x; G.view.y = y; G.view.s = s; clampView();
  CAM.x = G.view.x; CAM.y = G.view.y; CAM.s = G.view.s; CAM.ax = null; CAM.moving = false;
}
function deployHexes() {
  const md = MAPS[G.mapId] || {}, z = G.scen ? G.scen.deploy : md.deploy ? md.deploy[G.side] : DEPLOY_X[G.side], out = [], hx = Hex.build(G.mapId).hexes;
  for (let h = 0; h < Hex.NH; h++) { const x = Hex.center(h).x; if (z && x >= z[0] && x <= z[1] && hx[h].t !== 'lake') out.push(h) }
  return out;
}

/** клетки для подкреплений: свои точки и соседние с ними, свободные, без противника рядом */
function spawnHexes(k) {
  if (G.phase !== 'battle' || G.spec) return null;
  const hx = Hex.build(G.mapId).hexes, occ = new Map(G.units.map(u => [u.hex, u])), out = new Set();
  const enemyAt = h => { const o = occ.get(h); return o && o.side !== G.side };
  for (const p of G.pts) {
    if (p.owner !== G.side) continue;
    for (const h of Hex.within(p.hex, 1)) {
      if (out.has(h) || occ.has(h) || hx[h].t === 'lake' || (hx[h].t === 'mount' && UT[k].cls !== 'foot' && !hx[h].road)) continue;
      if (h !== p.hex && enemyAt(p.hex)) continue;
      if (Hex.neighbors(h).some(enemyAt)) continue;
      out.add(h);
    }
  }
  return out;
}

/* ---------- правила на клиенте: что видно стороне ---------- */
function clientCtx() {
  const occ = new Map();
  for (const u of G.units) occ.set(u.hex, u);
  const cmd = new Set();
  for (const h of G.units) if (h.k === 'hq' && h.side === G.side) for (const x of Hex.within(h.hex, UT.hq.cmd)) cmd.add(x);
  const mines = new Map(); for (const m of G.mines || []) mines.set(m.hex, { side: m.side });
  const wx = wxById(G.weather);
  const support = { n: new Set(), s: new Set() };
  for (const u of G.units) if (u.support && UT[u.k].bomb) for (const h of Hex.within(u.hex, UT[u.k].bomb.rng)) support[u.side].add(h);
  return { map: Hex.build(G.mapId), br: new Map(G.br || []), occ, mines, forts: new Map(G.forts || []), obst: new Set(G.obst || []), support, smoke: new Set(G.smoke || []), side: G.side, mud: wx.mud < .8, night: G.night, acc: wx.acc || 1, cmd, counter: G.counter && !G.spec ? new Set([].concat(...G.pts.filter(p => p.home === G.side).map(p => Hex.within(p.hex, 1)))) : null };
}
function computeSel() {
  G.reach = null; G.targets = []; G.selRiv = '';
  const u = selUnit();
  if (!u || !myUnit(u) || !G.isMyTurn) return;
  const ctx = clientCtx(), T = utFor(u.side)[u.k];
  if (u.mp > 0 && !(u.acted && T.bomb)) { G.reach = Rules.reachable(ctx, u); G.selRiv = 'r' }
  if (u.acted || u.sp <= 0) return;
  /* о противнике мораль и опыт не известны — для расчёта берём типичные */
  const foes = G.units.filter(e => e.side !== G.side).map(e => ({ ...e, org: e.org ?? 80, xp: e.xp ?? .2 }));
  if (T.bomb) {
    if (u.reload > 0) return;
    for (const e of foes) if (Hex.hexDist(u.hex, e.hex) <= T.bomb.rng) {
      const b = Rules.bombardOdds(ctx, T.bomb.pow * u.str / MAX_STR * (.85 + .3 * u.xp), e, { th: T.th, barrage: !!G.barrage, sp: u.sp });
      G.targets.push({ hex: e.hex, id: e.id, lb: `огонь −${b.loss[0]}…${b.loss[1]}`, col: '#ffb070', bomb: b });
    }
  } else if (T.atk.soft >= 2 && u.k !== 'hq' && u.org >= 20) {
    for (const e of foes) if (Hex.hexDist(u.hex, e.hex) === 1) {
      const o = Rules.odds(ctx, u, e);
      G.targets.push({ hex: e.hex, id: e.id, lb: o.r.toFixed(1).replace('.', ',') + ' : 1', col: o.r >= 2 ? '#6fd18d' : o.r >= 1.2 ? '#ffd479' : '#ff6b55', odds: o });
    }
  }
}

/* ---------- эфир ---------- */
function radio(e) {
  const box = $('#lc_log'), ln = document.createElement('div');
  ln.className = 'ln ' + (e.cls || '');
  const tag = G.spec && e.to !== '*' ? `<span class="sd ${e.to}">${e.to === N ? 'З' : 'В'}</span>` : '';
  ln.innerHTML = `<span class="tm">${turnClock(e.turn)}</span>${tag}${e.cs ? `<span class="who">«${esc(e.cs)}»</span> ` : e.cls === 'hq' || !e.cs ? '<span class="who hq">ШТАБ</span> ' : ''}${esc(e.text)}`;
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.appendChild(ln);
  while (box.children.length > 250) box.removeChild(box.firstChild);
  if (stick) box.scrollTop = box.scrollHeight;
  Sound.radio(e.cls);
  if (e.cls === 'crit' && !G.spec && e.to === G.side) toast(e.text);
}
let toastT = 0;
/** всплывающие сообщения складываются стопкой, одинаковые не дублируются */
function toast(t, kind) {
  const box = $('#toast');
  if ([...box.children].some(d => d.textContent === t)) return;
  const d = document.createElement('div'); d.textContent = t; d.className = kind || '';
  box.appendChild(d);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => { d.classList.add('out'); setTimeout(() => d.remove(), 300) }, 2800);
}
function hint(t) { const el = $('#hintbar'); el.style.display = t ? 'block' : 'none'; el.textContent = t || '' }

/* ---------- верхняя строка и панели ---------- */
function renderTop() {
  if (!G.roomId) return;
  $('#hdClock').textContent = G.clock;
  $('#hdTurn').textContent = (G.turn + 1) + (G.scen ? ' из ' + G.limit : ' из ' + G.limit);
  $('#hdDay').textContent = G.day + (G.night ? ' · ночь' : '');
  $('#hdWeather').textContent = (wxById(G.weather) || {}).n || '—';
  if (G.scen) {
    $('#hdScoreLbl').textContent = 'Задача';
    $('#hdScore').textContent = `${G.scen.left} ход.` + (G.scen.raid !== null ? ` · ${G.scen.raid}%` : '');
  } else {
    const mine = (G.spec || G.side === N) ? G.score : -G.score;
    /* темп за ход: без него игрок видит только число и не понимает, что оно копится */
    const h = G.history || [];
    const raw = h.length >= 2 ? h[h.length - 1].s - h[h.length - 2].s : 0;
    const per = (G.spec || G.side === N) ? raw : -raw;
    $('#hdScoreLbl').textContent = 'Перевес';
    $('#hdScore').textContent = (mine > 0 ? '+' : '') + Math.round(mine) + ' из 100'
      + (Math.abs(per) >= .5 ? `  (${per > 0 ? '+' : ''}${Math.round(per)}/ход)` : '');
    $('#hdScore').className = mine > 3 ? 'good' : mine < -3 ? 'bad' : '';
    $('#hdScore').parentNode.title = 'Перевес — счёт операции. Каждый ход он смещается на разницу весов удержанных вами и противником точек: '
      + 'держите больше и крупнее городов — растёт в вашу пользу. Кто первым дойдёт до 100, тот победил; на последнем ходу выигрывает тот, кто впереди.'
      + (Math.abs(per) >= .5 ? `\nСейчас ${per > 0 ? 'в вашу пользу' : 'против вас'} ${Math.abs(Math.round(per))} за ход.` : '\nСейчас по точкам равенство — перевес не двигается.');
  }
  $('#hdBudget').textContent = G.spec ? `${G.budget.n} · ${G.budget.s}` : G.budget;
  $('#hdIncome').textContent = G.spec ? `+${G.income.n} · +${G.income.s}` : '+' + G.income;
  $('#hdCp').textContent = G.spec ? `${(G.cp || {}).n || 0} · ${(G.cp || {}).s || 0}` : `${G.cp || 0} из ${CP.max}`;
  const who = G.phase === 'deploy' ? 'Расстановка' : G.over ? 'Итог' : G.spec ? 'Ходит ' + SIDE_GEN[G.active] : G.isMyTurn ? 'Ваш ход' : 'Ход противника…';
  $('#hdActive').textContent = who;
  $('#hdActive').className = G.isMyTurn || G.phase === 'deploy' ? 'ac' : 'mu';
  const btn = $('#btnEnd');
  btn.hidden = G.spec || !!G.over;
  if (G.phase === 'deploy') { btn.textContent = G.ready && G.ready[G.side] ? 'Ждём соперника…' : 'Готов к бою'; btn.disabled = !!(G.ready && G.ready[G.side]) }
  else { const left = G.units.filter(u => myUnit(u) && (u.mp > 0 || !u.acted)).length; btn.textContent = G.isMyTurn ? `Конец хода${left ? ' (' + left + ')' : ''}` : 'Ход противника'; btn.disabled = !G.isMyTurn }
  const air = !G.spec && G.air && G.phase === 'battle';
  $('#airBox').hidden = !air;
  if (air) { $('#btnStrike').textContent = `✈ Удар ${G.air.strike}`; $('#btnRecon').textContent = `👁 Разведка ${G.air.recon}`; $('#btnStrike').disabled = !G.isMyTurn || !G.air.strike; $('#btnRecon').disabled = !G.isMyTurn || !G.air.recon; $('#btnStrike').classList.toggle('on', G.mode === 'air:strike'); $('#btnRecon').classList.toggle('on', G.mode === 'air:recon') }
}
function bar(label, v, max, col, txt) {
  const k = clamp(v / max, 0, 1);
  return `<div class="row"><span>${label}</span><b>${txt != null ? txt : Math.round(k * 100) + '%'}</b></div><div class="bar"><div style="width:${k * 100}%;background:${col}"></div></div>`;
}
function unitCard(u) {
  const T = utFor(u.side)[u.k], own = myUnit(u) || G.spec, hx = Hex.build(G.mapId).hexes[u.hex], fort = new Map(G.forts || []).get(u.hex);
  const head = `<div class="uhead">${iconHTML(u.k, 'ic big', own && !(G.spec && u.side === S) ? 'own' : 'enemy')}<div><h3>${u.cs ? '«' + esc(u.cs) + '»' : esc(T.sh)}</h3><div class="sub">${esc(T.n)}</div>
    ${G.spec ? `<div class="sub ${u.side === N ? 'sdn' : 'sds'}">${SIDE_NAME[u.side]}</div>` : ''}</div></div>`;
  if (!own) return `<div class="card">${head}
    ${bar('Сила', u.str, MAX_STR, u.str <= 3 ? 'var(--rd)' : 'var(--ac)', u.str + ' из 10 · ' + elCount(u.k, u.str) + ' ' + T.eln)}
    <div class="row"><span>Запасы</span><b>${pips(u.sp)}</b></div>${u.hold ? '<p class="ustate"><span class="ac">стоит насмерть — не отходит</span></p>' : ''}${u.mil ? '<p class="ustate">ополчение</p>' : ''}
    <div class="row"><span>Местность</span><b>${Rules.TNAME[hx.t]}, ${Math.round(hx.h)} м${u.ent ? ', окоп ' + u.ent : ''}</b></div>
    ${u.hb ? '<p class="ustate"><span class="good">связан боем — атака другим родом войск ×1,15</span></p>' : ''}
    <p class="hint">${esc(ROLE_TXT[u.k])}</p></div>`;
  const acts = [];
  if (G.phase === 'deploy' && !G.spec) { if (!u.pre) acts.push(`<button class="btn sm" data-a="sell">Вернуть (+${T.price})</button>`); acts.push('<span class="hint">Клик по клетке зоны — переставить.</span>') }
  else if (G.isMyTurn && myUnit(u)) {
    if (!u.acted && !u.moved) acts.push('<button class="btn sm" data-a="dig">Окопаться <kbd>D</kbd></button>');
    if (!u.acted && !T.bomb && T.atk.soft >= 2 && u.k !== 'hq') acts.push('<button class="btn sm" data-a="ambush" title="Часть не действует, а в ход противника встречает огнём того, кто войдёт рядом">Засада <kbd>A</kbd></button>');
    if (u.str < MAX_STR && !u.acted && !u.moved) acts.push(`<button class="btn sm" data-a="replace">Пополнить (${Math.round(T.price / 10)} за шаг)</button>`);
    const ob = (k, ok, why) => { const O = ORDERS[k]; acts.push(`<button class="btn sm" data-a="ord:${k}" ${ok && G.cp >= O.cp ? '' : 'disabled'} title="${esc(O.d)}${why ? ' — ' + esc(why) : ''}">${esc(O.n)} · ${O.cp}★</button>`) };
    ob('march', !u.acted && !u.march && u.sp > 0);
    ob('hold', !u.hold);
    if (u.sp < SUPPLY.max) ob('airdrop', wxById(G.weather).fly);
    if (T.eng && !u.acted) acts.push('<button class="btn sm" data-a="eng:fort">Укрепления…</button><button class="btn sm" data-a="eng:obst">Заграждения…</button><button class="btn sm" data-a="eng:mine">Мины…</button><button class="btn sm" data-a="eng:bridge">Понтон…</button><button class="btn sm" data-a="eng:blow">Взорвать мост…</button><button class="btn sm" data-a="eng:repair">Восстановить мост…</button><button class="btn sm" data-a="eng:clear">Разминировать…</button>');
  }
  const st = [];
  if (!u.supplied) st.push(`<span class="bad">в котле${u.cut ? ' ' + u.cut + ' х.' : ''}</span>`);
  else if (u.over) st.push('<span class="ac">округ перегружен — запас не выше 2</span>');
  if (u.sp <= 0) st.push('<span class="bad">запасы кончились — не атакует, тает</span>');
  if (u.hold) st.push('<span class="ac">стоять насмерть</span>');
  if (u.march) st.push('форсированный марш');
  if (u.exploit) st.push('<span class="good">прорыв — может действовать ещё</span>');
  if (u.mil) st.push('ополчение');
  if (u.sup) st.push('<span class="ac">подавлены</span>');
  if (u.org < 20) st.push('<span class="bad">дезорганизованы — не атакуют</span>');
  if (u.reload > 0) st.push('перезарядка');
  if (u.amb) st.push('<span class="good">в засаде</span>');
  if (u.support) st.push('<span class="ac">огонь поддержки готов</span>');
  return `<div class="card">${head}
    ${st.length ? `<p class="ustate">${st.join(' · ')}</p>` : ''}
    ${bar('Сила', u.str, MAX_STR, u.str <= 3 ? 'var(--rd)' : u.str <= 6 ? 'var(--ac)' : 'var(--gn)', u.str + ' из 10 · ' + elCount(u.k, u.str) + ' ' + T.eln)}
    ${bar('Мораль', u.org, 100, u.org < 30 ? 'var(--rd)' : '#8fb8ff')}
    <div class="row"><span>Запасы (боеприпасы, топливо)</span><b>${pips(u.sp)}</b></div>
    ${G.phase === 'battle' ? bar('Очки хода', u.mp, T.mp, 'var(--bl)', `${u.mp} из ${T.mp}${u.acted ? ' · действие сделано' : ''}`) : ''}
    <div class="row"><span>Атака (пех/лёг/танки)</span><b>${T.atk.soft} / ${T.atk.light} / ${T.atk.hard}</b></div>
    <div class="row"><span>Оборона</span><b>${T.def}</b></div>
    ${T.bomb ? `<div class="row"><span>Огонь</span><b>${T.bomb.pow} на ${T.bomb.rng} кл.${T.bomb.area ? ', по площади' : ''}</b></div>` : ''}
    <div class="row"><span>Местность · окоп</span><b>${Rules.TNAME[hx.t]}, ${Math.round(hx.h)} м · ${u.ent || 0}${fort ? ' · укрепления ' + fort : ''}</b></div>
    <div class="row"><span>Опыт</span><b>${u.xp >= .6 ? 'ветераны' : u.xp >= .3 ? 'обстрелянные' : 'необстрелянные'} ${'★'.repeat(1 + Math.floor(u.xp * 2.99))}</b></div>
    ${T.eng ? `<div class="row"><span>Мин в запасе</span><b>${u.mines}</b></div>` : ''}
    <div class="row"><span>Командир</span><b>${esc(u.trait || '—')}</b></div>
    <p class="hint">${esc(ROLE_TXT[u.k])}</p>
    <div class="acts">${acts.join('')}</div></div>`;
}
function pips(sp) {
  if (sp === undefined) return '—';
  return `<span class="pips ${sp <= 0 ? 'crit' : sp === 1 ? 'crit' : sp === 2 ? 'lo' : ''}">${[0, 1, 2].map(i => `<i class="${i < sp ? 'on' : ''}"></i>`).join('')}</span> ${sp} из ${SUPPLY.max}`;
}
function renderOrders() {
  const can = G.isMyTurn;
  const sel = selUnit();
  $('#rc').innerHTML = `<div class="card"><h3>Приказы штаба <span class="mu">· ${G.spec ? '' : G.cp + ' из ' + CP.max} ★</span></h3>
    <p class="hint">Командные очки копятся каждый ход: +${CP.per}, со штабом ещё +${CP.hq}; трофейные склады — +1. Приказы на часть — выберите её и нажмите, приказ на клетку — кликните по карте.</p>
    ${G.barrage ? '<p class="ustate"><span class="ac">Артподготовка идёт: огонь ×1,5</span></p>' : ''}
    ${G.counter && !G.spec ? '<p class="ustate"><span class="ac">Контрудар: атаки у исходных точек ×1,3</span></p>' : ''}
    <div class="ords">${ORDER_LIST.map(k => { const O = ORDERS[k], off = !can || G.cp < O.cp || (k === 'barrage' && G.barrage) || (k === 'counter' && (G.counter || !G.pts.some(p => p.home === G.side && p.owner !== G.side))) || (O.tgt === 'unit' && !(sel && myUnit(sel)));
      return `<div class="ord ${off ? 'off' : ''} ${G.mode === 'ord:' + k ? 'on' : ''}" data-ord="${k}"><div class="snm"><b>${esc(O.n)}</b><span>${esc(O.d)}${O.tgt === 'unit' ? ' · <i>на выбранную часть</i>' : O.tgt === 'hex' ? ' · <i>на клетку</i>' : ''}</span></div><div class="cpc">${O.cp}★</div></div>` }).join('')}</div>
    ${sel && myUnit(sel) ? `<p class="hint">Выбрана: «${esc(sel.cs)}» (${esc(UT[sel.k].sh)}).</p>` : ''}
    <div class="lbl">Снабжение</div>
    <p class="hint">Округа снабжения — от ваших городов (вместимость и дальность по весу города) и от тыла. Часть в котле теряет деление запаса за ход: за три хода — без боеприпасов и топлива, дальше тает и сдаётся. Перегруженный округ держит запас не выше 2.</p>
    ${(G.districts || []).map(d => `<div class="row"><span>${esc(d.n)}</span><b class="${d.used > d.cap ? 'bad' : ''}">${d.cap >= 99 ? d.used + ' ч.' : d.used + ' из ' + d.cap}</b></div>`).join('')}
    <div class="acts"><button class="btn sm ${G.showSupply ? 'on' : ''}" data-a="supply">Округа на карте <kbd>S</kbd></button></div></div>`;
}
function renderUnit() {
  const u = selUnit();
  if (u) { $('#rc').innerHTML = unitCard(u); return }
  $('#rc').innerHTML = `<div class="card"><h3>${G.phase === 'deploy' ? 'Расстановка' : 'Приказы'}</h3>
    <p class="hint">${G.phase === 'deploy' ? 'Купите части во вкладке «Закупка» и кликните по клетке в своей зоне (подсвечена). Свою часть можно переставить: выберите её и кликните по клетке.'
      : `<b>ЛКМ</b> по своей части — выбрать. Голубые клетки — куда она дойдёт; цифры на противнике — <b>соотношение сил</b> (зелёное — выгодно).
      Наведите на цель — подробный расчёт. Клик — атака. <b>Tab</b> — следующая часть, <b>Enter</b> — конец хода.`}</p>
    <div class="lbl">Главное</div>
    <p class="hint">Рядом с противником — его <b>зона контроля</b>: вошёл — остановился. Атакуйте <b>несколькими частями</b> с разных сторон — охват.
    Артиллерия подавляет перед атакой. Части без <b>снабжения</b> (красный «!») слабеют и тают. Стоящие на месте окапываются.</p></div>`;
}
function renderBuy() {
  const deploy = G.phase === 'deploy';
  $('#rc').innerHTML = `<div class="card"><h3>Закупка <span class="mu">· ${G.spec ? '' : G.budget} очк.</span></h3>
    <p class="hint">${deploy ? 'Выберите тип и кликните по клетке в зоне расстановки.' : 'Подкрепления — в своём городе или узле либо на соседней с ним клетке (подсвечены), без противника рядом. Прибывают без хода.'}</p>
    <div class="shop">${unitsFor(G.spec ? N : G.side).map(k => { const T = utFor(G.spec ? N : G.side)[k], off = G.budget < T.price;
      return `<div class="shopItem ${off ? 'off' : ''} ${G.mode === 'buy:' + k ? 'on' : ''}" data-buy="${k}">${iconHTML(k, 'ic')}<div class="snm"><b>${esc(T.n)}</b><span>${esc(ROLE_TXT[k])}</span></div><div class="sprice">${T.price}</div></div>` }).join('')}</div></div>`;
}
function renderHQ() {
  const c = G.commanders || {}, w = wxById(G.weather);
  const side = sd => `<div class="row"><span>${SIDE_NAME[sd]} · ${esc(ROLE_LABEL[G.role && G.role[sd]] || '')}</span><b>${c[sd] ? esc(c[sd].name) + ' · ' + esc(c[sd].trait) : ''}</b></div>`;
  $('#rc').innerHTML = `<div class="card"><h3>${esc(G.scen ? G.scen.n : MODE_LABEL[G.mode0] || 'Операция')}</h3>
    ${G.scen ? `<p class="hint">${esc(G.scen.brief)}</p>` : '<p class="hint">Перевес каждый ход смещается на разницу весов удержанных точек; ±100 — победа.</p>'}
    ${side(N)}${side(S)}
    <div class="lbl">Перевес по ходам</div>${histSVG(G.history) || '<p class="hint">Пока рано.</p>'}
    <div class="lbl">Погода: ${esc(w.n)}</div><p class="hint">${esc(w.d)}</p>
    <div class="acts"><button class="btn sm ${G.showSupply ? 'on' : ''}" data-a="supply">Округа снабжения <kbd>S</kbd></button></div>
    ${G.vsBot && !G.spec ? '' : `<div class="row"><span>Код партии</span><b class="ac">${esc(G.roomId)}</b></div>`}</div>`;
}
function renderPts() {
  $('#lc_pts').innerHTML = G.pts.map(p => `<div class="ptn" data-go="${p.hex}"><div class="pn"><b>${esc(p.n)}</b><span class="mu">${p.city ? 'город' : 'узел'} · вес ${p.w}</span></div><b class="${p.owner === N ? 'sdn' : 'sds'}">${SIDE_NAME[p.owner]}</b></div>`).join('');
}
function statRows(a, b, la, lb) {
  const ks = UT_ORDER.filter(k => (a && a[k]) || (b && b[k]));
  if (!ks.length) return '<p class="hint">Потерь пока нет.</p>';
  return `<table class="st"><tr><th></th><th>${la}</th><th>${lb}</th></tr>${ks.map(k => `<tr><td>${iconHTML(k, 'ic sm')}${UT[k].sh}</td><td class="bad">${(a && a[k]) || ''}</td><td class="good">${(b && b[k]) || ''}</td></tr>`).join('')}</table>`;
}
function renderSum() {
  const st = G.stats;
  if (!st) return;
  $('#lc_sum').innerHTML = `<div class="card">
    <div class="row"><span>Потеряно / уничтожено</span><b><span class="bad">${st.lostV}</span> / <span class="good">${st.killedV}</span></b></div>
    <div class="row"><span>Взято точек</span><b>${st.caps}</b></div><div class="row"><span>Отступлений</span><b>${st.routs}</b></div>
    <div class="row"><span>Пленных</span><b>${st.prisoners}</b></div>
    <div class="lbl">По типам</div>${statRows(st.lost, st.killed, 'потери', 'уничтожено')}</div>`;
}
function renderUI(force) {
  renderTop();
  if (G.tabR === 'buy') renderBuy(); else if (G.tabR === 'hq') renderHQ(); else if (G.tabR === 'ord') renderOrders(); else renderUnit();
  if (G.tabL === 'pts') renderPts(); if (G.tabL === 'sum') renderSum();
}
function syncTabs() { document.querySelectorAll('#right .tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === G.tabR)) }
function histSVG(h) {
  if (!h || h.length < 2) return '';
  const W = 460, H = 110, n = h.length - 1, sg = G.spec || G.side === N ? 1 : -1;
  const X = i => 30 + (W - 40) * i / n, Y = v => H / 2 - v / 100 * (H / 2 - 8);
  return `<svg class="hist" viewBox="0 0 ${W} ${H}"><line x1="30" x2="${W - 10}" y1="${H / 2}" y2="${H / 2}" stroke="#2b3f4e"/>
    <path d="${h.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.s * sg).toFixed(1)).join('')}" fill="none" stroke="#f2b33d" stroke-width="2"/></svg>`;
}

/* ---------- подсказка с расчётом боя ---------- */
function renderTip(sp) {
  const tip = $('#tip'), t = (G.targets || []).find(x => x.hex === G.hover);
  if (!t || animBusy()) { tip.hidden = true; return }
  let h = '';
  if (t.odds) {
    const o = t.odds, a = selUnit(), e = G.units.find(x => x.id === t.id);
    if (!a || !e) { tip.hidden = true; return }
    const ka = o.A / (o.A + o.D);
    h = `<b>Атака: ${esc(unitName(a.side, a.k))} → ${esc(unitName(e.side, e.k))}</b>
      <div class="ob" title="Соотношение сил"><i style="width:${(ka * 100).toFixed(1)}%;background:linear-gradient(90deg,#3f8fc4,#6cc3ff)"></i><i style="width:${((1 - ka) * 100).toFixed(1)}%;background:linear-gradient(90deg,#ff6b55,#b8392a)"></i></div>
      <div class="row"><span>Сила атаки</span><b>${o.A.toFixed(1)}</b></div><div class="row"><span>Оборона</span><b>${o.D.toFixed(1)}</b></div>
      <div class="row big"><span>Соотношение</span><b style="color:${t.col}">${o.r.toFixed(2).replace('.', ',')} : 1</b></div>
      ${o.mods.map(m => `<div class="row mod ${(m.who === 'a') === (m.v > 1) ? 'good' : 'bad'}"><span>${esc(m.t)}</span><b>${m.who === 'a' ? 'атака' : 'оборона'} ×${m.v.toFixed(2).replace('.', ',')}</b></div>`).join('')}
      <div class="lbl">Ожидаемо</div>
      <div class="row"><span>Потери противника</span><b class="good">${o.lossD[0]}…${o.lossD[1]}</b></div>
      <div class="row"><span>Наши потери</span><b class="bad">${o.lossA[0]}…${o.lossA[1]}</b></div>
      <div class="row"><span>Шанс отхода противника</span><b>${Math.round(o.retreat * 100)}%</b></div>
      <div class="bar sm"><div style="width:${Math.round(o.retreat * 100)}%;background:var(--ac)"></div></div>
      <p class="hint">Мораль и опыт противника неизвестны — расчёт по типичным.</p>`;
  } else if (t.bomb) {
    h = `<b>Огонь</b>${t.bomb.mods.map(m => `<div class="row mod ${m.v > 1 ? 'good' : 'bad'}"><span>${esc(m.t)}</span><b>×${m.v.toFixed(2).replace('.', ',')}</b></div>`).join('')}
      <div class="row"><span>Потери цели</span><b class="good">${t.bomb.loss[0]}…${t.bomb.loss[1]}</b></div><div class="row"><span>Подавление</span><b>да: оборона ×0,8</b></div>`;
  }
  tip.innerHTML = h; tip.hidden = false;
  tip.style.left = Math.min(CW - 280, sp.x + 18) + 'px'; tip.style.top = Math.min(CH - tip.offsetHeight - 10, sp.y + 10) + 'px';
}

/* ---------- окна ---------- */
function showHelp() {
  $('#mbox').innerHTML = `<h2>Frontline Tactics</h2>
    <p><b>Ход</b> — 4 часа. Стороны ходят по очереди (во встречном бою первый ход — по жребию). Каждая часть за ход может пройти по очкам хода и один раз атаковать (или стрелять артиллерией), либо окопаться, либо пополниться.</p>
    <p><b>Движение.</b> Лес и высоты дороже, дорога — дешевле. Реку без моста колёсные не переходят, остальные — только с полным запасом хода. Рядом с противником — его <b>зона контроля</b>: вошёл — встал.</p>
    <p><b>Бой.</b> Наведите на цель — увидите соотношение сил и всё, что на него влияет: местность, окоп, охват, удар с двух сторон, реку, ночь, снабжение, штаб. Новое: <b>рельеф</b> (в гору ×0,88…0,8, с высоты ×1,1) и <b>взаимодействие родов войск</b> — цель, по которой в этот ход уже били танки, пехота атакует ×1,15 (и наоборот). Отход в клетку под огнём двух частей противника стоит шага силы.</p>
    <p><b>Артиллерия.</b> Огонь слабее в непогоду (дождь, туман, снег). Батарея, не стрелявшая в свой ход, прикрывает соседей и ведёт <b>контрбатарейный огонь</b> по артиллерии противника, открывшей огонь в её дальности.</p>
    <p><b>Оборона.</b> <b>Засада</b> встречает огнём того, кто войдёт рядом. Сапёры строят <b>укрепления</b> и <b>заграждения</b>, ставят мины, наводят понтоны, взрывают и <b>восстанавливают мосты</b>. В режимах «Оборона» и «Наступление» обороняющийся начинает в окопах, его точки укреплены.</p>
    <p><b>Снабжение.</b> Округа снабжения — от ваших городов и края карты (клавиша <b>S</b>). Запас 0–3 на фишке; в котле тает по делению за ход, без запасов часть тает и сдаётся.</p>
    <p><b>Приказы штаба</b> (★): артподготовка, <b>контрудар</b> (атаки у ваших потерянных исходных точек ×1,3), форсированный марш, стоять насмерть, дымовая завеса, снабжение по воздуху, резерв ставки.</p>
    <p><b>Опыт.</b> Части растут: «обстрелянные» ★ и «ветераны» ★★ бьют и держатся лучше.</p>
    <p><b>Перевес</b> — счёт операции, он же условие победы. В конце каждого хода к нему прибавляется разница
    весов точек: ваши города и узлы минус города противника (вес крупного города больше). Держите больше — перевес
    растёт в вашу пользу, потеряли город — пошёл назад. Дошёл до <b>+100</b> — вы победили, до <b>−100</b> — проиграли;
    если срок операции истёк раньше, побеждает тот, кто впереди. Число и темп за ход видны наверху, график — во вкладке «Сводка».</p>
    <div class="lbl">Управление</div>
    <p>ЛКМ — выбрать / идти / атаковать · ПКМ — снять · перетаскивание — карта · колесо, <kbd>+</kbd> <kbd>−</kbd> — масштаб (к курсору) · <kbd>F</kbd> — вся карта · <kbd>C</kbd> — к выбранной части · <kbd>T</kbd> — типы клеток · <kbd>S</kbd> — снабжение · <kbd>Tab</kbd> — следующая часть · <kbd>D</kbd> — окопаться · <kbd>A</kbd> — засада · <kbd>Enter</kbd> — конец хода · мини-карта — клик и перетаскивание.<br>
    Сенсорный экран: палец — карта, два пальца — масштаб, касание — выбор, долгое касание — снять выбор.</p>
    <p class="acts"><button class="btn pri" id="btnClose">Понятно</button></p>`;
  $('#modal').hidden = false;
}
function showBrief() {
  $('#mbox').innerHTML = `<h2>${esc(G.scen.n)}</h2><p>${esc(G.scen.brief)}</p><p class="mu">Вы — ${SIDE_NAME[G.side]} (${ROLE_LABEL[G.role[G.side]] || ''}). На задачу — ${G.scen.left} ход(ов).</p><p class="acts"><button class="btn pri" id="btnClose">К делу</button></p>`;
  $('#modal').hidden = false;
}
function showEnd() {
  if (G.scen && !G.spec && G.over.w === G.side) { try { const d = JSON.parse(localStorage.getItem('turn.camp') || '{}'); d[G.scen.id] = 1; localStorage.setItem('turn.camp', JSON.stringify(d)) } catch (e) { /* приватный режим */ } }
  const title = G.spec ? (G.over.w ? 'Победа: ' + SIDE_NAME[G.over.w] : 'Ничья') : G.over.w === null ? 'Ничья' : G.over.w === G.side ? 'Победа' : 'Поражение';
  const st = G.stats || {}, en = G.enemyStats || {};
  $('#mbox').innerHTML = `<h2>${title}</h2><p>${esc(G.over.t)}</p><p class="mu">Операция длилась ${G.turn} ход(ов).</p>
    ${histSVG(G.history)}
    <div class="cols"><div><div class="lbl">${G.spec ? SIDE_NAME.n : 'Мы'}</div><div class="row"><span>Потеряно</span><b class="bad">${st.lostV || 0}</b></div><div class="row"><span>Взято точек</span><b>${st.caps || 0}</b></div></div>
    <div><div class="lbl">${G.spec ? SIDE_NAME.s : 'Противник'}</div><div class="row"><span>Потеряно</span><b class="bad">${en.lostV || 0}</b></div><div class="row"><span>Взято точек</span><b>${en.caps || 0}</b></div></div></div>
    <p class="acts"><button class="btn" id="btnClose">Осмотреть карту</button><button class="btn pri" id="btnNew">В меню</button></p>`;
  $('#modal').hidden = false;
}
function hideModal() { $('#modal').hidden = true }

/* ---------- меню ---------- */
const SCEN_TXT = {
  bridge: { n: 'Мост через Тихую', d: 'Взять переправу у Моста за 8 ходов, пока к Союзу не подошли резервы.' },
  breakthrough: { n: 'Прорыв к Красногору', d: 'За 30 ходов взять Красногор через мины и волны резервов.' },
  night: { n: 'Ночной рейд', d: 'За 3 ночных хода разгромить артиллерию и штаб Союза под Заречьем.' }
};
const OPP_TXT = {
  bot: { n: 'Против бота', d: 'Одиночная партия — вторую сторону держит бот-командир.' },
  human: { n: 'Против игрока', d: 'Создаст партию и даст код из четырёх букв — передайте его противнику.' },
  watch: { n: 'Бот против бота', d: 'Наблюдение без тумана войны: скорость ×1/×2/×4 и пауза.' }
};
const MODE_TXT = {
  both: { n: 'Встречный бой', d: 'Силы равны, первый ход — по жребию. Кто удержит больше городов — у того перевес.' },
  attack: { n: 'Наступление', d: 'Вы наступаете и ходите первым, бюджет +12%. Противник встречает в окопах, его точки укреплены.' },
  defense: { n: 'Оборона', d: 'Вы держите рубеж: доход +30%, части в окопах, точки укреплены. Противник сильнее и бьёт первым.' }
};

/* ник игрока: показывается остальным в лобби. Сервер всё равно чистит его
   по белому списку (латиница, кириллица, цифры, пробел, - _ .), здесь — то же
   ограничение, чтобы поле сразу не принимало лишнего. */
const NAME_MAX = 16;
const NAME_BAD = /[^A-Za-z\u0410-\u044F\u0401\u04510-9 _.-]/g;
const cleanName = v => String(v == null ? '' : v).replace(NAME_BAD, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
let myName = '';
try { myName = cleanName(localStorage.getItem('ft.name') || '') } catch (e) { /* приватный режим */ }
function setMyName(v) {
  myName = cleanName(v);
  try { localStorage.setItem('ft.name', myName) } catch (e) { /* приватный режим */ }
  return myName;
}

/* состояние меню: экран + выбор, выбор помнится между запусками */
/* Ростер свободной игры: по три слота на сторону.
   Слот: 'off' — выключен, 'human' — живой игрок, 'bot' — бот.
   M.me — слот, на котором сидите вы: { side, i }; null — вы только смотрите. */
const M = {
  view: 'root', side: N, mode: 'both', team: '1x1', fill: 'bot', joinSide: 'any',
  roster: { n: ['human', 'off', 'off'], s: ['bot', 'off', 'off'] },
  me: { side: N, i: 0 }
};
try { Object.assign(M, JSON.parse(localStorage.getItem('ft.menu') || '{}')) } catch (e) { /* без настроек */ }
M.view = 'root';
if (!MODE_TXT[M.mode]) M.mode = 'both';
if (M.side !== N && M.side !== S) M.side = N;
if (!['any', N, S].includes(M.joinSide)) M.joinSide = 'any';
if (!M.roster || typeof M.roster !== 'object') M.roster = { n: ['human', 'off', 'off'], s: ['bot', 'off', 'off'] };
rosterFix();
function mSave() {
  try {
    localStorage.setItem('ft.menu', JSON.stringify({
      side: M.side, mode: M.mode, team: M.team, fill: M.fill, joinSide: M.joinSide, roster: M.roster, me: M.me
    }));
  } catch (e) { /* приватный режим */ }
}
/* ---------- ростер ---------- */
const SLOT_NEXT = { off: 'human', human: 'bot', bot: 'off' };
const SLOT_TXT = { off: '—', human: 'Игрок', bot: 'Бот' };
function rosterFix() {
  for (const sd of [N, S]) {
    const a = M.roster[sd];
    if (!Array.isArray(a) || a.length !== MAX_SEATS) M.roster[sd] = ['off', 'off', 'off'];
    M.roster[sd] = M.roster[sd].map(v => SLOT_TXT[v] ? v : 'off');
    /* слоты «сдвинуты» к началу: пустые уходят вниз, иначе нумерация мест путает */
    const live = M.roster[sd].filter(v => v !== 'off');
    M.roster[sd] = live.concat(Array(MAX_SEATS - live.length).fill('off'));
  }
  /* ваше место должно существовать и быть «игроком» */
  if (M.me && M.roster[M.me.side] && M.roster[M.me.side][M.me.i] === 'human') return;
  M.me = null;
  for (const sd of [N, S]) {
    const i = M.roster[sd].indexOf('human');
    if (i >= 0) { M.me = { side: sd, i }; return }
  }
}
const isMe = (sd, i) => !!M.me && M.me.side === sd && M.me.i === i;
/** сколько живых слотов на стороне */
const seatCount = sd => M.roster[sd].filter(v => v !== 'off').length;
/** план мест для сервера из ростера */
function rosterPlan() {
  const out = {};
  for (const sd of [N, S]) out[sd] = M.roster[sd].filter(v => v !== 'off')
    .map((v, i) => v === 'bot' ? 'bot' : isMe(sd, i) ? 'me' : 'open');
  return out;
}
/** чего не хватает, чтобы начать */
function rosterErr() {
  if (!seatCount(N) || !seatCount(S)) return 'В каждой команде нужен хотя бы один командир.';
  return null;
}

/* ---------- составы команд ---------- */
const TEAMS = {
  '1x1': { n: 'Один на один', a: 1, b: 1 },
  '2x2': { n: 'Два на два', a: 2, b: 2 },
  '2x1': { n: 'Два на одного', a: 2, b: 1 },
  '3x3': { n: 'Три на три', a: 3, b: 3 }
};
/** кооп-миссия: сторона игрока по выбранному составу, противник — всегда бот */
function scenPlan(id) {
  const T = TEAMS[M.team] || TEAMS['1x1'];
  const my = M.side, foe = my === N ? S : N;
  const ally = M.fill === 'bot' ? 'bot' : 'open';
  return { [my]: ['me'].concat(Array(Math.max(0, T.a - 1)).fill(ally)), [foe]: ['bot'] };
}

/** план мест для сервера: 'me' — я, 'bot' — бот, 'open' — ждём игрока */
function seatPlan() {
  const T = TEAMS[M.team] || TEAMS['1x1'];
  const my = M.side, foe = my === N ? S : N;
  if (M.opp === 'watch') return { [my]: Array(T.a).fill('bot'), [foe]: Array(T.b).fill('bot') };
  /* моё место — первое на своей стороне; союзные места и места противника
     заполняются по отдельности: ботом или ожиданием живого игрока */
  const ally = M.fill === 'bot' ? 'bot' : 'open';
  const enemy = M.opp === 'bot' ? 'bot' : 'open';
  return {
    [my]: ['me'].concat(Array(Math.max(0, T.a - 1)).fill(ally)),
    [foe]: Array(T.b).fill(enemy)
  };
}

/** ряд взаимоисключающих кнопок: key — поле в M, opts — [значение, подпись] */
function mPick(key, opts, dis) {
  return `<div class="mrow">${opts.map(([v, n]) => `<button class="btn ch${M[key] === v ? ' on' : ''}"
    data-pick="${key}" data-val="${v}"${dis ? ' disabled' : ''}>${esc(n)}</button>`).join('')}</div>`;
}
const joinHTML = () => `<div class="mjoin"><span>Код партии:</span>
  <input id="joinCode" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false">
  <button class="btn" data-a="join">Войти</button><button class="btn" data-a="spec">Смотреть</button></div>`;
const backHTML = t => `<div class="mhead"><button class="btn" data-nav="root">‹ Назад</button><h1>${esc(t)}</h1></div>`;

function menuHTML() {
  if (M.view === 'play') return playHTML();
  if (M.view === 'camp') return campHTML();
  if (M.view === 'set') return setHTML();
  if (M.view === 'news') return newsHTML();
  return rootHTML();
}

function rootHTML() {
  const strip = ['tnk', 'mot', 'inf', 'art', 'mlrs', 'eng', 'hq'].map(k => iconHTML(k, 'ic big')).join('');
  return `<div class="mbox root"><h1>FRONTLINE TACTICS</h1>
    <div class="msub">Пошаговая штабная игра о сухопутном фронте</div>
    <div class="mstrip">${strip}</div>
    <div class="mname"><label for="nick">Ваш ник</label>
      <input id="nick" maxlength="${NAME_MAX}" placeholder="Командир" autocomplete="off" spellcheck="false" value="${esc(myName)}">
      <i>латиница или кириллица, до ${NAME_MAX} знаков</i></div>
    <div class="mmain">
      <button class="btn pri big" data-nav="play">Играть</button>
      <button class="btn big" data-nav="camp">Кампания</button>
      <button class="btn big" data-nav="set">Настройки</button>
      <button class="btn big" data-nav="news">Что нового${News.unseen() ? '<i class="dot" title="есть новое"></i>' : ''}</button>
    </div>
    ${joinHTML()}
    <div class="mfoot">Версия ${GAME_VERSION} · колесо — масштаб, перетаскивание — карта, <kbd>?</kbd> — справка.</div></div>`;
}

function playHTML() {
  const err = rosterErr();
  const col = sd => {
    const rows = M.roster[sd].map((v, i) => {
      const live = v !== 'off';
      const mine = isMe(sd, i);
      return `<div class="slot ${v} ${mine ? 'mine' : ''}">
        <span class="sn">${i + 1}</span>
        <button class="btn sl" data-slot="${sd}:${i}">${SLOT_TXT[v]}</button>
        ${v === 'human'
          ? `<button class="btn tiny ${mine ? 'on' : ''}" data-me="${sd}:${i}" title="сесть на это место">${mine ? 'вы' : 'сесть'}</button>`
          : '<span class="tiny mu"></span>'}
      </div>`;
    }).join('');
    return `<div class="tcol ${sd}">
      <div class="thd" style="color:${COL[sd]}">${esc(SIDE_NAME[sd])}<i>${sd === N ? 'слева' : 'справа'}</i></div>
      ${rows}
      <div class="tsum">${seatCount(sd)} ${seatCount(sd) === 1 ? 'командир' : 'командира'}</div></div>`;
  };
  return `<div class="mbox">${backHTML('Свободная операция')}
    <div class="mlab">Команды <i class="mu">— нажмите на слот: — · Игрок · Бот</i></div>
    <div class="tcols">${col(N)}${col(S)}</div>
    <div class="mnote">${err
      ? '<b class="bad">' + esc(err) + '</b>'
      : M.me
        ? `Вы — командир ${M.me.i + 1} за ${esc(SIDE_NAME[M.me.side])}. Бюджет и доход команды делятся между её командирами; ход стороны закрывается, когда закончили все.`
        : 'Вашего места нет — партия пойдёт сама, вы будете смотреть.'}</div>

    <div class="mlab">Режим</div>
    ${mPick('mode', [['both', 'Встречный бой'], ['attack', 'Наступление'], ['defense', 'Оборона']])}
    <div class="mnote">${esc(MODE_TXT[M.mode].d)}</div>

    <div class="mlab">Карта</div>
    <div class="maps">${MAP_ORDER.map(id => `<div class="mapc ${G.mapPick === id ? 'on' : ''}" data-map="${id}">
      <canvas data-prev="${id}" width="90" height="132"></canvas>
      <div class="mtx"><b>${esc(MAPS[id].n)}</b><i>${esc(MAPS[id].tag)}</i><span>${esc(MAPS[id].desc)}</span></div></div>`).join('')}</div>

    <div class="macts"><button class="btn pri big" data-a="go"${err ? ' disabled' : ''}>${M.me ? 'В бой' : 'Смотреть'}</button></div></div>`;
}

function campHTML() {
  let done = {}; try { done = JSON.parse(localStorage.getItem('turn.camp') || '{}') } catch (e) { /* приватный режим */ }
  return `<div class="mbox">${backHTML('Красногорская операция')}
    <div class="mlab">Сторона</div>
    ${mPick('side', [[N, SIDE_NAME[N] + ' (слева)'], [S, SIDE_NAME[S] + ' (справа)']])}
    <div class="mlab">Кооператив</div>
    ${/* в коопе важно только число командиров на своей стороне, поэтому 2x1 здесь не нужен */
      mPick('team', ['1x1', '2x2', '3x3'].map(k => [k, TEAMS[k].a > 1 ? TEAMS[k].a + ' командира' : 'Один командир']))}
    ${TEAMS[M.team].a > 1 ? mPick('fill', [['bot', 'Союзники — боты'], ['open', 'Ждать игроков']]) : ''}
    <div class="mnote">${TEAMS[M.team].a > 1
      ? 'Операцию ведут ' + TEAMS[M.team].a + ' командира на одной стороне: бюджет и вылеты делятся, ход стороны закрывается, когда закончили все.'
      : 'Операцию ведёте вы один.'}</div>
    <div class="mgrid">${['bridge', 'breakthrough', 'night'].map((id, i) => `<div class="mcard ${done[id] ? 'done' : ''}">
      <div class="mkick">Операция ${i + 1}${done[id] ? ' · ✓ выполнена' : ''}</div>
      <h2>${SCEN_TXT[id].n}</h2><p>${SCEN_TXT[id].d}</p>
      <div class="acts"><button class="btn pri sm" data-a="scen" data-id="${id}">Начать</button>
      <button class="btn sm" data-a="watch" data-mode="${id}">Смотреть</button></div></div>`).join('')}</div></div>`;
}

function setHTML() {
  /* звук и экран — те же панели, что в игре по кнопке 🔊, без своей кнопки «Готово» */
  const snd = Sound.panelHTML().split('<p class="acts">')[0];
  return `<div class="mbox narrow">${backHTML('Настройки')}
    <div class="mpanel">${snd}${screenPanelHTML()}</div>
    <div class="mnote">Настройки сохраняются в этом браузере и действуют сразу.</div></div>`;
}

function newsHTML() {
  return `<div class="mbox narrow">${backHTML('Что нового')}
    <div class="mpanel news">${News.html(esc)}</div></div>`;
}

function showMenu() {
  hideModal();
  if (M.view === 'news') News.markSeen();
  $('#menu').innerHTML = menuHTML();
  $('#menu').classList.add('on');
  drawPreviews();
}
/* ---------- миниатюры карт в меню: печём в простое по одной ---------- */
const PREV = new Map();
function mapPreview(id) {
  if (PREV.has(id)) return PREV.get(id);
  const T = Terrain.get(id), def = T.def, k = 3, w = Math.round(WW / k), h = Math.round(WH / k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), D = img.data;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = (i + .5) * k, y = (j + .5) * k, o = (j * w + i) * 4, H = T.height(x, y);
    let col = def.forest && def.forest.thr > .7 ? [104, 96, 60] : [76, 86, 54];
    if ((def.lakes || []).length && T.lakeK(x, y) > 0) col = [24, 58, 80];
    else if (T.forestV(x, y, H) > T.FOREST_T) col = [30, 50, 32];
    if ((def.marsh || []).length && T.marshK(x, y) > .1) col = [44, 66, 58];
    if ((def.ridges || []).length && T.ridgeK(x, y) > .35) col = [110, 104, 92];
    const e = .8 + H * .45;
    D[o] = col[0] * e; D[o + 1] = col[1] * e; D[o + 2] = col[2] * e; D[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.scale(1 / k, 1 / k); g.lineCap = g.lineJoin = 'round';
  for (const r of T.roads()) { g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.strokeStyle = 'rgba(210,190,140,.7)'; g.lineWidth = 2.2; g.stroke() }
  for (const r of T.rivers()) { g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.strokeStyle = '#3a86b0'; g.lineWidth = 4.5; g.stroke() }
  for (const p of def.points) { g.fillStyle = !p.owner ? '#ddd' : p.owner === N ? '#6cc3ff' : '#ff8a72'; g.strokeStyle = '#000'; g.lineWidth = 2; const z = p.city ? 12 : 8; g.fillRect(p.x - z / 2, p.y - z / 2, z, z); g.strokeRect(p.x - z / 2, p.y - z / 2, z, z) }
  PREV.set(id, c);
  return c;
}
function drawPreviews() {
  const put = el => { try { const c = mapPreview(el.dataset.prev); el.getContext('2d').drawImage(c, 0, 0, el.width, el.height) } catch (e) { /* без холста */ } };
  /* уже испечённые — сразу, чтобы меню не мигало при каждом выборе */
  const list = [...document.querySelectorAll('canvas[data-prev]')].filter(el => PREV.has(el.dataset.prev) ? (put(el), false) : true);
  const next = () => {
    const el = list.shift();
    if (!el) return;
    put(el);
    (window.requestIdleCallback || (f => setTimeout(f, 30)))(next);
  };
  next();
}
function hideMenu() { $('#menu').classList.remove('on') }
function leaveToMenu() { netSend({ t: 'leave' }); G.roomId = null; G.units = []; G.sel = null; $('#lc_log').innerHTML = ''; showMenu() }

/* ---------- ввод ---------- */
function setSel(id) { G.sel = id; G.mode = null; G.spawn = null; hint(''); if (id) { G.tabR = 'unit'; syncTabs() } computeSel(); renderUI() }
function clickHex(h, e) {
  if (!G.roomId || h < 0 || animBusy()) return;
  const u = selUnit(), there = G.units.find(x => x.hex === h);
  const m = G.mode;
  if (m && m.startsWith('buy:')) { act({ t: 'buy', k: m.slice(4), hex: h }); if (!e.shiftKey) { G.mode = null; G.spawn = null; hint('') } return }
  if (m && m.startsWith('ord:')) { act({ t: 'order', k: m.slice(4), hex: h }); G.mode = null; G.spawn = null; hint(''); renderUI(); return }
  if (m && m.startsWith('air:')) { act({ t: 'air', kind: m.slice(4), hex: h }); G.mode = null; hint(''); renderUI(); return }
  if (m && m.startsWith('eng:') && u) { act({ t: 'eng', id: u.id, task: m.slice(4), hex: h }); G.mode = null; hint(''); return }
  if (G.phase === 'deploy') {
    if (there && myUnit(there)) return setSel(there.id);
    if (u && myUnit(u) && !there) { act({ t: 'place', id: u.id, hex: h }); return }
    return setSel(there ? there.id : null);
  }
  if (there && (myUnit(there) || G.spec)) return setSel(there.id === G.sel && !G.spec ? null : there.id);
  const tg = (G.targets || []).find(t => t.hex === h);
  if (u && tg) { act(UT[u.k].bomb ? { t: 'bombard', id: u.id, hex: h } : { t: 'attack', id: u.id, target: tg.id }); return }
  if (u && G.reach && G.reach.has(h) && !G.reach.get(h).through) { act({ t: 'move', id: u.id, to: h }); return }
  if (there) { G.sel = there.id; G.tabR = 'unit'; syncTabs(); computeSel(); renderUI(); return }
  setSel(null);
}
function orderClick(k) {
  const O = ORDERS[k];
  if (!O || !G.isMyTurn) return;
  if (G.cp < O.cp) return toast(`Нужно ${O.cp} командных очка`);
  if (O.tgt === 'none') { act({ t: 'order', k }); return }
  if (O.tgt === 'unit') { const u = selUnit(); if (!u || !myUnit(u)) return toast('Сначала выберите свою часть'); act({ t: 'order', k, id: u.id }); return }
  G.mode = G.mode === 'ord:' + k ? null : 'ord:' + k;
  G.spawn = G.mode === 'ord:reserve' ? spawnHexes('mot') : null;
  hint(G.mode ? (k === 'smoke' ? 'Дымовая завеса: кликните по клетке (до 3 клеток от своих частей) — дым ляжет на неё и соседние.' : 'Резерв ставки: кликните по подсвеченной клетке у своего города или узла.') + ' ПКМ — отмена.' : '');
  renderUI();
}
function nextUnit() {
  const list = G.units.filter(u => myUnit(u) && (u.mp > 0 || !u.acted));
  if (!list.length) { toast('Все части отработали — можно завершать ход'); return }
  const i = list.findIndex(u => u.id === G.sel), u = list[(i + 1) % list.length];
  camTo(Hex.center(u.hex));
  setSel(u.id);
}
function endTurn() {
  if (G.phase === 'deploy') { act({ t: 'ready' }); return }
  if (!G.isMyTurn) return;
  G.sel = null; G.reach = null; G.targets = []; G.isMyTurn = false; G.mode = null;
  $('#tip').hidden = true; hint('');
  act({ t: 'end' });
  renderUI();
}

/* ---------- цикл ---------- */
let last = performance.now(), uiAcc = 0;
const KEYS = new Set();
function loop(now) {
  requestAnimationFrame(loop);
  const rdt = Math.min(.25, (now - last) / 1000), dt = Math.min(.05, rdt); last = now;
  try {
    const v = 520 * dt / G.view.s;
    if (KEYS.size) {
      let x = G.view.x, y = G.view.y;
      if (KEYS.has('ArrowLeft')) x -= v; if (KEYS.has('ArrowRight')) x += v;
      if (KEYS.has('ArrowUp')) y -= v; if (KEYS.has('ArrowDown')) y += v;
      panTo(x, y);
    }
    camTick(rdt);
    /* клетка под курсором — и когда карта едет сама */
    if (G.mouse && G.mouse.inside && (CAM.moving || KEYS.size)) { const w = s2w(G.mouse); G.hover = Hex.hexAt(w.x, w.y); renderTip(G.mouse); hexInfo(G.hover) }
    if (G.pendingSnap && G.pendingAt && performance.now() - G.pendingAt > 15000) { skipAnims(); const v = G.pendingSnap; G.pendingSnap = null; applySnapshot(v) }
    const t0 = performance.now();
    draw(dt);
    loop.ms = performance.now() - t0; loop.max = Math.max(loop.max || 0, loop.ms);
    Sound.update(dt);
    uiAcc += dt; if (uiAcc > .5 && G.roomId) { uiAcc = 0; renderTop() }
  } catch (e) { if (!loop.err) { loop.err = 1; console.error(e) } }
}

function bind() {
  cv = $('#map'); cx = cv.getContext('2d'); resize(); window.addEventListener('resize', resize); watchDPR();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
  applyScreenFX();
  $('#btnEnd').onclick = endTurn;
  $('#btnHelp').onclick = showHelp;
  $('#btnMenu').onclick = () => { if (!G.roomId || G.over || confirm('Выйти в меню?')) leaveToMenu() };
  $('#btnSound').onclick = e => { if (e.shiftKey) Sound.toggle(); else { $('#mbox').innerHTML = Sound.panelHTML().replace('<p class="acts">', screenPanelHTML() + '<p class="acts">'); $('#modal').hidden = false } };
  document.addEventListener('change', e => { const el = e.target.closest && e.target.closest('[data-scr]'); if (el) setScreen(el.dataset.scr, el.checked) });
  $('#btnStrike').onclick = () => { G.mode = G.mode === 'air:strike' ? null : 'air:strike'; hint(G.mode ? 'Авиаудар: кликните по видимой цели. ПВО рядом с целью может сорвать удар.' : ''); renderTop() };
  $('#btnRecon').onclick = () => { G.mode = G.mode === 'air:recon' ? null : 'air:recon'; hint(G.mode ? 'Авиаразведка: кликните по району — откроется радиус 3 клетки.' : ''); renderTop() };
  $('#paceBox').addEventListener('click', e => { const b = e.target.closest('[data-pace]'); if (!b) return; G.pace = +b.dataset.pace || 1; netSend({ t: 'pace', value: +b.dataset.pace }); document.querySelectorAll('#paceBox button').forEach(x => x.classList.toggle('on', x === b)) });
  document.querySelectorAll('.colbtn').forEach(b => b.onclick = () => { const el = $('#' + b.dataset.col); el.classList.toggle('col'); setTimeout(() => { clampTo(CAM); CAM.moving = true }, 220) });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'btnClose' || e.target.id === 'modal') hideModal(); if (e.target.id === 'btnNew') leaveToMenu() });
  $('#lobby').addEventListener('click', e => { if (e.target.id === 'btnLobbyClose') { G.lobbyHidden = true; renderLobby() } });
  document.querySelectorAll('#left .tabs button').forEach(b => b.onclick = () => {
    G.tabL = b.dataset.tab;
    document.querySelectorAll('#left .tabs button').forEach(x => x.classList.toggle('on', x === b));
    for (const id of ['log', 'pts', 'sum']) $('#lc_' + id).style.display = G.tabL === id ? 'block' : 'none';
    renderUI();
  });
  document.querySelectorAll('#right .tabs button').forEach(b => b.onclick = () => { G.tabR = b.dataset.tab; syncTabs(); renderUI() });
  $('#lc_pts').addEventListener('click', e => { const r = e.target.closest('[data-go]'); if (r) camTo(Hex.center(+r.dataset.go), Math.max(G.view.s, S_WORK())) });
  $('#rc').addEventListener('click', e => {
    const b = e.target.closest('[data-buy]');
    if (b) { if (b.classList.contains('off')) return toast('Не хватает очков'); G.mode = 'buy:' + b.dataset.buy; G.sel = null; G.spawn = spawnHexes(b.dataset.buy); hint(G.phase === 'deploy' ? 'Кликните по клетке в зоне расстановки (Shift — несколько).' : 'Кликните по подсвеченной клетке у своего города или узла (Shift — несколько).'); renderUI(); return }
    const o = e.target.closest('[data-ord]');
    if (o) { orderClick(o.dataset.ord); return }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const u = selUnit(), k = a.dataset.a;
    if (k === 'supply') { G.showSupply = !G.showSupply; renderUI(); return }
    if (k.startsWith('ord:')) { orderClick(k.slice(4)); return }
    if (!u) return;
    if (k === 'sell') act({ t: 'sell', id: u.id });
    else if (k === 'dig') act({ t: 'dig', id: u.id });
    else if (k === 'replace') act({ t: 'replace', id: u.id });
    else if (k === 'ambush') act({ t: 'ambush', id: u.id });
    else if (k.startsWith('eng:')) { G.mode = k; hint({ 'eng:fort': 'Укрепления: своя или соседняя клетка (до 2 уровней).', 'eng:obst': 'Заграждения: своя или соседняя клетка — технике вход стоит всего хода.', 'eng:bridge': 'Понтон: кликните по соседней клетке за рекой.', 'eng:blow': 'Кликните по соседней клетке за мостом.', 'eng:mine': 'Мины: своя или соседняя пустая клетка.', 'eng:clear': 'Кликните по соседней клетке с чужими минами.', 'eng:repair': 'Кликните по соседней клетке за взорванным мостом (противника рядом быть не должно).' }[k] + ' ПКМ — отмена.') }
  });
  $('#menu').addEventListener('input', e => {
    const el = e.target.closest && e.target.closest('#nick');
    if (!el) return;
    const v = setMyName(el.value);
    if (el.value !== v) el.value = v;   /* лишние знаки не принимаем сразу в поле */
  });
  $('#menu').addEventListener('click', e => {
    /* переход между экранами меню */
    const nav = e.target.closest('[data-nav]');
    if (nav) { M.view = nav.dataset.nav; showMenu(); return }
    /* выбор в ряду кнопок */
    const pk = e.target.closest('[data-pick]');
    if (pk) { M[pk.dataset.pick] = pk.dataset.val; mSave(); showMenu(); return }
    /* карта: подсветка на месте, чтобы не перерисовывать превью */
    const mp = e.target.closest('[data-map]');
    if (mp) {
      G.mapPick = mp.dataset.map;
      try { localStorage.setItem('turn.map', G.mapPick) } catch (err) { /* приватный режим */ }
      document.querySelectorAll('.mapc').forEach(x => x.classList.toggle('on', x === mp));
      return;
    }
    const el = e.target.closest('[data-a]'); if (!el) return;
    const a = el.dataset.a, code = ($('#joinCode') || {}).value || '';
    if (a === 'go') {
      if (M.opp === 'watch') netSend({ t: 'create', mode: M.mode, watch: true, map: G.mapPick, seats: seatPlan() });
      else netSend({ t: 'create', mode: M.mode, side: M.side, vsBot: M.opp === 'bot', map: G.mapPick, seats: seatPlan(), name: myName });
    }
    else if (a === 'scen') netSend({ t: 'create', mode: el.dataset.id, side: M.side, vsBot: true, seats: scenPlan(el.dataset.id), name: myName });
    else if (a === 'watch') netSend({ t: 'create', mode: el.dataset.mode, watch: true, map: G.mapPick });
    else if (a === 'join' || a === 'spec') {
      if (code.trim().length !== 4) return toast('Код — четыре буквы');
      netSend({ t: 'join', room: code.trim().toUpperCase(), spec: a === 'spec', name: myName });
    }
  });
  bindPointer();
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), sp = { x: e.clientX - r.left, y: e.clientY - r.top };
    /* горизонтальная прокрутка тачпада — сдвиг карты */
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) { panTo(G.view.x + e.deltaX / G.view.s, G.view.y); return }
    zoomAt(sp, wheelFactor(e));
  }, { passive: false });
  $('#zoomBox').addEventListener('click', e => {
    const b = e.target.closest('[data-z]'); if (!b) return;
    const a = mapArea(), c = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2 };
    if (b.dataset.z === 'in') zoomAt(c, 1.45); else if (b.dataset.z === 'out') zoomAt(c, 1 / 1.45);
    else if (b.dataset.z === 'fit') camFit(); else if (b.dataset.z === 'types') { G.showTypes = !G.showTypes; b.classList.toggle('on', G.showTypes) }
    else if (b.dataset.z === 'sel') { const u = selUnit(); if (u) camTo(Hex.center(u.hex), Math.max(G.view.s, S_WORK())) }
  });
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key.startsWith('Arrow')) { KEYS.add(e.key); e.preventDefault(); return }
    const a = mapArea(), mid = { x: (a.l + a.r) / 2, y: (a.t + a.b) / 2 };
    if (e.key === '+' || e.key === '=') { zoomAt(mid, 1.35); return }
    if (e.key === '-' || e.key === '_') { zoomAt(mid, 1 / 1.35); return }
    /* в меню: Esc — на шаг назад, игровые клавиши не трогаем */
    if ($('#menu').classList.contains('on')) {
      if (e.key === 'Escape' && M.view !== 'root') { M.view = 'root'; showMenu() }
      return;
    }
    if (!G.roomId) return;
    if (e.key === 'Tab') { e.preventDefault(); nextUnit() }
    else if (e.key === 'Enter') endTurn();
    else if (e.key === 'Escape') { G.mode = null; G.spawn = null; hint(''); setSel(null); hideModal() }
    else if ((e.key === 'd' || e.key === 'в') && selUnit()) act({ t: 'dig', id: G.sel });
    else if ((e.key === 'a' || e.key === 'ф') && selUnit()) act({ t: 'ambush', id: G.sel });
    else if (e.key === 's' || e.key === 'ы') { G.showSupply = !G.showSupply; renderUI() }
    else if (e.key === 't' || e.key === 'е') { G.showTypes = !G.showTypes; const b = document.querySelector('[data-z=types]'); if (b) b.classList.toggle('on', G.showTypes) }
    else if (e.key === 'f' || e.key === 'а') camFit();
    else if ((e.key === 'c' || e.key === 'с') && selUnit()) camTo(Hex.center(selUnit().hex));
    else if (e.key === '?') showHelp();
  });
  window.addEventListener('keyup', e => KEYS.delete(e.key));
}

/* ---------- указатель: мышь, перо, палец ---------- */
function bindPointer() {
  const P = new Map();          /* активные указатели: id → { x, y, x0, y0, t0 } */
  let drag = null, pinch = null, mini = false, longT = 0;
  const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } };
  const inMini = sp => { const m = miniRect(); return MINI && G.roomId && sp.x >= m.x - 4 && sp.x <= m.x + m.w + 4 && sp.y >= m.y - 4 && sp.y <= m.y + m.h + 4 };
  const miniGo = sp => { const m = miniRect(); panTo(clamp((sp.x - m.x) / m.w, 0, 1) * WW, clamp((sp.y - m.y) / m.h, 0, 1) * WH) };
  const cancel = () => { G.mode = null; G.spawn = null; hint(''); setSel(null) };
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    const sp = local(e);
    try { cv.setPointerCapture(e.pointerId) } catch (err) { /* старый браузер */ }
    P.set(e.pointerId, { x: sp.x, y: sp.y, x0: sp.x, y0: sp.y, t0: performance.now(), btn: e.button, touch: e.pointerType === 'touch' });
    if (P.size === 2) {
      const [a, b] = [...P.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: G.view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, wx: s2w({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) };
      drag = null; clearTimeout(longT); return;
    }
    if (inMini(sp) && e.button === 0) { mini = true; miniGo(sp); return }
    drag = { x0: sp.x, y0: sp.y, vx: G.view.x, vy: G.view.y, moved: false, btn: e.button };
    if (e.pointerType === 'touch') longT = setTimeout(() => { if (drag && !drag.moved) { drag.long = true; cancel(); if (navigator.vibrate) navigator.vibrate(15) } }, 550);
  });
  cv.addEventListener('pointermove', e => {
    const sp = local(e), p = P.get(e.pointerId);
    G.mouse = { x: sp.x, y: sp.y, inside: true };
    if (p) { p.x = sp.x; p.y = sp.y }
    if (pinch && P.size >= 2) {
      const [a, b] = [...P.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      G.view.s = clamp(pinch.s * d / pinch.d, sMin(), S_MAX);
      panTo(pinch.wx.x - (mx - CW / 2) / G.view.s, pinch.wx.y - (my - CH / 2) / G.view.s);
      return;
    }
    if (mini) { miniGo(sp); return }
    if (drag) {
      const lim = e.pointerType === 'touch' ? 9 : 5;
      if (!drag.moved && Math.hypot(sp.x - drag.x0, sp.y - drag.y0) > lim) { drag.moved = true; clearTimeout(longT); cv.classList.add('grab') }
      if (drag.moved) { panTo(drag.vx - (sp.x - drag.x0) / G.view.s, drag.vy - (sp.y - drag.y0) / G.view.s); return }
    }
    const w = s2w(sp), h = inMini(sp) ? -1 : Hex.hexAt(w.x, w.y);
    if (h !== G.hover) { G.hover = h; hexInfo(h) }
    renderTip(sp);
  });
  const up = e => {
    const sp = local(e), p = P.get(e.pointerId);
    P.delete(e.pointerId); clearTimeout(longT);
    cv.classList.remove('grab');
    if (pinch) { if (P.size < 2) pinch = null; drag = null; return }
    if (mini) { mini = false; return }
    const d = drag; drag = null;
    if (!d || d.moved || d.long || e.type === 'pointercancel') return;
    if (d.btn === 2) { cancel(); return }
    if (d.btn !== 0) return;
    const w = s2w(sp);
    clickHex(Hex.hexAt(w.x, w.y), e);
    if (p && p.touch) { G.hover = Hex.hexAt(w.x, w.y); hexInfo(G.hover) }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { if (!P.size) { G.mouse = null; G.hover = -1; $('#tip').hidden = true; hexInfo(-1) } });
}

/* ---------- сведения о клетке под курсором ---------- */
let hexInfoLast = -2;
function hexInfo(h) {
  const el = $('#hexinfo');
  if (!el) return;
  if (h === hexInfoLast) return;
  hexInfoLast = h;
  if (h < 0 || !G.mapId || !G.roomId) { el.hidden = true; return }
  const m = Hex.build(G.mapId), hx = m.hexes[h], T = Rules.TCOST, d = Rules.TDEF[hx.t];
  const riv = [0, 1, 2, 3, 4, 5].filter(i => m.edge[h * 6 + i] & Hex.RIV).length;
  const fort = new Map(G.forts || []).get(h), p = G.pts.find(q => q.hex === h);
  const c = v => v === Infinity ? '—' : v;
  el.innerHTML = `<b>${p ? esc(p.n) + ' · ' : ''}${Rules.TNAME[hx.t]}</b>
    <span>${Math.round(hx.h)} м</span>${hx.road ? '<span>дорога</span>' : ''}${riv ? '<span class="bl">река</span>' : ''}${fort ? `<span class="ac">укрепления ${fort}</span>` : ''}
    <span title="Множитель обороны в этой клетке">оборона ×${String(d).replace('.', ',')}</span>
    <span class="mu" title="Стоимость входа: пешие / колёсные / гусеничные">ход ${c(T.foot[hx.t])}/${c(T.wheel[hx.t])}/${c(T.track[hx.t])}</span>
    <span class="mu">${String(Hex.colOf(h) + 1).padStart(2, '0')}${String(Hex.rowOf(h) + 1).padStart(2, '0')}</span>`;
  el.hidden = false;
}

/* ---------- плашка начала хода ---------- */
let bannerT = 0;
function showBanner(txt, sub, mine, side) {
  const el = $('#banner');
  if (!el) return;
  el.className = mine ? 'mine' : side === S ? 'east' : 'west';
  el.innerHTML = `<div class="bt">${esc(txt)}</div><div class="bs">${esc(sub)}</div>`;
  el.hidden = false; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  clearTimeout(bannerT); bannerT = setTimeout(() => { el.hidden = true }, 1900);
}

bind();
document.addEventListener('visibilitychange', () => { if (document.hidden || !G.pendingSnap) return; skipAnims(); const v = G.pendingSnap; G.pendingSnap = null; applySnapshot(v) });
Sound.init();
netConnect();
showMenu();
if (innerWidth < 960) { $('#left').classList.add('col'); $('#right').classList.add('col') }
requestAnimationFrame(loop);
