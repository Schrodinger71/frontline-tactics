'use strict';
/* ============================================================
   ОБУЧЕНИЕ: отдельный пункт меню и короткие учебные сцены.
   ------------------------------------------------------------
   Каждая сцена — маленькая карта с парой частей и одним-двумя
   ходами (game/scenarios.js, поля lab_*). Сцена ведётся шагами:
   текущий шаг подсвечивает, куда нажать (клетку на карте — кольцом,
   кнопку или слой — рамкой), и ждёт, пока действие будет сделано
   настоящим вводом. Сделанный шаг остаётся сделанным. Противник в
   сценах не воюет, поэтому ученик ничего не теряет.
   ============================================================ */

/** сцены обучения по порядку: id совпадает с ключом в SCEN на сервере */
const LABS = [
  { id: 'lab_recon', n: 'Разведка боем', d: 'Разведрота подходит к заставе, вскрывает её и сбивает окоп. Артиллерия прижимает оборону.' },
  { id: 'lab_fire', n: 'Огонь с места', d: 'Пехота бьёт по соседу из окопа: цель прижата, клетка остаётся вашей.' },
  { id: 'lab_attack', n: 'Штурм и готовая позиция', d: 'Часть, простоявшая ход рядом с врагом, бьёт сильнее. Потом — штурм пехотой.' },
  { id: 'lab_flank', n: 'Обход', d: 'Зона контроля останавливает на подходе. Мотопехота заходит врагу за спину.' },
  { id: 'lab_remnant', n: 'Остатки и арьергард', d: 'Разбитая часть не исчезает сразу: её остатки уходят. Арьергард прикрывает отход.' },
  { id: 'lab_supply', n: 'Снабжение и склад', d: 'Подвоз идёт по дорогам. Полевой склад кормит округу там, где дорог нет.' },
  { id: 'lab_air', n: 'Авиаудар и ПВО', d: 'Штурмовик бьёт по видимой части. Зенитки прикрывают свою землю и сбивают самолёт.' },
  { id: 'lab_order', n: 'Приказы штаба', d: 'Командные очки покупают приказы. «Стоять насмерть» держит позицию до вашего хода.' },
  { id: 'lab_ui', n: 'Инструменты', d: 'Отмена хода, слой угрозы и чат с меткой для союзников.' }
];
const labIndex = id => LABS.findIndex(l => l.id === id);

/** вспомогательные выборки по видимому состоянию (только свои части и видимые враги) */
const CO = {
  foes() { return G.units.filter(e => e.side !== G.side && e.str > 0) },
  dist(h) { let d = 99; for (const e of CO.foes()) d = Math.min(d, H.hexDist(h, e.hex)); return d },
  /** своя часть вида k: выбранная, если она такого вида; иначе ближайшая к врагу из ещё не походивших */
  mine(k) {
    const s = G.sel && G.units.find(x => x.id === G.sel);
    if (s && s.side === G.side && s.k === k && s.str > 0) return s;
    const list = G.units.filter(u => u.side === G.side && u.k === k && u.str > 0 && !u.acted);
    list.sort((a, b) => CO.dist(a.hex) - CO.dist(b.hex));
    return list[0] || G.units.find(u => u.side === G.side && u.k === k && u.str > 0) || null;
  },
  /** свои части с признаком подготовленной атаки, которые ещё не действовали */
  prepAll() { return G.units.filter(u => u.side === G.side && u.prep && !u.moved && !u.acted && u.str > 0) },
  /** видимый враг на расстоянии lo..hi от части */
  foeIn(u, lo, hi) {
    return G.units.find(e => e.side !== G.side && e.str > 0 && H.hexDist(u.hex, e.hex) >= lo && H.hexDist(u.hex, e.hex) <= hi) || null;
  },
  /** клетка хода выбранной части, с которой враг на расстоянии lo..hi; самая дешёвая */
  approach(u, lo, hi) {
    if (!G.reach || G.sel !== u.id) return null;
    let best = null, bc = 1e9;
    for (const [h, r] of G.reach) {
      if (r.through || h === u.hex) continue;
      const d = CO.dist(h);
      if (d >= lo && d <= hi && r.c < bc) { bc = r.c; best = h }
    }
    return best;
  },
  /** любая клетка хода выбранной части — для урока про отмену */
  anyStep(u) {
    if (!G.reach || G.sel !== u.id) return null;
    let best = null, bc = 1e9;
    for (const [h, r] of G.reach) if (!r.through && h !== u.hex && r.c < bc) { bc = r.c; best = h }
    return best;
  }
};

/** шаги сцен: sc — id сцены, t — ход внутри сцены */
const COACH = [];
let SC = null;
const step = (t, o) => COACH.push(Object.assign({ sc: SC, t }, o));
/** начать описание шагов сцены */
const scene = id => { SC = id };

/** подвести часть k на расстояние lo..hi от врага: сначала выбрать, потом кликнуть подсвеченную клетку */
function stepApproach(t, k, lo, hi, title, text) {
  step(t, {
    title, text,
    target: () => {
      const x = CO.mine(k);
      if (!x) return null;
      return { hex: G.sel === x.id ? (CO.approach(x, lo, hi) ?? x.hex) : x.hex };
    },
    done: () => { const x = CO.mine(k); return !x || x.acted || (G.sel === x.id && !!CO.foeIn(x, lo, hi)) }
  });
}
/** выбрать часть k */
function stepSel(t, k, title, text) {
  step(t, {
    title, text,
    target: () => { const x = CO.mine(k); return x ? { hex: x.hex } : null },
    done: () => { const x = CO.mine(k); return !x || x.acted || G.sel === x.id }
  });
}
/** передвинуть выбранную часть на любую клетку хода */
function stepMove(t, k, title, text) {
  step(t, {
    title, text,
    target: () => {
      const x = CO.mine(k);
      if (!x) return null;
      return { hex: G.sel === x.id ? (CO.anyStep(x) ?? x.hex) : x.hex };
    },
    done: () => { const x = CO.mine(k); return !x || x.moved || x.acted }
  });
}
/** нажать кнопку или клавишу: подсветка — элемент по селектору */
function stepKey(t, sel, keys, title, text, done) {
  step(t, { title, text, keys, target: () => (sel ? { sel } : null), done });
}
/** ударить по врагу в радиусе части k (1 — соседний; у артиллерии — её радиус огня) */
function stepHit(t, k, title, text) {
  step(t, {
    title, text,
    target: () => {
      const x = CO.mine(k), r = x && UT[x.k].bomb ? UT[x.k].bomb.rng : 1;
      const e = x && CO.foeIn(x, 1, r);
      return e ? { hex: e.hex } : null;
    },
    done: () => { const x = CO.mine(k); return !x || x.acted }
  });
}
/** ударить с воздуха: подсветка — видимый враг; сделано — вылет израсходован */
function stepAir(t, title, text) {
  step(t, {
    title, text,
    target: () => { const e = CO.foes()[0]; return e ? { hex: e.hex } : null },
    done: () => !!G.air && G.air.strike < 2
  });
}
/** конец хода сцены: следующий ход или конец сцены */
function stepEnd(t) {
  step(t, {
    title: 'Конец хода',
    text: 'Нажмите «Конец хода» или <kbd>Enter</kbd>. Противник сходит, и сцена продолжится.',
    keys: 'Enter', target: () => ({ sel: '#btnEnd' }), done: () => G.turn > t
  });
}

/* ---- сцена 1: разведка боем ---- */
scene('lab_recon');
stepApproach(0, 'rec', 1, 1, 'Подведите разведку', 'Выберите разведроту, затем кликните по подсвеченной клетке рядом с вражеской заставой. Разведчики видят на 4 клетки и малозаметны.');
stepKey(0, '#rc [data-a="probe"]', 'E', 'Разведка боем', 'Нажмите «Разведка боем» в карточке части или клавишу <kbd>E</kbd>. Это малая атака: почти ничего не стоит и вскрывает оборону.', () => G.mode === 'probe');
stepHit(0, 'rec', 'Вскройте заставу', 'Кликните по врагу рядом. Вы увидите его мораль и запасы, а окоп станет на уровень ниже.');
stepApproach(0, 'art', 1, 3, 'Артиллерия — на позицию', 'Выберите артиллерию и подведите её в радиус огня (пунктирный круг). Огонь с закрытых позиций прижимает оборону.');
stepHit(0, 'art', 'Залп', 'Кликните по врагу в радиусе. Прижатые шаги обороняются хуже — это подготовка атаки.');
stepEnd(0);

/* ---- сцена 2: огонь с места ---- */
scene('lab_fire');
stepApproach(0, 'inf', 1, 1, 'Пехота подходит', 'Выберите пехоту и подведите её к врагу — подсвеченная клетка рядом с ним.');
stepKey(0, '#rc [data-a="fire"]', 'R', 'Обстрел с места', 'Нажмите «Обстрел» или <kbd>R</kbd>. Пехота останется в окопе и не займёт клетку, но прижмёт врага огнём.', () => G.mode === 'fire');
stepHit(0, 'inf', 'Ведите огонь', 'Кликните по врагу рядом. Обстрел — без штурма: цель прижата, ваша часть на месте.');
stepEnd(0);

/* ---- сцена 3: штурм и готовая позиция ---- */
scene('lab_attack');
step(0, {
  title: 'Готовая позиция',
  text: 'Часть с значком ▲ простояла ход рядом с врагом и не двигалась — её удар ×1,2. Выберите её.',
  target: () => { const p = CO.prepAll()[0]; return p ? { hex: p.hex } : null },
  done: () => { const p = CO.prepAll()[0]; return !p || G.sel === p.id }
});
step(0, {
  title: 'Удар с готовой позиции',
  text: 'Кликните по врагу рядом: часть не двигается, поэтому бонус сохраняется.',
  target: () => { const p = CO.prepAll().find(x => x.id === G.sel) || CO.prepAll()[0]; const e = p && CO.foeIn(p, 1, 1); return e ? { hex: e.hex } : null },
  done: () => CO.prepAll().length === 0
});
stepEnd(0);
stepApproach(1, 'inf', 1, 1, 'Штурм пехотой', 'Выберите пехоту и подведите её к врагу. Пехота берёт города и окопы.');
stepHit(1, 'inf', 'Штурм', 'Кликните по врагу рядом. Соотношение сил видно при наведении.');
stepEnd(1);

/* ---- сцена 4: обход ---- */
scene('lab_flank');
stepApproach(0, 'mot', 2, 3, 'Обход', 'Выберите мотопехоту и переведите её на подсвеченную клетку в 2–3 клетках от врага — за его спиной. Красные знаки «стоп» на клетках хода — там остановит зона контроля.');
stepEnd(0);

/* ---- сцена 5: остатки и арьергард ---- */
scene('lab_remnant');
stepApproach(0, 'tnk', 1, 1, 'Танки — в удар', 'Выберите танковый батальон и подведите его к врагу, у которого мало сил.');
stepHit(0, 'tnk', 'Удар', 'Кликните по врагу рядом. Если его часть уцелеет остатками, в следующем ходу её возьмёте в плен.');
stepSel(0, 'inf', 'Арьергард', 'Выберите пехоту: её ещё можно прикрыть на случай отхода.');
stepKey(0, '#rc [data-a="ord:rear"]', null, 'Приказ «Арьергард»', 'Нажмите «Арьергард» в карточке части (1★). Если часть выбьют, заслон задержит врага: её клетку с ходу не займут.', () => { const x = CO.mine('inf'); return !!x && !!x.rear });
stepEnd(0);
stepApproach(1, 'tnk', 1, 1, 'Остатки', 'Если противник уцелел остатками, атакуйте их: любая атака берёт остатки в плен.');
stepHit(1, 'tnk', 'Плен', 'Кликните по остаткам рядом.');
stepEnd(1);

/* ---- сцена 6: снабжение и склад ---- */
scene('lab_supply');
stepKey(0, '#layerBox [data-l="supply"]', 'S', 'Слой снабжения', 'Включите слой снабжения: клавиша <kbd>S</kbd> или кнопка ⛟ справа. Зелёным — клетки с подвозом, красным — без него.', () => G.showSupply);
stepSel(0, 'dep', 'Полевой склад', 'Выберите склад (СКЛ). Он источник подвоза: поставьте его ближе к передовой — отсюда он кормит округу. В ход переезда не работает.');
stepEnd(0);

/* ---- сцена 7: авиаудар и ПВО ---- */
scene('lab_air');
stepKey(0, '#btnStrike', null, 'Авиаудар', 'Нажмите «✈ Удар» вверху. Штурмовик ударит по видимой части противника. Под зенитками удар слабее и может сорваться.', () => G.mode === 'air:strike');
stepAir(0, 'Цель', 'Кликните по врагу. Эффект удара — в подсказке при наведении; вылет на этот ход израсходован.');
stepEnd(0);

/* ---- сцена 8: приказы штаба ---- */
scene('lab_order');
stepSel(0, 'inf', 'Пехота', 'Выберите пехоту на переднем крае.');
stepKey(0, '#rc [data-a="ord:hold"]', null, 'Стоять насмерть', 'Нажмите «Стоять насмерть» (1★). До вашего следующего хода часть не отходит и обороняется ×1,3.', () => { const x = CO.mine('inf'); return !!x && !!x.hold });
stepEnd(0);

/* ---- сцена 9: инструменты ---- */
scene('lab_ui');
stepSel(0, 'mot', 'Выберите часть', 'Выберите мотопехоту, которой будем ходить.');
stepMove(0, 'mot', 'Ход', 'Кликните по подсвеченной клетке — часть переедет.');
stepKey(0, '#btnUndo', 'Z', 'Отмена хода', 'Нажмите «↶ Отменить» или <kbd>Z</kbd>: тихий ход возвращается на место, очки хода — тоже.', () => { const x = CO.mine('mot'); return !!x && !x.moved });
stepKey(0, '#layerBox [data-l="threat"]', 'G', 'Слой угрозы', 'Нажмите ⚠ или <kbd>G</kbd>: красным — клетки, куда видимые части противника могут ударить за свой ход.', () => G.showThreat);
stepKey(0, '#chatTab', null, 'Связь', 'Откройте вкладку «Связь» справа: общий и командный чат, метки для союзников.', () => { const c = document.querySelector('#chat'); return !!c && c.classList.contains('open') });
stepEnd(0);

const COACH_TOTAL = LABS.length;

/** учебная сцена идёт, а ход за противником — карточка ждёт, а не пропадает */
function coachWaiting() { return !!(G.scen && G.scen.tutorial && !G.spec && !G.over && G.roomId && !G.isMyTurn) }

/** текущий шаг сцены: первый ещё не сделанный и не пропущенный на текущем ходу */
function coachCur() {
  if (!G.scen || !G.scen.tutorial || G.spec || G.over || !G.roomId || !G.isMyTurn) return null;
  if (!G.coachSkip) G.coachSkip = new Set();
  if (!G.coachDone) G.coachDone = new Set();
  const same = COACH.map((s, i) => i).filter(i => COACH[i].sc === G.scen.id && COACH[i].t === G.turn);
  for (const i of same) {
    if (G.coachSkip.has(i)) continue;
    /* сделанный шаг остаётся сделанным: режим или выбор могут сброситься сразу после действия */
    if (!G.coachDone.has(i)) { let d = false; try { d = COACH[i].done() } catch (e) { d = false } if (d) G.coachDone.add(i) }
    if (G.coachDone.has(i)) continue;
    return { i, s: COACH[i], n: same.indexOf(i) + 1, of: same.length };
  }
  return null;
}

let coachKey = -1, coachEl = null;
/** каждый кадр и после каждого обновления: подсветка цели и карточка шага; карточку перерисовываем только при смене шага */
function coachTick() {
  const cur = coachCur();
  const wait = !cur && coachWaiting();
  const key = cur ? cur.i : wait ? -3 : -1;
  if (key !== coachKey) { coachKey = key; coachCard(cur, wait) }
  let el = null;
  G.coachHex = -1;
  if (cur) {
    let tg = null; try { tg = cur.s.target() } catch (e) { tg = null }
    if (tg && Number.isInteger(tg.hex) && tg.hex >= 0) G.coachHex = tg.hex;
    if (tg && tg.sel) el = document.querySelector(tg.sel);
  }
  if (el !== coachEl) {
    if (coachEl) coachEl.classList.remove('coach-hl');
    coachEl = el;
    if (el) el.classList.add('coach-hl');
  }
}
/** карточка шага: сцена, шаг, текст, точки прогресса и кнопки */
function coachCard(cur, wait) {
  const el = $('#tutor');
  if (!el) return;
  const sceneNo = labIndex(G.scen && G.scen.id) + 1, sceneName = G.scen ? G.scen.n : '';
  if (wait) {
    el.innerHTML = `<div class="tk">Сцена ${sceneNo} из ${COACH_TOTAL} · ход противника</div>
      <div class="ctitle">${esc(sceneName)}: противник сходит</div>
      <div class="ctext">Следующий шаг начнётся, когда он закончит ход и вы снова будете на ходу.</div>
      <p class="acts"><button class="btn sm" id="coachMenu">В меню</button></p>`;
    el.hidden = false;
    $('#coachMenu').onclick = () => leaveToMenu();
    return;
  }
  if (!cur) { el.hidden = true; return }
  const dots = Array.from({ length: cur.of }, (_, j) => `<i class="${j < cur.n - 1 ? 'done' : j === cur.n - 1 ? 'now' : ''}"></i>`).join('');
  el.innerHTML = `<div class="tk">Сцена ${sceneNo} из ${COACH_TOTAL} · ${esc(sceneName)} · шаг ${cur.n} из ${cur.of}</div>
    <div class="ctitle">${esc(cur.s.title)}</div>
    <div class="ctext">${cur.s.text}</div>
    <div class="cdots">${dots}</div>
    <p class="acts"><button class="btn sm" id="coachSkip">Пропустить шаг</button> <button class="btn sm" id="coachMenu">В меню</button></p>`;
  el.hidden = false;
  $('#coachSkip').onclick = () => { G.coachSkip.add(cur.i); coachKey = -2; coachTick() };
  $('#coachMenu').onclick = () => leaveToMenu();
}
/** новая партия или выход: шаги и подсветка — с чистого листа */
function coachReset() {
  G.coachSkip = new Set(); G.coachDone = new Set(); G.coachHex = -1;
  coachKey = -1;
  if (coachEl) coachEl.classList.remove('coach-hl');
  coachEl = null;
  const el = $('#tutor'); if (el) el.hidden = true;
}
/** кольцо и указатель над клеткой, куда нажать (рисуется на карте) */
function drawCoachRing() {
  if (!(G.coachHex >= 0) || G.rp) return;
  const p = .5 + .5 * Math.sin(ANIM * 6), s = G.view.s, R = Hex.R * s;
  hexPath(G.coachHex, 1.08);
  cx.lineWidth = 3.4; cx.strokeStyle = `rgba(255,214,121,${.55 + .45 * p})`; cx.stroke();
  const q = w2s(H.center(G.coachHex)), y = q.y - R * 1.3 - p * 6;
  cx.beginPath(); cx.moveTo(q.x, y); cx.lineTo(q.x - 8, y - 11); cx.lineTo(q.x + 8, y - 11); cx.closePath();
  cx.fillStyle = '#ffd679'; cx.strokeStyle = 'rgba(0,0,0,.6)'; cx.lineWidth = 1.2; cx.fill(); cx.stroke();
}

/* ---------- пройденные сцены ---------- */
function learnAll() { try { return JSON.parse(localStorage.getItem('turn.learn') || '{}') || {} } catch (e) { return {} } }
function learnDone(id) { return !!learnAll()[id] }
function learnMark(id) { try { const d = learnAll(); d[id] = 1; localStorage.setItem('turn.learn', JSON.stringify(d)) } catch (e) { /* приватный режим */ } }

/* ---------- страница «Обучение» в меню ---------- */
function learnHTML() {
  const cards = LABS.map((l, i) => `<div class="mcard ${learnDone(l.id) ? 'done' : ''}">
      <div class="mkick">Сцена ${i + 1}${learnDone(l.id) ? ' · ✓ пройдена' : ''}</div>
      <h2>${esc(l.n)}</h2><p>${esc(l.d)}</p>
      <div class="acts"><button class="btn pri sm" data-a="lab" data-id="${l.id}">${learnDone(l.id) ? 'Ещё раз' : 'Начать'}</button></div></div>`).join('');
  return `<div class="mbox">${backHTML('Обучение')}
    <p class="mlead">Короткие сцены, по одной на механику. Каждая — маленькая карта с парой частей и одним-двумя ходами. Подсказки ведут по шагам: подсвечивают клетку или кнопку, куда нажать, и ждут настоящего действия. Противник в сценах не воюет.</p>
    <div class="mgrid">${cards}</div></div>`;
}
