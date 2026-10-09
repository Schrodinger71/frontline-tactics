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
  units: [], ghosts: [], pts: [], vis: null, terr: null, terrStr: '', sv: null, br: [], mines: [], frontY: [],
  turn: 0, active: null, clock: '06:00', day: 1, night: false, weather: 'clear', budget: 0, income: 0, air: null, score: 0,
  scen: null, stats: null, enemyStats: null, history: [], commanders: null, role: null, over: null, limit: 30,
  mapId: null, forts: [], obst: [], cp: 0, barrage: false, smoke: [], mapPick: (() => { try { return localStorage.getItem('turn.map') || 'valley' } catch (e) { return 'valley' } })(),
  sel: null, reach: null, targets: [], hover: -1, mode: null, deploy: null, isMyTurn: false,
  view: { x: 150, y: 220, s: 5 }, pace: 1, showSupply: false, showTypes: false, visV: 0, selRiv: '', mouse: null, speed: 1, pendingSnap: null, tabR: 'unit', tabL: 'log', _overShown: false
};
function nightK() { return G.night ? 1 : 0 }
const selUnit = () => G.units.find(u => u.id === G.sel);
/* «моя» часть — под моим командованием; союзную видно и можно выбрать,
   но приказы ей отдаёт её командир (сервер чужие приказы отклоняет) */
const myUnit = u => u && !G.spec && u.side === G.side && (!G.mySeat || !u.seat || u.seat === G.mySeat);
const allyUnit = u => u && !G.spec && u.side === G.side && !myUnit(u);
/* Командный пункт командира: пока он не развёрнут, расстановку не закончить.
   Поэтому клиент сам ведёт к этому шагу — подсказкой, выбором и камерой. */
const myFob = () => G.units.find(u => myUnit(u) && UT[u.k] && UT[u.k].fob);
function needSite() {
  if (G.phase !== 'deploy' || G.spec) return null;
  const f = myFob();
  return f && !f.sited ? f : null;
}
/* уровни снабжения: цвет полоски и подпись */
const SUP_COL = { full: 'var(--gn)', ok: '#c9d36b', low: 'var(--ac)', none: 'var(--rd)' };
const SUP_NAME = { full: 'полное', ok: 'нормальное', low: 'скудное', none: 'котёл' };
/** сколько моих частей на каждом уровне снабжения */
function supSummary() {
  if (G.spec || G.phase !== 'battle') return '';
  const c = { full: 0, ok: 0, low: 0, none: 0 };
  for (const u of G.units) if (myUnit(u) && !UT[u.k].fob) c[supTier(u.sv)]++;
  return `<div class="row"><span>Частей по снабжению</span><b><span class="good">${c.full}</span> · <span style="color:#c9d36b">${c.ok}</span> · <span class="ac">${c.low}</span> · <span class="bad">${c.none}</span></b></div>`;
}
/** пункт блокирован: рядом стоит видимый противник — узел в этот ход не работает */
function fobBlocked(f) { return H.neighbors(f.hex).some(h => { const e = G.units.find(x => x.hex === h); return !!e && e.side !== f.side }) }
/** мой работающий командный пункт (развёрнут и не блокирован) — или null */
function myFobLive() { const f = myFob(); return f && f.sited && !fobBlocked(f) ? f : null }
/** клетка в секторе моего работающего пункта */
function inFobZone(hex) { const f = myFobLive(); return !!f && H.hexDist(f.hex, hex) <= UT.fob.cmd }
/** во сколько ★ обойдётся приказ: в секторе пункта — дешевле */
function orderCp(k, hex) {
  const O = ORDERS[k];
  return hex != null && hex >= 0 && inFobZone(hex) ? Math.max(1, O.cp - FOB.orderOff) : O.cp;
}
/** как зовут командира места: ник из лобби, иначе «бот» или «Командир N» */
function seatName(id) {
  const x = (G.lobby || []).find(e => e.id === id);
  if (!x) return '';
  return x.who === 'bot' ? 'бот' : x.name || ('командир ' + x.n);
}

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
  if (m.t === 'rooms') {
    M.rooms = Array.isArray(m.list) ? m.list : [];
    /* перерисовываем, только если список изменился: иначе кнопки под курсором мигали бы раз в 3 секунды */
    const el = $('#netList'), html = netListHTML();
    if (el && M.view === 'net' && el.dataset.v !== html) { el.innerHTML = html; el.dataset.v = html; drawPreviews() }
    const st = $('#netStat'); if (st) st.textContent = netStatText();
    /* на главном — счётчик открытых партий у кнопки «Сетевая игра» */
    const nc = $('#netCount');
    if (nc) { const open = M.rooms.filter(r => r.free > 0).length; nc.hidden = !open; nc.innerHTML = `<i></i>${open} ${open === 1 ? 'открыта' : 'открыто'}` }
    return;
  }
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
  G.lobbyOpen = false;
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
      const ec = (G.team || []).find(t => t.id === x.id);
      let st = '';
      if (x.who !== 'open') {
        if (G.phase === 'battle') {
          st = x.side !== G.active ? '<span class="mu">ждёт хода</span>'
            : x.done ? '<span class="mu">закончил</span>' : '<span class="good">ходит</span>';
        } else st = x.ready ? '<span class="good">готов</span>' : '<span class="mu">расставляет</span>';
      }
      const money = ec && x.side === G.side && !G.spec
        ? `<td class="lmon">${ec.budget}<i>+${ec.income}</i></td>` : '<td></td>';
      return `<tr class="${mine ? 'on' : ''}"><td>${x.n}</td><td>${who}</td>${money}<td>${st}</td></tr>`;
    }).join('');
    return `<div class="lcol"><div class="lhd" style="color:${COL[sd]}">${esc(SIDE_NAME[sd])}</div>
      <table class="ltab">${rows}</table></div>`;
  };
  const open = list.filter(x => x.who === 'open').length;
  const sub = open
    ? `Ждём игроков: ${open}. Передайте им код — кнопка «Войти» в меню.`
    : G.phase === 'battle'
      ? `Ходит ${esc(SIDE_NAME[G.active] || '')}.`
      : 'Все места заняты.';
  return `<div class="lbox">
    <h2>Партия ${esc(G.roomId || '')}</h2>
    <p class="mu">${sub}</p>
    <div class="lcols">${side(N)}${side(S)}</div>
    ${(G.team || []).length > 1 && !G.spec ? `<p class="lnote">Очки у каждого командира свои: доход стороны
      (${G.sideIncome} за ход) делится поровну между ${G.team.length} командирами. Покупает каждый на своё,
      чужой частью не командует. У вашей команды сейчас ${G.team.reduce((a, x) => a + x.budget, 0)} очк.</p>` : ''}
    <p class="acts"><button class="btn pri" id="btnLobbyClose">${G.phase === 'battle' ? 'Закрыть' : 'К расстановке'}</button></p></div>`;
}
function renderLobby() {
  const el = $('#lobby');
  if (!el) return;
  const has = !!G.roomId && (G.lobby || []).length > 1;
  /* сам показывается, пока ждём игроков перед боем; в бою — по кнопке «Состав» */
  const auto = has && !G.spec && G.phase === 'deploy' && !G.lobbyHidden;
  const show = has && (G.lobbyOpen || auto);
  el.hidden = !show;
  if (show) el.innerHTML = lobbyHTML();
  const b = $('#btnTeams');
  if (b) b.style.display = has ? '' : 'none';
}

function skipAnims() { ANIMS.q.length = 0; ANIMS.cur = null; ANIMS.pos.clear(); G.pendingAt = 0 }
function applySnapshot(v) {
  G.pendingAt = 0;
  /* карта могла смениться — берём её сетку до любых расчётов геометрии */
  if (v.map && v.map !== G.mapId) useMap(v.map);
  /* готовность мест приходит в снимке, ники — в сообщении seats: сводим вместе */
  if (Array.isArray(v.seats) && (G.lobby || []).length) {
    const by = new Map(v.seats.map(x => [x.id, x]));
    G.lobby = G.lobby.map(x => Object.assign({}, x, by.get(x.id) ? { ready: by.get(x.id).ready, done: by.get(x.id).done } : {}));
  } else if (Array.isArray(v.seats) && !(G.lobby || []).length) G.lobby = v.seats;
  if (v.seat) G.mySeat = v.seat;
  G.waiting = v.waiting || [];
  G.team = v.team || null; G.sideIncome = v.sideIncome || 0;
  Object.assign(G, {
    phase: v.phase, units: v.units, ghosts: v.ghosts, pts: v.pts, vis: v.vis ? new Set(v.vis) : null,
    mapId: v.map, forts: v.forts, obst: v.obst, cp: v.cp, barrage: v.barrage, counter: v.counter, smoke: v.smoke || [],
    /* территория и поле снабжения приходят строкой: символ на клетку */
    terrStr: v.terr || '', terr: v.terr ? Uint8Array.from(v.terr, c => c.charCodeAt(0) - 48) : null,
    /* снабжение: '0'–'9','a' — поле, 'A'–'K' — клетка на линии снабжения (дорога) */
    sv: v.sv ? Uint8Array.from(v.sv, c => c >= 'A' && c <= 'K' ? c.charCodeAt(0) - 65 : c === 'a' ? 10 : c.charCodeAt(0) - 48) : null,
    svNet: v.sv ? Uint8Array.from(v.sv, c => c >= 'A' && c <= 'K' ? 1 : 0) : null, svStr: v.sv || '',
    svSrc: v.svSrc || [],
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
  /* командный пункт: просим развернуть, пока он не на месте, и отмечаем, когда встал */
  if (G.phase !== 'deploy') { G._siteAsked = false; G._sited = false }
  else if (needSite()) { G._sited = false; maybeSitePrompt() }
  else if (!G.spec && myFob() && !G._sited) { G._sited = true; if (G._siteAsked) { toast('Командный пункт развёрнут'); hint('') } }
  computeSel();
  renderUI(true);
  renderLobby();
  if (G.over && !G._overShown) { G._overShown = true; setTimeout(showEnd, 700) }
}
function firstView() {
  const own = G.units.filter(u => G.spec || u.side === G.side);
  let x = H.WW / 2, y = H.WH / 2;
  if (G.phase === 'deploy' && !G.spec && G.deploy && G.deploy.length) { const cs = G.deploy.map(h => H.center(h)); x = cs.reduce((a, c) => a + c.x, 0) / cs.length; y = H.WH / 2 }
  else if (own.length) { const cs = own.map(u => H.center(u.hex)); x = cs.reduce((a, c) => a + c.x, 0) / cs.length; y = cs.reduce((a, c) => a + c.y, 0) / cs.length }
  const s = G.spec ? sMin() : clamp(S_WORK() * .8, sMin(), S_MAX);
  G.view.x = x; G.view.y = y; G.view.s = s; clampView();
  CAM.x = G.view.x; CAM.y = G.view.y; CAM.s = G.view.s; CAM.ax = null; CAM.moving = false;
}
function deployHexes() {
  const md = MAPS[G.mapId] || {}, z = G.scen ? G.scen.deploy : md.deploy ? md.deploy[G.side] : DEPLOY_X[G.side], out = [], hx = H.build(G.mapId).hexes;
  for (let h = 0; h < H.NH; h++) { const x = H.center(h).x; if (z && x >= z[0] && x <= z[1] && hx[h].t !== 'lake') out.push(h) }
  return out;
}

/** клетки для подкреплений: свои точки и соседние с ними, свободные, без противника рядом */
function spawnHexes(k) {
  if (G.phase !== 'battle' || G.spec) return null;
  const hx = H.build(G.mapId).hexes, occ = new Map(G.units.map(u => [u.hex, u])), out = new Set();
  const enemyAt = h => { const o = occ.get(h); return o && o.side !== G.side };
  /* высадка — у своих точек и у своего работающего командного пункта */
  const f = myFobLive(), seeds = G.pts.filter(p => p.owner === G.side).map(p => p.hex);
  if (f) seeds.push(f.hex);
  for (const c of seeds) {
    for (const h of H.within(c, 1)) {
      if (out.has(h) || occ.has(h) || hx[h].t === 'lake' || (hx[h].t === 'mount' && UT[k].cls !== 'foot' && !hx[h].road)) continue;
      if (h !== c && enemyAt(c)) continue;
      if (H.neighbors(h).some(enemyAt)) continue;
      out.add(h);
    }
  }
  return out;
}

/* ---------- правила на клиенте: что видно стороне ---------- */
function clientCtx() {
  const occ = new Map();
  for (const u of G.units) occ.set(u.hex, u);
  /* секторы командиров своей стороны: место → клетки вокруг его штаба */
  const cmd = new Map();
  for (const h of G.units) {
    /* сектор дают оба командных объекта, как на сервере: подвижный штаб и
       стационарный пункт. Штаб, который шёл в этот ход, сектора не держит */
    if (h.side !== G.side || !UT[h.k] || !UT[h.k].cmd) continue;
    if (!UT[h.k].fob && h.moved) continue;
    const key = h.seat || h.side;
    if (!cmd.has(key)) cmd.set(key, new Set());
    const set = cmd.get(key);
    for (const x of H.within(h.hex, UT[h.k].cmd)) set.add(x);
  }
  if (G.mySeat && !cmd.has(G.mySeat)) cmd.set(G.mySeat, new Set());
  const mines = new Map(); for (const m of G.mines || []) mines.set(m.hex, { side: m.side });
  const wx = wxById(G.weather);
  const support = { n: new Set(), s: new Set() };
  for (const u of G.units) if (u.support && UT[u.k].bomb) for (const h of H.within(u.hex, UT[u.k].bomb.rng)) support[u.side].add(h);
  /* H — та же сетка гексов, что у сервера: без неё Rules.reachable падает и части не ходят */
  return { H, map: H.build(G.mapId), br: new Map(G.br || []), occ, mines, forts: new Map(G.forts || []), obst: new Set(G.obst || []), support, smoke: new Set(G.smoke || []), side: G.side, mud: wx.mud < .8, night: G.night, acc: wx.acc || 1, cmd, counter: G.counter && !G.spec ? new Set([].concat(...G.pts.filter(p => p.home === G.side).map(p => H.within(p.hex, 1)))) : null };
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
    for (const e of foes) if (H.hexDist(u.hex, e.hex) <= T.bomb.rng) {
      const b = Rules.bombardOdds(ctx, Rules.firePow(u), e, { th: T.th, barrage: !!G.barrage, sp: u.sp });
      G.targets.push({ hex: e.hex, id: e.id, lb: `−${b.loss[0]}…${b.loss[1]} · ⚡${b.supp[0]}…${b.supp[1]}`, col: '#ffb070', bomb: b });
    }
  } else if (T.atk.soft >= 2 && u.k !== 'hq' && u.org >= 20) {
    for (const e of foes) if (H.hexDist(u.hex, e.hex) === 1) {
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
  if (!G.spec && G.team && G.team.length > 1) {
    const all = G.team.reduce((a, x) => a + x.budget, 0);
    $('#hdBudget').parentNode.title =
      `Ваши очки: ${G.budget}. У всей команды: ${all}.\n`
      + `Доход стороны ${G.sideIncome} за ход делится поровну между командирами (${G.team.length}), `
      + 'остаток достаётся первым — сумма долей точно равна доходу стороны.';
  }
  $('#hdIncome').textContent = G.spec ? `+${G.income.n} · +${G.income.s}` : '+' + G.income;
  $('#hdCp').textContent = G.spec ? `${(G.cp || {}).n || 0} · ${(G.cp || {}).s || 0}` : `${G.cp || 0} из ${CP.max}`;
  const who = G.phase === 'deploy' ? 'Расстановка' : G.over ? 'Итог' : G.spec ? 'Ходит ' + SIDE_GEN[G.active] : G.isMyTurn ? 'Ваш ход' : 'Ход противника…';
  $('#hdActive').textContent = who;
  $('#hdActive').className = G.isMyTurn || G.phase === 'deploy' ? 'ac' : 'mu';
  const btn = $('#btnEnd');
  btn.hidden = G.spec || !!G.over;
  if (G.phase === 'deploy') {
    /* готовность — у места, а не у стороны: у стороны может быть до трёх командиров,
       и «Готов» первого не должен запирать кнопку остальным */
    const site = needSite(), me = G.mySeat || G.side, done = !!(G.ready && G.ready[me]);
    const mates = (G.lobby || []).filter(x => x.side === G.side && x.id !== me && x.who !== 'bot');
    btn.textContent = done ? (mates.some(x => !x.ready) ? 'Ждём союзников…' : 'Ждём соперника…') : site ? 'Сначала — КП' : 'Готов к бою';
    btn.classList.toggle('warn', !!site && !done);
    btn.title = site ? 'Разверните командный пункт: кликните по клетке в своей зоне расстановки' : '';
    btn.disabled = done;
  }
  else { btn.classList.remove('warn'); btn.title = ''; const left = G.units.filter(u => myUnit(u) && (u.mp > 0 || !u.acted)).length; btn.textContent = G.isMyTurn ? `Конец хода${left ? ' (' + left + ')' : ''}` : 'Ход противника'; btn.disabled = !G.isMyTurn }
  const air = !G.spec && G.air && G.phase === 'battle';
  $('#airBox').hidden = !air;
  if (air) { $('#btnStrike').textContent = `✈ Удар ${G.air.strike}`; $('#btnRecon').textContent = `👁 Разведка ${G.air.recon}`; $('#btnStrike').disabled = !G.isMyTurn || !G.air.strike; $('#btnRecon').disabled = !G.isMyTurn || !G.air.recon; $('#btnStrike').classList.toggle('on', G.mode === 'air:strike'); $('#btnRecon').classList.toggle('on', G.mode === 'air:recon') }
}
function bar(label, v, max, col, txt) {
  const k = clamp(v / max, 0, 1);
  return `<div class="row"><span>${label}</span><b>${txt != null ? txt : Math.round(k * 100) + '%'}</b></div><div class="bar"><div style="width:${k * 100}%;background:${col}"></div></div>`;
}
/* ---------- характеристики типа: что брать и для чего ---------- */
const CLS_NAME = { foot: 'пешком', wheel: 'колёса', track: 'гусеницы' };
const ARM_NAME = { soft: 'нет', light: 'лёгкая', hard: 'тяжёлая' };
/** для чего тип хорош — выводится из его цифр, чтобы подсказка не врала */
function goodFor(T) {
  const g = [];
  if (T.bomb) g.push(T.bomb.area ? 'залпы по площади' : 'огонь с закрытых позиций');
  if (T.atk.hard >= 8) g.push('против танков');
  if (T.atk.soft >= 7) g.push('против пехоты');
  if (T.def >= 7) g.push('держать рубеж');
  if (T.mp >= 6) g.push('манёвр и обход');
  if (T.vis >= 4) g.push('разведка');
  if (T.atd) g.push('засада на технику');
  if (T.aa) g.push('прикрытие от авиации');
  if (T.eng) g.push('мосты, мины, укрепления');
  if (T.cmd) g.push('управление сектором');
  return g;
}
/** Блок характеристик: атака по трём классам целей, оборона, огонь — полосками
    от максимума среди всех типов; свойства — плашками; «Хорош» — по цифрам. */
function statsHTML(T, compact) {
  const MAXA = 10, MAXD = 9, MAXF = 10;
  const sb = (lbl, v, max, cls) => `<div class="sb ${cls || ''}"><span>${lbl}</span><i><u style="width:${Math.round(100 * clamp(v / max, 0, 1))}%"></u></i><b>${v}</b></div>`;
  const chips = [`ход ${T.mp}`, CLS_NAME[T.cls], `обзор ${T.vis}`, `броня: ${ARM_NAME[T.arm]}`];
  if (usesFuel(T)) chips.push('нужно топливо');
  if (T.th) chips.push('тепловизоры');
  if (T.cap) chips.push('берёт точки');
  if (T.stl) chips.push('малозаметна');
  if (T.atd) chips.push('ПТ-оборона ×1,8');
  if (T.aa) chips.push(`ПВО ${T.aa} кл.`);
  if (T.cmd) chips.push(`сектор ${T.cmd} кл.`);
  const good = goodFor(T);
  return `<div class="stats${compact ? ' cmp' : ''}">
    <div class="sbars">${sb('по пехоте', T.atk.soft, MAXA)}${sb('по БТР и БМП', T.atk.light, MAXA)}${sb('по танкам', T.atk.hard, MAXA)}${sb('оборона', T.def, MAXD, 'def')}${
      T.bomb ? sb(`огонь · ${T.bomb.rng} кл.${T.bomb.area ? ' · площадь' : ''}`, T.bomb.pow, MAXF, 'fire') : ''}</div>
    <div class="chips">${chips.map(c => `<span>${c}</span>`).join('')}</div>
    ${good.length ? `<div class="goodfor">Хорош: ${good.join(', ')}</div>` : ''}</div>`;
}
/** сила с подавленными шагами: «8 из 10 · подавлено 2» */
function strText(u, T) {
  const su = Math.min(u.su || 0, u.str);
  return `${u.str} из 10${su ? ` · <span class="ac">подавлено ${su}</span>` : ''} · ${elCount(u.k, u.str)} ${T.eln}`;
}
/** приданный специалист или кнопки придания */
function specHTML(u, T, canAttach) {
  if (u.att) { const S = SPECS[u.att]; return `<div class="row"><span>Специалист</span><b class="spec">${esc(S.n)}</b></div><p class="hint">${esc(S.d)}</p>` }
  const list = SPEC_ORDER.filter(k => SPECS[k].for(T));
  if (!canAttach || !list.length) return list.length && myUnit(u) ? '<div class="row"><span>Специалист</span><b class="mu">нет</b></div>' : '';
  return `<div class="lbl">Придать специалиста</div><div class="specs">${list.map(k => { const S = SPECS[k], off = G.budget < S.price;
    return `<button class="btn sm spb ${off ? 'off' : ''}" data-a="att:${k}" ${off ? 'disabled' : ''} title="${esc(S.d)}"><b>${esc(S.n)}</b> · ${S.price}<span>${esc(S.d)}</span></button>` }).join('')}</div>
    ${G.phase === 'battle' ? '<p class="hint">В бою — вместо действий в этот ход, на снабжении 3+ и без противника рядом. Один на часть, погибает вместе с ней.</p>' : '<p class="hint">Один на часть, погибает вместе с ней. «Вернуть» часть — вернёт и его цену.</p>'}`;
}
function unitCard(u) {
  const T = utFor(u.side)[u.k], own = myUnit(u) || allyUnit(u) || G.spec, hx = H.build(G.mapId).hexes[u.hex], fort = new Map(G.forts || []).get(u.hex);
  const head = `<div class="uhead">${iconHTML(unitIcon(u.k, u.side), 'ic big', own && !(G.spec && u.side === S) ? 'own' : 'enemy')}<div><h3>${u.cs ? '«' + esc(u.cs) + '»' : esc(T.sh)}</h3><div class="sub">${esc(T.n)}${
  allyUnit(u) ? ` <i class="allytag">союзник${seatName(u.seat) ? ' · ' + esc(seatName(u.seat)) : ''}</i>` : ''}</div>
    ${G.spec ? `<div class="sub ${u.side === N ? 'sdn' : 'sds'}">${SIDE_NAME[u.side]}</div>` : ''}</div></div>`;
  const strCls = u.str <= 3 ? 'var(--rd)' : u.str <= 6 ? 'var(--ac)' : 'var(--gn)';
  if (!own) return `<div class="card">${head}
    ${bar('Сила', u.str, MAX_STR, strCls, strText(u, T))}
    <div class="row"><span>Боеприпасы</span><b>${pips(u.sp)}</b></div>${u.hold ? '<p class="ustate"><span class="ac">стоит насмерть — не отходит</span></p>' : ''}${u.mil ? '<p class="ustate">ополчение</p>' : ''}
    ${u.att ? specHTML(u, T, false) : ''}
    <div class="row"><span>Местность</span><b>${Rules.TNAME[hx.t]}, ${Math.round(hx.h)} м${u.ent ? ', окоп ' + u.ent : ''}</b></div>
    ${u.hb ? '<p class="ustate"><span class="good">связан боем — атака другим родом войск ×1,15</span></p>' : ''}
    <div class="lbl">Характеристики</div>${statsHTML(T)}
    <p class="hint">${esc(ROLE_TXT[u.k])}</p></div>`;
  const acts = [];
  let canAttach = false;
  if (G.phase === 'deploy' && !G.spec) {
    canAttach = myUnit(u);
    if (!u.pre) acts.push(`<button class="btn sm" data-a="sell">Вернуть (+${T.price + (u.att ? SPECS[u.att].price : 0)})</button>`);
    acts.push(T.fob && !u.sited
      ? '<span class="hint warn">Пункт не развёрнут: кликните по клетке в своей зоне — он встанет там. Без этого бой не начать.</span>'
      : '<span class="hint">Клик по клетке зоны — переставить.</span>');
  }
  else if (G.isMyTurn && myUnit(u)) {
    canAttach = !u.acted && !u.moved && (u.sv || 0) >= SUPPLY.replaceMin;
    if (!u.acted && !u.moved) acts.push('<button class="btn sm" data-a="dig">Окопаться <kbd>D</kbd></button>');
    if (!u.acted && !T.bomb && T.atk.soft >= 2 && u.k !== 'hq') acts.push('<button class="btn sm" data-a="ambush" title="Часть не действует, а в ход противника встречает огнём того, кто войдёт рядом">Засада <kbd>A</kbd></button>');
    if (u.str < MAX_STR && !u.acted && !u.moved) {
      const near = inFobZone(u.hex), rc = Math.max(1, Math.round(T.price / 10 * (near ? 1 - FOB.replaceOff : 1)));
      acts.push(`<button class="btn sm" data-a="replace" title="${near ? 'Склады командного пункта: на треть дешевле' : ''}">Пополнить (${rc} за шаг)${near ? ' <i class="cheap">КП</i>' : ''}</button>`);
    }
    const ob = (k, ok, why) => {
      const O = ORDERS[k], cp = orderCp(k, u.hex);
      acts.push(`<button class="btn sm" data-a="ord:${k}" ${ok && G.cp >= cp ? '' : 'disabled'} title="${esc(O.d)}${cp < O.cp ? ' — в секторе командного пункта дешевле' : ''}${why ? ' — ' + esc(why) : ''}">${esc(O.n)} · ${cp}★${cp < O.cp ? ' <i class="cheap">КП</i>' : ''}</button>`);
    };
    ob('march', !u.acted && !u.march && (!usesFuel(T) || u.fu > 0));
    ob('hold', !u.hold);
    if (u.sp < SUPPLY.max || (usesFuel(T) && u.fu < SUPPLY.max)) ob('airdrop', wxById(G.weather).fly);
    if (T.eng && !u.acted) acts.push('<button class="btn sm" data-a="eng:fort">Укрепления…</button><button class="btn sm" data-a="eng:obst">Заграждения…</button><button class="btn sm" data-a="eng:mine">Мины…</button><button class="btn sm" data-a="eng:bridge">Понтон…</button><button class="btn sm" data-a="eng:blow">Взорвать мост…</button><button class="btn sm" data-a="eng:repair">Восстановить мост…</button><button class="btn sm" data-a="eng:clear">Разминировать…</button>');
  }
  const st = [];
  if (!u.supplied) st.push(`<span class="bad">в котле${u.cut ? ' ' + u.cut + ' х.' : ''}</span>`);
  else if (supTier(u.sv) === 'low') st.push('<span class="ac">скудное снабжение — запас не выше 2</span>');
  if (u.sp <= 0) st.push('<span class="bad">боеприпасы кончились — не атакует, тает</span>');
  if (usesFuel(T) && u.fu <= 0) st.push('<span class="bad">нет топлива — техника стоит</span>');
  if (u.hold) st.push('<span class="ac">стоять насмерть</span>');
  if (u.march) st.push('форсированный марш');
  if (u.exploit) st.push('<span class="good">прорыв — может действовать ещё</span>');
  if (u.mil) st.push('ополчение');
  if (u.su) st.push(`<span class="ac">подавлено ${Math.min(u.su, u.str)} шагов — не воюют до своего хода</span>`);
  if (u.org < 20) st.push('<span class="bad">дезорганизованы — не атакуют</span>');
  if (u.reload > 0) st.push('перезарядка');
  if (u.amb) st.push('<span class="good">в засаде</span>');
  if (u.support) st.push('<span class="ac">огонь поддержки готов</span>');
  if (T.fob && own) st.push(u.sited === 0 ? '<span class="bad">не развёрнут</span>'
    : fobBlocked(u) ? '<span class="bad">блокирован — противник рядом, узел не работает</span>'
    : '<span class="good">узел работает: подвоз, подкрепления, +1★</span>');
  return `<div class="card">${head}
    ${st.length ? `<p class="ustate">${st.join(' · ')}</p>` : ''}
    ${bar('Сила', u.str, MAX_STR, strCls, strText(u, T))}
    ${bar('Мораль', u.org, 100, u.org < 30 ? 'var(--rd)' : '#8fb8ff')}
    <div class="row"><span>Боеприпасы</span><b>${pips(u.sp)}</b></div>
    ${usesFuel(T) ? `<div class="row"><span>Топливо</span><b>${pips(u.fu)}</b></div>` : ''}
    ${G.phase === 'battle' ? bar('Снабжение клетки', u.sv || 0, SUPPLY.top, SUP_COL[supTier(u.sv)], `${u.sv || 0} из ${SUPPLY.top} · ${SUP_NAME[supTier(u.sv)]}`) : ''}
    ${G.phase === 'battle' ? bar('Очки хода', u.mp, T.mp, 'var(--bl)', `${u.mp} из ${T.mp}${u.acted ? ' · действие сделано' : ''}`) : ''}
    <div class="row"><span>Местность · окоп</span><b>${Rules.TNAME[hx.t]}, ${Math.round(hx.h)} м · ${u.ent || 0}${fort ? ' · укрепления ' + fort : ''}</b></div>
    <div class="row"><span>Опыт</span><b>${u.xp >= .6 ? 'ветераны' : u.xp >= .3 ? 'обстрелянные' : 'необстрелянные'} ${'★'.repeat(1 + Math.floor(u.xp * 2.99))}</b></div>
    ${T.eng ? `<div class="row"><span>Мин в запасе</span><b>${u.mines}</b></div>` : ''}
    <div class="row"><span>Командир</span><b>${esc(u.trait || '—')}</b></div>
    ${specHTML(u, T, canAttach)}
    <div class="lbl">Характеристики</div>${statsHTML(T)}
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
    <div class="ords">${ORDER_LIST.map(k => { const O = ORDERS[k], cp = O.tgt === 'unit' && sel ? orderCp(k, sel.hex) : O.cp;
      const off = !can || G.cp < cp || (k === 'barrage' && G.barrage) || (k === 'counter' && (G.counter || !G.pts.some(p => p.home === G.side && p.owner !== G.side))) || (O.tgt === 'unit' && !(sel && myUnit(sel)));
      return `<div class="ord ${off ? 'off' : ''} ${G.mode === 'ord:' + k ? 'on' : ''}" data-ord="${k}"><div class="snm"><b>${esc(O.n)}</b><span>${esc(O.d)}${O.tgt === 'unit' ? ' · <i>на выбранную часть</i>' : O.tgt === 'hex' ? ' · <i>на клетку</i>' : ''}</span></div><div class="cpc ${cp < O.cp ? 'cheap' : ''}">${cp}★</div></div>` }).join('')}</div>
    ${sel && myUnit(sel) ? `<p class="hint">Выбрана: «${esc(sel.cs)}» (${esc(UT[sel.k].sh)}).</p>` : ''}
    <div class="lbl">Снабжение</div>
    <p class="hint">Снабжение идёт <b>по дорогам</b>: от тыловых станций у своего края (10), своих городов-складов (7–9) и командного пункта (8)
    почти без потерь по дорожной сети своей земли, а с дороги стекает в поле — минус 2 за клетку, по лесу и болоту больше. Дальше 3–4 клеток
    от дороги подвоза нет. Чужая земля, взорванный мост или зона контроля противника без вашей части рвут линию, и обойти разрыв полем нельзя.</p>
    <p class="hint"><b class="good">7–10</b> — запас и мораль быстро восстанавливаются, пополнение до 3 шагов;
    <b class="ac">4–6</b> — медленнее; <b class="ac">1–3</b> — запас не выше 2, мораль еле растёт, пополнение по шагу;
    <b class="bad">0</b> — котёл: запас тает, дальше потери и сдача.</p>
    ${supSummary()}
    <div class="acts"><button class="btn sm ${G.showSupply ? 'on' : ''}" data-a="supply">Снабжение на карте <kbd>S</kbd></button></div></div>`;
}
function renderUnit() {
  const u = selUnit();
  if (u) { $('#rc').innerHTML = unitCard(u); return }
  const site = needSite();
  $('#rc').innerHTML = `<div class="card"><h3>${G.phase === 'deploy' ? 'Расстановка' : 'Приказы'}</h3>
    ${site ? '<p class="hint warn"><b>Шаг 1 — командный пункт.</b> Он ещё не развёрнут: выберите его и кликните по клетке в своей зоне. Вокруг пункта — сектор управления.<br><button class="btn sm" data-a="site">Показать пункт</button></p>' : ''}
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
      return `<div class="shopItem ${off ? 'off' : ''} ${G.mode === 'buy:' + k ? 'on' : ''}" data-buy="${k}"><div class="shead">${iconHTML(unitIcon(k, G.side), 'ic')}<div class="snm"><b>${esc(T.n)}</b><span>${esc(ROLE_TXT[k])}</span></div><div class="sprice">${T.price}</div></div>${statsHTML(T, true)}</div>` }).join('')}</div>
    <div class="lbl">Приданные специалисты</div>
    <p class="hint">Придаются уже купленной части — выберите её и нажмите в карточке «Придать». Один на часть.</p>
    <div class="speclist">${SPEC_ORDER.map(k => { const S = SPECS[k], who = unitsFor(G.spec ? N : G.side).filter(t => S.for(utFor(G.spec ? N : G.side)[t])).map(t => utFor(G.spec ? N : G.side)[t].sh);
      return `<div class="srow2"><b>${esc(S.n)}</b><span class="sprice">${S.price}</span><span class="mu">${esc(S.d)}</span><span class="who">кому: ${who.join(', ')}</span></div>` }).join('')}</div></div>`;
}
function renderHQ() {
  const c = G.commanders || {}, w = wxById(G.weather);
  const side = sd => `<div class="row"><span>${SIDE_NAME[sd]} · ${esc(ROLE_LABEL[G.role && G.role[sd]] || '')}</span><b>${c[sd] ? esc(c[sd].name) + ' · ' + esc(c[sd].trait) : ''}</b></div>`;
  $('#rc').innerHTML = `<div class="card"><h3>${esc(G.scen ? G.scen.n : MODE_LABEL[G.mode0] || 'Операция')}</h3>
    ${G.scen ? `<p class="hint">${esc(G.scen.brief)}</p>` : '<p class="hint">Перевес каждый ход смещается на разницу весов удержанных точек; ±100 — победа.</p>'}
    ${side(N)}${side(S)}
    <div class="lbl">Перевес по ходам</div>${histSVG(G.history) || '<p class="hint">Пока рано.</p>'}
    <div class="lbl">Погода: ${esc(w.n)}</div><p class="hint">${esc(w.d)}</p>
    <div class="acts"><button class="btn sm ${G.showSupply ? 'on' : ''}" data-a="supply">Снабжение на карте <kbd>S</kbd></button>
      <button class="btn sm ${G.showCmd ? 'on' : ''}" data-a="cmd">Секторы командиров <kbd>H</kbd></button></div>
    ${G.vsBot && !G.spec ? '' : `<div class="row"><span>Код партии</span><b class="ac">${esc(G.roomId)}</b></div>`}</div>`;
}
function renderPts() {
  $('#lc_pts').innerHTML = G.pts.map(p => `<div class="ptn" data-go="${p.hex}"><div class="pn"><b>${esc(p.n)}</b><span class="mu">${p.city ? 'город' : 'узел'} · вес ${p.w}</span></div><b class="${p.owner === N ? 'sdn' : 'sds'}">${SIDE_NAME[p.owner]}</b></div>`).join('');
}
function statRows(a, b, la, lb) {
  const ks = UT_ORDER.filter(k => (a && a[k]) || (b && b[k]));
  if (!ks.length) return '<p class="hint">Потерь пока нет.</p>';
  return `<table class="st"><tr><th></th><th>${la}</th><th>${lb}</th></tr>${ks.map(k => `<tr><td>${iconHTML(unitIcon(k, G.side), 'ic sm')}${UT[k].sh}</td><td class="bad">${(a && a[k]) || ''}</td><td class="good">${(b && b[k]) || ''}</td></tr>`).join('')}</table>`;
}
/** состав партии для вкладки «Сводка»: кто за какую команду, ник, очки, состояние */
function rosterCard() {
  const list = G.lobby || [];
  if (list.length < 2) return '';
  const row = x => {
    const ec = (G.team || []).find(t => t.id === x.id);
    const mine = x.id === G.mySeat;
    const who = x.who === 'bot' ? '<i class="lb bot">бот</i>'
      : x.who === 'open' ? '<i class="lb open">ждём</i>'
      : `${esc(x.name || 'Командир ' + x.n)}${mine ? '<i class="lb me">вы</i>' : ''}`;
    let st = '';
    if (x.who !== 'open') {
      if (G.phase === 'battle') st = x.side !== G.active ? '' : x.done ? 'закончил' : 'ходит';
      else st = x.ready ? 'готов' : 'ставит';
    }
    const money = ec && x.side === G.side && !G.spec ? `${ec.budget}` : '';
    return `<div class="srow ${mine ? 'on' : ''}"><span class="sdot" style="background:${COL[x.side]}"></span>
      <span class="snm2">${who}</span><span class="smon">${money}</span><span class="sst">${st}</span></div>`;
  };
  const col = sd => `<div class="lbl" style="color:${COL[sd]}">${esc(SIDE_NAME[sd])}</div>`
    + list.filter(x => x.side === sd).map(row).join('');
  return `<div class="card">${col(N)}${col(S)}
    ${(G.team || []).length > 1 && !G.spec
      ? `<p class="hint">Очки у каждого командира свои: доход стороны (${G.sideIncome}/ход) делится поровну между ${G.team.length} командирами.</p>`
      : ''}</div>`;
}
function renderSum() {
  const st = G.stats;
  if (!st) return;
  $('#lc_sum').innerHTML = rosterCard() + `<div class="card">
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
    <p><b>Территория и фронт.</b> Каждая клетка чья-то. Часть, прошедшая через клетку, забирает её и соседние — если те не прикрыты противником (рядом нет его частей) и это не его город: город берут, только войдя в него. Пустой карман чужой земли, окружённый вашей, переходит к вам. Линия фронта — граница территорий.</p>
    <p><b>Снабжение</b> (клавиша <b>S</b>) идёт <b>по дорогам</b>, как в Unity of Command. Источники — тыловые станции у вашего края карты (10), свои города-склады (7–9) и командный пункт (8). По дорожной сети своей земли снабжение расходится почти без потерь (на карте — синие линии), а с дороги стекает в поле: минус 2 за клетку, по лесу, болоту и горам больше, через реку без моста ещё дороже — дальше 3–4 клеток от дороги подвоза нет. Линию рвут чужая земля, взорванный мост и <b>зона контроля противника</b>, если в ней не стоит ваша часть; обойти разрыв полем нельзя — из поля снабжение на дорогу не возвращается. Воюйте вдоль дорог и режьте чужие. В дождь и снег грунтовки раскисают: в поле снабжение тает быстрее (до −3,2 за клетку), по дорогам — как прежде. От снабжения зависят восстановление боеприпасов и топлива, морали и пополнение: 7–10 — быстро и до 3 шагов, 4–6 — медленнее, 1–3 — запас не выше 2, 0 — котёл: запас тает, потом потери и сдача. Высаживать подкрепления можно только туда, куда снабжение доходит.</p>
    <p><b>Приказы штаба</b> (★): артподготовка, <b>контрудар</b> (атаки у ваших потерянных исходных точек ×1,3), форсированный марш, стоять насмерть, дымовая завеса, снабжение по воздуху, резерв ставки.</p>
    <p><b>Подавленные шаги.</b> Бой и огонь не только убивают, но и прижимают: часть шагов подавлена (оранжевые на шкале фишки, ⚡) и не воюет до начала своего хода — цифра на фишке показывает действующие шаги. Огонь больше прижимает, чем убивает: подготовьте атаку артиллерией и бейте в тот же ход. Часть, у которой подавлены все шаги, не атакует, а в обороне отходит. В начале своего хода подавленные возвращаются: на снабжении 4+ — все, на 1–3 — половина, в котле — по одному.</p>
    <p><b>Боеприпасы и топливо.</b> У части два запаса по 0–3. Боеприпасы — для боя: без них нет атаки и огня, оборона слабее. Топливо — только технике: на 2 — минус очко хода, на 1 — половина хода, на 0 — машина стоит (⛽ на фишке). Пехоте топливо не нужно: из котла она уходит пешком, а танки встают. Оба запаса пополняются по снабжению клетки, «Снабжение по воздуху» добавляет по 2.</p>
    <p><b>Приданные специалисты.</b> К части можно придать одного специалиста за очки — в карточке части или справка во вкладке «Закупка»: штурмовые сапёры (атака по городу, окопу, укреплениям ×1,3), противотанковый взвод (против брони атака ×1,2, оборона ×1,25), разведдозор (обзор +1, ночью не слепнет), тяжёлая батарея (огонь артиллерии ×1,25), зенитный взвод (авиаудар по части срывается в 45% случаев). В бою придание — вместо действий в этот ход, на снабжении 3+ и без противника рядом. Специалист погибает вместе с частью.</p>
    <p><b>Опыт.</b> Части растут: «обстрелянные» ★ и «ветераны» ★★ бьют и держатся лучше.</p>
    <p><b>Перевес</b> — счёт операции, он же условие победы. В конце каждого хода к нему прибавляется разница
    весов точек: ваши города и узлы минус города противника (вес крупного города больше). Держите больше — перевес
    растёт в вашу пользу, потеряли город — пошёл назад. Дошёл до <b>+100</b> — вы победили, до <b>−100</b> — проиграли;
    если срок операции истёк раньше, побеждает тот, кто впереди. Число и темп за ход видны наверху, график — во вкладке «Сводка».</p>
    <p><b>Управление: сектор командира.</b> Части внутри сектора ходят дальше и бьют сильнее (×1,1), вне его — хуже (×0,9).
    Сектор даёт только <b>свой</b> командный объект, чужой не считается: поэтому сторона с несколькими командирами естественно
    делится на направления. <kbd>H</kbd> — показать секторы на карте: свой жёлтым, союзные зелёным.</p>
    <p>Командных объекта два. <b>Штаб бригады</b> — подвижный: ездит за наступающими частями, но в тот ход, когда он шёл,
    сектора не держит. <b>Командный пункт</b> (КП) — укреплённый и неподвижный, <b>один на командира</b>: его
    <b>обязательно ставят при расстановке</b>, и до этого нельзя нажать «Готов». Он хорошо держится (оборона 9),
    сектор даёт всегда, взамен потерянного можно поставить новый.</p>
    <p><b>КП — тыловой узел направления,</b> и в этом вся разница между ним и штабом. Он разом даёт четыре вещи:
    <b>подвоз</b> — источник снабжения ${SUPPLY.fob} из 10 прямо за передним краем (наступление перестаёт выдыхаться, когда уходит от своих городов);
    <b>ворота подкреплений</b> — купленные части высаживаются у него, а не только в городе;
    <b>склады</b> — пополнение в его секторе на треть дешевле;
    <b>связь</b> — +1★ за ход и приказы частям в его секторе на 1★ дешевле.
    Поэтому место для КП выбирают под замысел: он не поедет за вами.</p>
    <p><b>Пункт можно заглушить.</b> Пока рядом с КП стоит хоть одна часть противника, узел <b>блокирован</b>:
    ни подвоза, ни высадки, ни скидок, ни очка за пункт — остаётся только сектор. Одна разведрота, просочившаяся в тыл,
    способна обесточить целое направление, так что охранение при КП — не роскошь.</p>
    <p><b>Командный объект без охраны берут в плен.</b> Если рядом с ним нет ни одной своей части, подошедшая пехота или техника
    захватывает его вместе с документами: захватчику ${HQ_CAPTURE_CP}★, вскрытый сектор противника и занятая клетка,
    а части бывшего сектора теряют управление и −20 морали. Держите при КП охрану, а чужой ищите в тылу — это дешёвый способ
    развалить целое направление.</p>
    <div class="lbl">Управление</div>
    <p>ЛКМ — выбрать / идти / атаковать · ПКМ — снять · перетаскивание — карта · колесо, <kbd>+</kbd> <kbd>−</kbd> — масштаб (к курсору) · <kbd>F</kbd> — вся карта · <kbd>C</kbd> — к выбранной части · <kbd>T</kbd> — типы клеток · <kbd>L</kbd> — деревья вблизи · <kbd>S</kbd> — снабжение · <kbd>Tab</kbd> — следующая часть · <kbd>D</kbd> — окопаться · <kbd>A</kbd> — засада · <kbd>Enter</kbd> — конец хода · мини-карта — клик и перетаскивание.<br>
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
function hideModal() { $('#modal').hidden = true; maybeSitePrompt() }

/* ---------- обязательный шаг расстановки: командный пункт ---------- */
/** навести камеру на свой КП и выбрать его: дальше хватит клика по клетке */
function focusFob() {
  const f = needSite();
  if (!f) return;
  camTo(H.center(f.hex));
  setSel(f.id);
  hint('Командный пункт: кликните по клетке в своей зоне расстановки — там он и развернётся.');
}
function showSitePrompt() {
  G._siteAsked = true;
  $('#mbox').innerHTML = `<h2>Разверните командный пункт</h2>
    <p>Перед боем командир выбирает место своего <b>КП</b>. Вокруг него — <b>сектор управления</b>:
    внутри сектора части ходят дальше и бьют сильнее, снаружи — хуже.</p>
    <p class="mu">Пункт не ходит и держится крепко, но без охраны его захватывают. Ставьте его в глубине своей зоны,
    за боевыми частями, поближе к тому направлению, где будете наступать или обороняться.</p>
    <p class="mu">Как развернуть: КП уже выбран — кликните по любой клетке в подсвеченной зоне расстановки.
    Пока пункт не развёрнут, бой не начать.</p>
    <p class="acts"><button class="btn pri" id="btnSiteGo">Показать пункт</button></p>`;
  $('#modal').hidden = false;
}
/** спросить один раз за расстановку, но не поверх брифинга или справки */
function maybeSitePrompt() {
  if (!needSite() || G._siteAsked || !$('#modal').hidden) return;
  showSitePrompt();
}

/* ---------- меню ---------- */
const SCEN_TXT = {
  bridge: { n: 'Мост через Тихую', d: 'Взять переправу у Моста за 8 ходов, пока к Союзу не подошли резервы.' },
  breakthrough: { n: 'Прорыв к Красногору', d: 'За 30 ходов взять Красногор через мины и волны резервов.' },
  night: { n: 'Ночной рейд', d: 'За 3 ночных хода разгромить артиллерию и штаб Союза под Заречьем.' }
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
/* состояния слота: выключен · живой игрок · бот (кнопка их перебирает) */
const SLOT_NEXT = { off: 'human', human: 'bot', bot: 'off' };
const SLOT_TXT = { off: '—', human: 'Игрок', bot: 'Бот' };

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


/** ряд взаимоисключающих кнопок: key — поле в M, opts — [значение, подпись] */
function mPick(key, opts, dis) {
  return `<div class="mrow">${opts.map(([v, n]) => `<button class="btn ch${M[key] === v ? ' on' : ''}"
    data-pick="${key}" data-val="${v}"${dis ? ' disabled' : ''}>${esc(n)}</button>`).join('')}</div>`;
}
const backHTML = t => `<div class="mhead"><button class="btn" data-nav="root">‹ Назад</button><h1>${esc(t)}</h1></div>`;
/* иконки меню: тонкая линия, цвет — от текста кнопки */
const MI = d => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MICON = {
  play: MI('<path d="M12 2.6l8.1 4.7v9.4L12 21.4l-8.1-4.7V7.3z"/><path d="M10 16.2V7.8l5.2 2.1-5.2 2.1"/>'),
  net: MI('<circle cx="12" cy="12" r="1.9"/><path d="M8.6 15.4a4.8 4.8 0 010-6.8M15.4 8.6a4.8 4.8 0 010 6.8M5.7 18.3a8.9 8.9 0 010-12.6M18.3 5.7a8.9 8.9 0 010 12.6"/>'),
  camp: MI('<path d="M3 6.2l6-2.2 6 2.2 6-2.2v13.6l-6 2.2-6-2.2-6 2.2z"/><path d="M9 4v13.6M15 6.2v13.6"/>'),
  set: MI('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  news: MI('<path d="M5 4.5h10.5v15H6.2A1.2 1.2 0 015 18.3z"/><path d="M15.5 8.5H19v10.3a1.2 1.2 0 01-1.2 1.2h-2.3M8 8.5h4.5M8 12h4.5M8 15.5h2.5"/>'),
  refresh: MI('<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3"/><path d="M19.6 4.6v4.1h-4.1"/>'),
  go: MI('<path d="M9.5 6l6 6-6 6"/>')
};
/** сегментный переключатель: та же логика data-pick, что у mPick, но компактный */
function mSeg(key, opts) {
  return `<div class="seg">${opts.map(([v, n]) => `<button class="${M[key] === v ? 'on' : ''}" data-pick="${key}" data-val="${v}">${esc(n)}</button>`).join('')}</div>`;
}
/** вход по коду — одна строка: поле, «Войти», «Смотреть» */
const codeHTML = () => `<div class="codebox"><input id="joinCode" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false" aria-label="Код партии">
  <button class="btn" data-a="join">Войти</button><button class="btn" data-a="spec">Смотреть</button></div>`;

function menuHTML() {
  if (M.view === 'play') return playHTML();
  if (M.view === 'camp') return campHTML();
  if (M.view === 'set') return setHTML();
  if (M.view === 'news') return newsHTML();
  if (M.view === 'net') return netHTML();
  return rootHTML();
}

function rootHTML() {
  const strip = ['tnk', 'mot', 'inf', 'art', 'mlrs', 'eng', 'hq'].map(k => iconHTML(unitIcon(k, M.side || N), 'ic big')).join('');
  let done = {}; try { done = JSON.parse(localStorage.getItem('turn.camp') || '{}') } catch (e) { /* приватный режим */ }
  const camp = Object.keys(SCEN_TXT).filter(k => done[k]).length, open = (M.rooms || []).filter(r => r.free > 0).length;
  const tile = (nav, ic, h, d, cls, extra) => `<button class="mtile ${cls || ''}" data-nav="${nav}"><span class="mt-ic">${MICON[ic]}</span>
    <span class="mt-tx"><b>${h}</b>${d ? `<span>${d}</span>` : ''}</span>${extra || ''}<span class="mt-go">${MICON.go}</span></button>`;
  return `<div class="mbox root"><header class="brand">
      <div class="brandline"><i></i><h1>FRONTLINE <b>TACTICS</b></h1><i></i></div>
      <div class="msub">Пошаговая штабная игра о сухопутном фронте</div>
      <div class="mstrip">${strip}</div></header>
    <div class="rgrid">
      <nav class="rmain">
        ${tile('play', 'play', 'Играть', 'Свободная операция: карта, режим и состав команд', 'hero')}
        ${tile('net', 'net', 'Сетевая игра', 'Партии, которые ждут игроков', '', `<em class="live" id="netCount"${open ? '' : ' hidden'}><i></i>${open} ${open === 1 ? 'открыта' : 'открыто'}</em>`)}
        ${tile('camp', 'camp', 'Кампания', `Красногорская операция · пройдено ${camp} из ${Object.keys(SCEN_TXT).length}`)}
        <div class="mtiles2">
          ${tile('set', 'set', 'Настройки', '', 'sm')}
          ${tile('news', 'news', 'Что нового', '', 'sm', News.unseen() ? '<i class="dot" title="есть новое"></i>' : '')}
        </div>
      </nav>
      <aside class="rside">
        <div class="mcardx"><label class="mlab" for="nick">Ваш ник</label>
          <input id="nick" class="field" maxlength="${NAME_MAX}" placeholder="Командир" autocomplete="off" spellcheck="false" value="${esc(myName)}">
          <i class="mhint">латиница или кириллица, до ${NAME_MAX} знаков</i></div>
        <div class="mcardx"><div class="mlab">Вход по коду</div>${codeHTML()}
          <div class="mlab">В команду</div>${mSeg('joinSide', [['any', 'Любую'], [N, SIDE_NAME[N]], [S, SIDE_NAME[S]]])}</div>
      </aside>
    </div>
    <div class="mfoot">Версия ${GAME_VERSION} · колесо — масштаб, перетаскивание — карта, <kbd>?</kbd> — справка</div></div>`;
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
<canvas data-prev="${id}" width="112" height="112"></canvas>
      <div class="mtx"><b>${esc(MAPS[id].n)}</b><i>${esc(MAPS[id].tag)}</i>
        ${(() => { const d = Hex.dimsOf(id);
          return `<em class="msize ${d[0] > d[1] ? 'wide' : 'tall'}">${d[0]}×${d[1]} км · ${d[0] > d[1] ? 'широкая' : 'высокая'}</em>` })()}
        <span>${esc(MAPS[id].desc)}</span></div></div>`).join('')}</div>

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

/* ---------- сетевая игра: список открытых партий ----------
   Сервер отдаёт партии, созданные с открытыми местами, где ещё есть игрок.
   Список обновляется сам раз в 3 секунды, пока экран открыт. */
const PHASE_TXT = { deploy: 'расстановка', battle: 'бой' };
function netHTML() {
  return `<div class="mbox wide">${backHTML('Сетевая игра')}
    <div class="ngrid">
      <section class="nmain">
        <div class="ntool">
          <div class="nlive"><i class="pulse"></i><span id="netStat">${netStatText()}</span></div>
          <div class="ntool-r"><span class="mlab inl">В команду</span>${mSeg('joinSide', [['any', 'Любую'], [N, SIDE_NAME[N]], [S, SIDE_NAME[S]]])}
            <button class="btn icon" data-a="netRefresh" title="Обновить список">${MICON.refresh}</button></div>
        </div>
        <div id="netList">${netListHTML()}</div>
      </section>
      <aside class="nside">
        <div class="mcardx"><h2>Своя партия</h2>
          <p class="mhint">Во «Играть» отметьте места для других как «Игрок» — партия появится в этом списке.</p>
          <button class="btn pri block" data-nav="play">Создать партию</button></div>
        <div class="mcardx"><h2>Вход по коду</h2>
          <p class="mhint">Код из четырёх букв — у хозяина партии в шапке игры.</p>${codeHTML()}</div>
        <div class="mcardx tips"><h2>Как это работает</h2><ul>
          <li>В списке — партии с местами для игроков, пока в них кто-то есть.</li>
          <li>«Войти» сажает в выбранную команду, если там занято — в свободную.</li>
          <li>«Смотреть» — зрителем, без тумана войны своей стороны.</li>
          <li>Одиночные партии против бота сюда не попадают.</li></ul></div>
      </aside>
    </div></div>`;
}
function netStatText() {
  if (!M.rooms) return 'ищем партии…';
  const open = M.rooms.filter(r => r.free > 0).length;
  return M.rooms.length ? `${M.rooms.length} ${plural(M.rooms.length, 'партия', 'партии', 'партий')} · со свободными местами — ${open}` : 'открытых партий нет';
}
function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many }
function netListHTML() {
  if (!M.rooms) return `<div class="nempty"><div class="radar"><i></i></div><b>Ищем партии…</b></div>`;
  if (!M.rooms.length) return `<div class="nempty"><div class="radar"><i></i></div><b>Открытых партий нет</b>
    <span>Создайте свою — другие увидят её здесь, а друзьям можно прислать код.</span>
    <button class="btn pri" data-nav="play">Создать партию</button></div>`;
  const ago = sec => sec < 60 ? 'только что' : sec < 3600 ? Math.round(sec / 60) + ' мин назад' : Math.round(sec / 3600) + ' ч назад';
  const seat = x => x.who === 'bot' ? '<span class="seat bot">бот</span>'
    : x.who === 'open' ? '<span class="seat open">свободно</span>'
    : `<span class="seat hum"><i>${esc((x.name || '?').slice(0, 1).toUpperCase())}</i>${esc(x.name || 'игрок')}</span>`;
  const team = (r, sd) => `<div class="rteam ${sd}"><span class="th">${SIDE_NAME[sd]}</span>${r.seats.filter(x => x.side === sd).map(seat).join('')}</div>`;
  return `<div class="rooms">${M.rooms.map(r => {
    const mode = SCEN_TXT[r.mode] ? SCEN_TXT[r.mode].n : MODE_LABEL[r.mode] || r.mode, map = MAPS[r.map] ? MAPS[r.map].n : r.map;
    const stage = r.phase === 'battle'
      ? `<span class="stage bt">ход ${r.turn + 1} из ${r.limit}<i style="width:${Math.round(100 * Math.min(1, (r.turn + 1) / Math.max(1, r.limit)))}%"></i></span>`
      : `<span class="stage dp">${esc(PHASE_TXT[r.phase] || r.phase)}</span>`;
    return `<article class="room${r.free ? '' : ' full'}">
      <canvas data-prev="${esc(r.map)}" width="144" height="144"></canvas>
      <div class="rbody">
        <div class="rtop"><b class="code">${esc(r.id)}</b><b class="rmode">${esc(mode)}</b>${stage}</div>
        <div class="rmeta">${esc(map)} · создана ${ago(r.age)}${r.viewers ? ` · зрителей: ${r.viewers}` : ''}</div>
        <div class="rteams">${team(r, N)}<span class="rvs">против</span>${team(r, S)}</div>
      </div>
      <div class="ract">
        <div class="rfree"><b>${r.free}</b><span>${r.free ? plural(r.free, 'место', 'места', 'мест') : 'мест нет'}</span></div>
        ${r.free ? `<button class="btn pri" data-a="netJoin" data-room="${esc(r.id)}">Войти</button>` : ''}
        <button class="btn" data-a="netWatch" data-room="${esc(r.id)}">Смотреть</button>
      </div></article>` }).join('')}</div>`;
}
/** запросить список и обновлять, пока открыт экран сетевой игры */
let netTimer = 0;
function netPoll() {
  clearTimeout(netTimer);
  if ((M.view !== 'net' && M.view !== 'root') || !$('#menu').classList.contains('on')) return;
  netSend({ t: 'list' });
  netTimer = setTimeout(netPoll, M.view === 'net' ? 3000 : 8000);
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
  if (M.view === 'net' || M.view === 'root') netPoll();
}
/* ---------- миниатюры карт в меню: печём в простое по одной ---------- */
const PREV = new Map();
function mapPreview(id) {
  if (PREV.has(id)) return PREV.get(id);
  /* размеры берём у превьюируемой карты: H — это сетка текущей, она здесь не подходит */
  const dims = Hex.dimsOf(id), MW = dims[0], MH = dims[1];
  const T = Terrain.get(id), def = T.def, k = 3, w = Math.round(MW / k), h = Math.round(MH / k);
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
  /* рамка у всех одна, а карта внутри — в своих пропорциях: сразу видно,
     какая карта вытянута в высоту, а какая в ширину */
  const put = el => {
    try {
      const c = mapPreview(el.dataset.prev), g = el.getContext('2d');
      g.clearRect(0, 0, el.width, el.height);
      g.fillStyle = '#0a1016'; g.fillRect(0, 0, el.width, el.height);
      const k = Math.min(el.width / c.width, el.height / c.height);
      const w = Math.max(1, Math.round(c.width * k)), h = Math.max(1, Math.round(c.height * k));
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(c, Math.round((el.width - w) / 2), Math.round((el.height - h) / 2), w, h);
      g.strokeStyle = 'rgba(120,150,170,.35)'; g.lineWidth = 1;
      g.strokeRect(Math.round((el.width - w) / 2) + .5, Math.round((el.height - h) / 2) + .5, w - 1, h - 1);
    } catch (e) { /* без холста */ }
  };
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
function leaveToMenu() {
  netSend({ t: 'leave' });
  G.roomId = null; G.units = []; G.sel = null; G.lobby = null; G.mySeat = null; G.lobbyHidden = false; G.lobbyOpen = false;
  $('#lc_log').innerHTML = '';
  renderLobby();   /* иначе оверлей лобби останется поверх меню */
  M.view = 'root'; /* из партии выходим в главное меню, а не на экран настройки */
  showMenu();
}

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
  if (there && (myUnit(there) || allyUnit(there) || G.spec)) return setSel(there.id === G.sel && !G.spec ? null : there.id);
  const tg = (G.targets || []).find(t => t.hex === h);
  if (u && tg) { act(UT[u.k].bomb ? { t: 'bombard', id: u.id, hex: h } : { t: 'attack', id: u.id, target: tg.id }); return }
  if (u && G.reach && G.reach.has(h) && !G.reach.get(h).through) { act({ t: 'move', id: u.id, to: h }); return }
  if (there) { G.sel = there.id; G.tabR = 'unit'; syncTabs(); computeSel(); renderUI(); return }
  setSel(null);
}
function orderClick(k) {
  const O = ORDERS[k];
  if (!O || !G.isMyTurn) return;
  if (O.tgt === 'none') { if (G.cp < O.cp) return toast(`Нужно ${O.cp} командных очка`); act({ t: 'order', k }); return }
  if (O.tgt === 'unit') {
    const u = selUnit();
    if (!u || !myUnit(u)) return toast('Сначала выберите свою часть');
    if (G.cp < orderCp(k, u.hex)) return toast(`Нужно ${orderCp(k, u.hex)} командных очка`);
    act({ t: 'order', k, id: u.id }); return;
  }
  /* приказ по клетке: дешевле он или нет, станет видно по самой клетке — берём минимум */
  if (G.cp < Math.max(1, O.cp - FOB.orderOff)) return toast(`Нужно ${O.cp} командных очка`);
  G.mode = G.mode === 'ord:' + k ? null : 'ord:' + k;
  G.spawn = G.mode === 'ord:reserve' ? spawnHexes('mot') : null;
  hint(G.mode ? (k === 'smoke' ? 'Дымовая завеса: кликните по клетке (до 3 клеток от своих частей) — дым ляжет на неё и соседние.' : 'Резерв ставки: кликните по подсвеченной клетке у своего города или узла.') + ' ПКМ — отмена.' : '');
  renderUI();
}
function nextUnit() {
  const list = G.units.filter(u => myUnit(u) && (u.mp > 0 || !u.acted));
  if (!list.length) { toast('Все части отработали — можно завершать ход'); return }
  const i = list.findIndex(u => u.id === G.sel), u = list[(i + 1) % list.length];
  camTo(H.center(u.hex));
  setSel(u.id);
}
function endTurn() {
  if (G.phase === 'deploy') {
    /* бой не начать без КП: не молчим и не ругаемся — ведём к шагу */
    if (needSite()) { toast('Сначала разверните командный пункт'); G._siteAsked = false; maybeSitePrompt(); return }
    act({ t: 'ready' }); return;
  }
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
    if (G.mouse && G.mouse.inside && (CAM.moving || KEYS.size)) { const w = s2w(G.mouse); G.hover = H.hexAt(w.x, w.y); renderTip(G.mouse); hexInfo(G.hover) }
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
  const onScr = e => {
    const el = e.target.closest && e.target.closest('[data-scr]'); if (!el) return;
    if (el.dataset.scr === 'trees') setTrees(el.checked);
    else setScreen(el.dataset.scr, el.checked);
  };
  document.addEventListener('change', onScr);
  { const tb = document.querySelector('[data-z=trees]'); if (tb) tb.classList.toggle('on', !!SCREEN.trees) }
  $('#btnStrike').onclick = () => { G.mode = G.mode === 'air:strike' ? null : 'air:strike'; hint(G.mode ? 'Авиаудар: кликните по видимой цели. ПВО рядом с целью может сорвать удар.' : ''); renderTop() };
  $('#btnRecon').onclick = () => { G.mode = G.mode === 'air:recon' ? null : 'air:recon'; hint(G.mode ? 'Авиаразведка: кликните по району — откроется радиус 3 клетки.' : ''); renderTop() };
  $('#paceBox').addEventListener('click', e => { const b = e.target.closest('[data-pace]'); if (!b) return; G.pace = +b.dataset.pace || 1; netSend({ t: 'pace', value: +b.dataset.pace }); document.querySelectorAll('#paceBox button').forEach(x => x.classList.toggle('on', x === b)) });
  const dtog = $('#dockToggle');
  if (dtog) dtog.onclick = () => setDock($('#dock').classList.contains('col'));
  $('#modal').addEventListener('click', e => {
    if (e.target.id === 'btnSiteGo') { $('#modal').hidden = true; focusFob(); return }
    if (e.target.id === 'btnClose' || e.target.id === 'modal') hideModal();
    if (e.target.id === 'btnNew') leaveToMenu();
  });
  $('#lobby').addEventListener('click', e => {
    if (e.target.id === 'btnLobbyClose' || e.target.id === 'lobby') { G.lobbyHidden = true; G.lobbyOpen = false; renderLobby() }
  });
  $('#btnTeams').onclick = () => { G.lobbyOpen = !G.lobbyOpen; if (G.lobbyOpen) G.lobbyHidden = true; renderLobby() };
  document.querySelectorAll('#left .tabs button').forEach(b => b.onclick = () => {
    G.tabL = b.dataset.tab;
    document.querySelectorAll('#left .tabs button').forEach(x => x.classList.toggle('on', x === b));
    for (const id of ['log', 'pts', 'sum']) $('#lc_' + id).style.display = G.tabL === id ? 'block' : 'none';
    renderUI();
  });
  document.querySelectorAll('#right .tabs button').forEach(b => b.onclick = () => { G.tabR = b.dataset.tab; syncTabs(); renderUI() });
  $('#lc_pts').addEventListener('click', e => { const r = e.target.closest('[data-go]'); if (r) camTo(H.center(+r.dataset.go), Math.max(G.view.s, S_WORK())) });
  $('#rc').addEventListener('click', e => {
    const b = e.target.closest('[data-buy]');
    if (b) { if (b.classList.contains('off')) return toast('Не хватает очков'); G.mode = 'buy:' + b.dataset.buy; G.sel = null; G.spawn = spawnHexes(b.dataset.buy); hint(G.phase === 'deploy' ? 'Кликните по клетке в зоне расстановки (Shift — несколько).' : 'Кликните по подсвеченной клетке у своего города или узла (Shift — несколько).'); renderUI(); return }
    const o = e.target.closest('[data-ord]');
    if (o) { orderClick(o.dataset.ord); return }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const u = selUnit(), k = a.dataset.a;
    if (k === 'site') { focusFob(); return }
    if (k.startsWith('att:')) { if (u && myUnit(u)) act({ t: 'attach', id: u.id, k: k.slice(4) }); return }
    if (k === 'supply') { G.showSupply = !G.showSupply; renderUI(); return }
    if (k === 'cmd') { G.showCmd = !G.showCmd; renderUI(); return }
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
    /* слот команды: — · Игрок · Бот */
    const sl = e.target.closest('[data-slot]');
    if (sl) {
      const [sd, i] = sl.dataset.slot.split(':');
      M.roster[sd][+i] = SLOT_NEXT[M.roster[sd][+i]] || 'off';
      rosterFix(); mSave(); showMenu(); return;
    }
    /* пересесть на другое место или в другую команду */
    const me = e.target.closest('[data-me]');
    if (me) {
      const [sd, i] = me.dataset.me.split(':');
      M.me = { side: sd, i: +i };
      rosterFix(); mSave(); showMenu(); return;
    }
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
      const err = rosterErr();
      if (err) return toast(err);
      const plan = rosterPlan();
      if (!M.me) netSend({ t: 'create', mode: M.mode, watch: true, map: G.mapPick, seats: plan });
      else netSend({ t: 'create', mode: M.mode, side: M.me.side, map: G.mapPick, seats: plan, name: myName });
    }
    else if (a === 'scen') netSend({ t: 'create', mode: el.dataset.id, side: M.side, vsBot: true, seats: scenPlan(el.dataset.id), name: myName });
    else if (a === 'watch') netSend({ t: 'create', mode: el.dataset.mode, watch: true, map: G.mapPick });
    else if (a === 'netRefresh') netPoll();
    else if (a === 'netJoin' || a === 'netWatch') {
      clearTimeout(netTimer);
      netSend({ t: 'join', room: el.dataset.room, spec: a === 'netWatch', name: myName, side: M.joinSide === 'any' ? undefined : M.joinSide });
    }
    else if (a === 'join' || a === 'spec') {
      if (code.trim().length !== 4) return toast('Код — четыре буквы');
      netSend({
        t: 'join', room: code.trim().toUpperCase(), spec: a === 'spec', name: myName,
        /* сервер посадит в выбранную команду, а если там занято — в свободную */
        side: M.joinSide === 'any' ? undefined : M.joinSide
      });
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
    else if (b.dataset.z === 'trees') setTrees(!SCREEN.trees)
    else if (b.dataset.z === 'sel') { const u = selUnit(); if (u) camTo(H.center(u.hex), Math.max(G.view.s, S_WORK())) }
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
    /* удержание клавиши шлёт keydown снова и снова: переключатели от этого мигали,
       а Enter завершал бы ход за ходом. Повтор нужен только перебору частей (Tab) */
    if (e.repeat && e.key !== 'Tab') return;
    /* Ctrl+S, Ctrl+C и прочие сочетания — браузеру, а не игре */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Tab') { e.preventDefault(); nextUnit() }
    else if (e.key === 'Enter') endTurn();
    else if (e.key === 'Escape') { G.mode = null; G.spawn = null; hint(''); setSel(null); hideModal() }
    else if ((k === 'd' || k === 'в') && selUnit()) act({ t: 'dig', id: G.sel });
    else if ((k === 'a' || k === 'ф') && selUnit()) act({ t: 'ambush', id: G.sel });
    else if (k === 's' || k === 'ы') { G.showSupply = !G.showSupply; renderUI() }
    else if (k === 'h' || k === 'р') { G.showCmd = !G.showCmd; renderUI() }
    else if (k === 't' || k === 'е') { G.showTypes = !G.showTypes; const b = document.querySelector('[data-z=types]'); if (b) b.classList.toggle('on', G.showTypes) }
    else if (k === 'f' || k === 'а') camFit();
    else if (k === 'l' || k === 'д') setTrees(!SCREEN.trees);
    else if ((k === 'c' || k === 'с') && selUnit()) camTo(H.center(selUnit().hex));
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
  const miniGo = sp => { const m = miniRect(); panTo(clamp((sp.x - m.x) / m.w, 0, 1) * H.WW, clamp((sp.y - m.y) / m.h, 0, 1) * H.WH) };
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
    const w = s2w(sp), h = inMini(sp) ? -1 : H.hexAt(w.x, w.y);
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
    clickHex(H.hexAt(w.x, w.y), e);
    if (p && p.touch) { G.hover = H.hexAt(w.x, w.y); hexInfo(G.hover) }
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
  const m = H.build(G.mapId), hx = m.hexes[h], T = Rules.TCOST, d = Rules.TDEF[hx.t];
  const riv = [0, 1, 2, 3, 4, 5].filter(i => m.edge[h * 6 + i] & Hex.RIV).length;
  const fort = new Map(G.forts || []).get(h), p = G.pts.find(q => q.hex === h);
  const c = v => v === Infinity ? '—' : v;
  el.innerHTML = `<b>${p ? esc(p.n) + ' · ' : ''}${Rules.TNAME[hx.t]}</b>
    <span>${Math.round(hx.h)} м</span>${hx.road ? '<span>дорога</span>' : ''}${riv ? '<span class="bl">река</span>' : ''}${fort ? `<span class="ac">укрепления ${fort}</span>` : ''}
    <span title="Множитель обороны в этой клетке">оборона ×${String(d).replace('.', ',')}</span>
    <span class="mu" title="Стоимость входа: пешие / колёсные / гусеничные">ход ${c(T.foot[hx.t])}/${c(T.wheel[hx.t])}/${c(T.track[hx.t])}</span>
    <span class="mu">${String(H.colOf(h) + 1).padStart(2, '0')}${String(H.rowOf(h) + 1).padStart(2, '0')}</span>`;
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
if (innerWidth < 960) setDock(false);
function setDock(open) {
  const d = $('#dock');
  if (!d) return;
  d.classList.toggle('col', !open);
  const b = $('#dockToggle');
  if (b) { b.textContent = open ? '‹' : 'Штаб'; b.title = open ? 'Скрыть штаб' : 'Показать штаб' }
  setTimeout(() => { clampTo(CAM); CAM.moving = true }, 230);
}
requestAnimationFrame(loop);
