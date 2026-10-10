'use strict';
/* ============================================================
   ОБУЧЕНИЕ: отдельный пункт меню и пошаговый разбор.
   ------------------------------------------------------------
   Учебная операция (scen.tutorial) ведёт игрока шаг за шагом:
   каждый шаг подсвечивает, куда нажать (клетка на карте — кольцом,
   кнопка или клавиша — рамкой), и ждёт, пока действие будет
   сделано настоящим вводом. Сделал — шаг сменяется сам. Шаги
   привязаны к ходу операции (t) и смотрят только на видимое
   игроку состояние. Сервер шлёт подсказки в снимке (tipFor) —
   здесь они не нужны: разбор целиком на клиенте.
   ============================================================ */

const LESSON_T = ['Разведка боем', 'Обстрел и удар', 'Обход', 'Полевой склад', 'Подготовленная атака', 'Штурм Песчаного'];

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
  }
};

/** шаги учебной операции: t — ход (0..5), target — что подсветить, done — сделано ли */
const COACH = [];
const step = (t, o) => COACH.push(Object.assign({ t }, o));

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
/** выбрать часть k (без подведения) */
function stepSel(t, k, title, text) {
  step(t, {
    title, text,
    target: () => { const x = CO.mine(k); return x ? { hex: x.hex } : null },
    done: () => { const x = CO.mine(k); return !x || x.acted || G.sel === x.id }
  });
}
/** нажать кнопку или клавишу: подсветка — элемент по селектору, done — режим включён или слой открыт */
function stepKey(t, sel, keys, title, text, done) {
  step(t, { title, text, keys, target: () => ({ sel }), done });
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
function stepEnd(t) {
  step(t, {
    title: 'Конец хода',
    text: 'Нажмите «Конец хода» или <kbd>Enter</kbd>. Противник сходит, и начнётся следующий урок.',
    keys: 'Enter', target: () => ({ sel: '#btnEnd' }), done: () => G.turn > t
  });
}

/* ---- урок 1: разведка боем ---- */
stepApproach(0, 'rec', 1, 1, 'Подведите разведку', 'Выберите разведроту, затем кликните по подсвеченной клетке рядом с вражеской заставой. Разведчики видят на 4 клетки и малозаметны.');
stepKey(0, '#rc [data-a="probe"]', 'E', 'Разведка боем', 'Нажмите кнопку «Разведка боем» в карточке части или клавишу <kbd>E</kbd>. Это малая атака: она почти ничего не стоит и вскрывает оборону.', () => G.mode === 'probe');
stepHit(0, 'rec', 'Вскройте заставу', 'Кликните по вражеской части рядом. Вы увидите её мораль и запасы, а окоп станет на уровень ниже.');
stepApproach(0, 'art', 1, 3, 'Артиллерия — на позицию', 'Выберите артиллерию и подведите её в радиус огня (пунктирный круг на карте). Огонь с закрытых позиций прижимает оборону.');
stepHit(0, 'art', 'Залп', 'Кликните по врагу в радиусе. Прижатые шаги обороняются хуже — это подготовка атаки.');
stepEnd(0);

/* ---- урок 2: обстрел и удар ---- */
stepApproach(1, 'inf', 1, 1, 'Пехота подходит', 'Выберите пехоту и подведите её к врагу — подсвеченная клетка рядом с ним.');
stepKey(1, '#rc [data-a="fire"]', 'R', 'Обстрел с места', 'Нажмите «Обстрел» или <kbd>R</kbd>. Пехота останется в окопе и не займёт клетку, но прижмёт врага огнём.', () => G.mode === 'fire');
stepHit(1, 'inf', 'Ведите огонь', 'Кликните по врагу рядом. Обстрел — без штурма: цель прижата, ваша часть на месте.');
stepApproach(1, 'tnk', 1, 1, 'Танки — в удар', 'Выберите танковый батальон и подведите к прижатому врагу. Соотношение сил видно при наведении на врага.');
stepHit(1, 'tnk', 'Атака', 'Кликните по врагу рядом: это штурм. Если прижали обстрелом, шансы выше.');
stepEnd(1);

/* ---- урок 3: обход ---- */
stepApproach(2, 'mot', 2, 3, 'Обход', 'Выберите мотопехоту и переведите её на подсвеченную клетку в 2–3 клетках от врага — за его спиной. Красные знаки «стоп» на клетках хода показывают, где её остановит зона контроля.');
stepEnd(2);

/* ---- урок 4: полевой склад ---- */
stepKey(3, '#layerBox [data-l="supply"]', 'S', 'Слой снабжения', 'Включите слой снабжения: клавиша <kbd>S</kbd> или кнопка ⛟ справа. Зелёным — клетки с подвозом, красным — без него.', () => G.showSupply);
stepSel(3, 'dep', 'Полевой склад', 'Выберите склад (СКЛ). Он источник подвоза: поставьте его ближе к передовой — отсюда он кормит округу. В ход переезда не работает.');
stepEnd(3);

/* ---- урок 5: подготовленная атака ---- */
step(4, {
  title: 'Подготовленная атака',
  text: 'Часть с значком ▲ простояла ход рядом с врагом и не двигалась — её удар ×1,2. Выберите её.',
  target: () => { const p = CO.prepAll()[0]; return p ? { hex: p.hex } : null },
  done: () => { const p = CO.prepAll()[0]; return !p || G.sel === p.id }
});
step(4, {
  title: 'Удар с готовой позиции',
  text: 'Кликните по врагу рядом: часть не двигается, поэтому бонус сохраняется.',
  target: () => { const p = CO.prepAll().find(x => x.id === G.sel) || CO.prepAll()[0]; const e = p && CO.foeIn(p, 1, 1); return e ? { hex: e.hex } : null },
  done: () => CO.prepAll().length === 0
});
stepEnd(4);

/* ---- урок 6: штурм ---- */
step(5, {
  title: 'Штурм Песчаного',
  text: 'Городом овладевают, войдя в него. Двигайте часть на подсвеченный город — пехота, мотопехота, танки или разведка.',
  target: () => { const p = G.pts.find(q => q.id === 'pesch'); return p && p.owner !== G.side ? { hex: p.hex } : null },
  done: () => { const p = G.pts.find(q => q.id === 'pesch'); return !p || p.owner === G.side }
});
stepEnd(5);

const COACH_LESSONS = new Set(COACH.map(s => s.t)).size;

/** учебная операция идёт, а ход за противником — карточка ждёт, а не пропадает */
function coachWaiting() { return !!(G.scen && G.scen.tutorial && !G.spec && !G.over && G.roomId && !G.isMyTurn) }

/** текущий шаг: первый ещё не сделанный и не пропущенный на ходу, который сейчас идёт */
function coachCur() {
  if (!G.scen || !G.scen.tutorial || G.spec || G.over || !G.roomId || !G.isMyTurn) return null;
  if (!G.coachSkip) G.coachSkip = new Set();
  if (!G.coachDone) G.coachDone = new Set();
  const same = COACH.map((s, i) => i).filter(i => COACH[i].t === G.turn);
  for (const i of same) {
    const s = COACH[i];
    if (G.coachSkip.has(i)) continue;
    /* сделанный шаг остаётся сделанным: режим или выбор могут сброситься сразу после действия */
    if (!G.coachDone.has(i)) { let d = false; try { d = s.done() } catch (e) { d = false } if (d) G.coachDone.add(i) }
    if (G.coachDone.has(i)) continue;
    const pos = same.indexOf(i);
    return { i, s, n: pos + 1, of: same.length };
  }
  return null;
}

let coachKey = -1, coachEl = null;
/** каждый кадр: подсветка цели и карточка шага; карточку перерисовываем только при смене шага */
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
/** карточка шага: номер, заголовок, текст, точки прогресса и кнопки */
function coachCard(cur, wait) {
  const el = $('#tutor');
  if (!el) return;
  if (wait) {
    el.innerHTML = `<div class="tk">Обучение · ход противника</div>
      <div class="ctitle">Противник сходит</div>
      <div class="ctext">Следующий шаг начнётся, когда он закончит ход и вы снова будете на ходу.</div>
      <p class="acts"><button class="btn sm" id="coachMenu">В меню</button></p>`;
    el.hidden = false;
    $('#coachMenu').onclick = () => leaveToMenu();
    return;
  }
  if (!cur) { el.hidden = true; return }
  const dots = Array.from({ length: cur.of }, (_, j) => `<i class="${j < cur.n - 1 ? 'done' : j === cur.n - 1 ? 'now' : ''}"></i>`).join('');
  el.innerHTML = `<div class="tk">Обучение · урок ${cur.s.t + 1} из ${COACH_LESSONS} · шаг ${cur.n} из ${cur.of}</div>
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

/* ---------- страница «Обучение» в меню ---------- */
function learnDone() { try { return !!localStorage.getItem('turn.learn') } catch (e) { return false } }
function learnHTML() {
  const lessons = LESSON_T.map((t, i) => `<li><b>Урок ${i + 1}.</b> ${esc(t)}</li>`).join('');
  return `<div class="mbox">${backHTML('Обучение')}
    <p class="mlead">Учебная операция: шесть ходов, Альянс против бота. Подсказки ведут по шагам: подсвечивают клетку или кнопку, куда нажать, и ждут настоящего действия. Шаг сменяется сам, его можно пропустить.</p>
    <div class="mlab">Шесть уроков</div>
    <ul class="mlessons">${lessons}</ul>
    <p class="acts"><button class="btn pri" data-a="tutor">${learnDone() ? 'Пройти ещё раз' : 'Начать обучение'}</button></p>
    ${learnDone() ? '<p class="mnote">✓ Обучение пройдено</p>' : ''}</div>`;
}
