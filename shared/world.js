'use strict';
/* ============================================================
   ОБЩИЙ МИР «FRONTLINE TACTICS»: карта, части, экономика, утилиты.
   Та же местность, что в «Линии» (shared/terrain.js — копия),
   но поверх неё — гексы (shared/hex.js). Фронт вертикальный:
   Альянс (n) слева, Союз (s) справа. 1 единица карты = 1 км.

   Ход — 4 игровых часа: стороны ходят по очереди, полный круг —
   «ход» (06:00, 10:00, 14:00, 18:00, 22:00, 02:00). Ходы в 22:00
   и 02:00 — ночные.

   Используется и сервером (require), и браузером (<script>).
   ============================================================ */
(function (g) {
  const GAME_VERSION = '2.0.0';
  const WW = 300, WH = 440;
  const N = 'n', S = 's';
  const COL = { n: '#6cc3ff', s: '#ff5b47' };
  /* ============================================================
     ФРАКЦИИ. Пока различаются только названием и техникой: боевые
     характеристики берутся из общей таблицы UT, фракция переопределяет
     подпись части и единицу счёта. Заделка под настоящие фракции —
     поля mul и only: движок читает их через utFor(), сейчас они пустые.
       mul   — множители к характеристикам: { tnk: { def: 1.1 } }
       only  — какие типы частей доступны фракции (пусто = все)
     ============================================================ */
  const FACTIONS = {
    alliance: {
      id: 'alliance', n: 'Альянс', gen: 'Альянса', style: 'nato', mul: {}, only: null,
      units: {
        inf:  { n: 'Мотопехотный батальон',             eln: 'бойцов' },
        mot:  { n: 'Мотопехота на «Страйкерах»',        eln: '«Страйкеров»' },
        rec:  { n: 'Разведрота на «Хамви»',             eln: '«Хамви»' },
        tnk:  { n: 'Танковый батальон «Абрамс»',        eln: '«Абрамсов»' },
        at:   { n: 'Противотанковый дивизион «Джавелин»', eln: 'ПТРК' },
        art:  { n: 'Артдивизион «Паладин»',             eln: 'САУ' },
        mlrs: { n: 'Дивизион HIMARS',                   eln: 'установок' },
        aa:   { n: 'Зенитный дивизион «Пэтриот»',       eln: 'пусковых' },
        eng:  { n: 'Инженерный батальон',               eln: 'машин' },
        hq:   { n: 'Штаб бригады',                      eln: 'машин' }
      }
    },
    union: {
      id: 'union', n: 'Союз', gen: 'Союза', style: 'cis', mul: {}, only: null,
      units: {
        inf:  { n: 'Мотострелковый батальон',           eln: 'бойцов' },
        mot:  { n: 'Мотопехота на БМП-2',               eln: 'БМП-2' },
        rec:  { n: 'Разведрота на БРДМ',                eln: 'БРДМ' },
        tnk:  { n: 'Танковый батальон Т-72',            eln: 'Т-72' },
        at:   { n: 'Противотанковый дивизион «Конкурс»', eln: 'установок' },
        art:  { n: 'Артдивизион «Мста-С»',              eln: 'САУ' },
        mlrs: { n: 'Дивизион «Град»',                   eln: 'установок' },
        aa:   { n: 'Зенитный дивизион «Тунгуска»',      eln: 'машин' },
        eng:  { n: 'Инженерный батальон',               eln: 'машин' },
        hq:   { n: 'Штаб бригады',                      eln: 'машин' }
      }
    }
  };
  /* сколько командиров может быть на одной стороне: 1 на 1 … 3 на 3 */
  const MAX_SEATS = 3;
  /* какая фракция играет за какую сторону — пока закреплено */
  const SIDE_FACTION = { n: 'alliance', s: 'union' };
  const SIDE_NAME = { n: FACTIONS.alliance.n, s: FACTIONS.union.n };
  const SIDE_GEN = { n: FACTIONS.alliance.gen, s: FACTIONS.union.gen };

  /*
     Части. У всех 10 шагов силы (str); el — сколько «единиц» на шаг (для подписи: 10 танков, 300 бойцов).
       cls   подвижность: foot · wheel · track (стоимость клеток)
       arm   защита: soft (пехота) · light (лёгкая броня) · hard (танки)
       mp    очки хода;  vis — обзор, клеток;  th — тепловизоры (ночь не мешает)
       atk   атака по классам целей;  def — оборона
       bomb  огонь с закрытых позиций: { rng (клеток), pow, area (задевает соседей), reload (ходов) }
       cap   берёт точки;  stl — малозаметна (видна только вплотную)
       aa    прикрывает от авиации в радиусе, клеток;  cmd — радиус управления штаба;  eng — сапёры
  */
  const UT = {
    inf:  { n: 'Мотострелковый батальон', sh: 'ПЕХ', cls: 'foot',  arm: 'soft',  mp: 3, vis: 2, atk: { soft: 6, light: 5, hard: 4 }, def: 7, cap: 1, el: 30, eln: 'бойцов', price: 60 },
    mot:  { n: 'Мотопехота на БТР',      sh: 'МП',  cls: 'wheel', arm: 'light', mp: 6, vis: 2, atk: { soft: 7, light: 6, hard: 4 }, def: 5, cap: 1, el: 1, eln: 'БТР', price: 90 },
    rec:  { n: 'Разведрота',             sh: 'РАЗ', cls: 'wheel', arm: 'light', mp: 7, vis: 4, th: 1, stl: 1, atk: { soft: 4, light: 3, hard: 2 }, def: 3, cap: 1, el: .6, eln: 'БРДМ', price: 60 },
    tnk:  { n: 'Танковый батальон',      sh: 'ТАН', cls: 'track', arm: 'hard',  mp: 5, vis: 2, th: 1, atk: { soft: 8, light: 10, hard: 10 }, def: 8, cap: 1, el: 1, eln: 'танков', price: 150 },
    art:  { n: 'Артдивизион САУ',        sh: 'АРТ', cls: 'track', arm: 'light', mp: 4, vis: 1, atk: { soft: 1, light: 1, hard: 0 }, def: 3, el: .6, eln: 'САУ', price: 120,
            bomb: { rng: 3, pow: 9, reload: 0 } },
    mlrs: { n: 'Дивизион РСЗО',          sh: 'РСЗО', cls: 'wheel', arm: 'light', mp: 5, vis: 1, atk: { soft: 0, light: 0, hard: 0 }, def: 2, el: .4, eln: 'установок', price: 170,
            bomb: { rng: 5, pow: 13, area: 1, reload: 1 } },
    aa:   { n: 'Зенитный дивизион',      sh: 'ПВО', cls: 'track', arm: 'light', mp: 5, vis: 2, atk: { soft: 2, light: 2, hard: 0 }, def: 4, el: .4, eln: 'машин', price: 100, aa: 2 },
    eng:  { n: 'Инженерный батальон',    sh: 'ИНЖ', cls: 'track', arm: 'light', mp: 4, vis: 2, atk: { soft: 4, light: 3, hard: 3 }, def: 5, el: .8, eln: 'машин', price: 90, eng: 1 },
    at:   { n: 'Противотанковый дивизион', sh: 'ПТ', cls: 'wheel', arm: 'light', mp: 4, vis: 2, atk: { soft: 2, light: 7, hard: 9 }, def: 5, el: 1.2, eln: 'орудий', price: 80, atd: 1 },
    hq:   { n: 'Штаб бригады',           sh: 'КП',  cls: 'wheel', arm: 'light', mp: 5, vis: 2, atk: { soft: 1, light: 0, hard: 0 }, def: 2, el: .4, eln: 'машин', price: 120, cmd: 5 }
  };
  const UT_ORDER = ['inf', 'mot', 'rec', 'tnk', 'at', 'art', 'mlrs', 'aa', 'eng', 'hq'];

  /* таблицы частей по сторонам: общие характеристики + правки фракции.
     Считаются один раз; движок и клиент берут их через utFor(side). */
  const UT_SIDE = {};
  for (const side of [N, S]) {
    const F = FACTIONS[SIDE_FACTION[side]], t = {};
    for (const k of Object.keys(UT)) {
      const over = (F.units || {})[k] || {}, mul = (F.mul || {})[k] || {};
      t[k] = Object.assign({}, UT[k], over);
      for (const f of Object.keys(mul)) if (typeof t[k][f] === 'number') t[k][f] = t[k][f] * mul[f];
    }
    UT_SIDE[side] = t;
  }
  /** таблица частей стороны: UT с названиями и техникой её фракции */
  const utFor = side => UT_SIDE[side] || UT;
  /** подпись части у стороны — для журналов, панелей и подсказок */
  const unitName = (side, k) => (utFor(side)[k] || UT[k] || {}).n || k;
  /** какие типы доступны фракции стороны (пусто в FACTIONS.only = все) */
  const unitsFor = side => {
    const F = FACTIONS[SIDE_FACTION[side]];
    return F && F.only ? UT_ORDER.filter(k => F.only.includes(k)) : UT_ORDER;
  };
  const factionOf = side => FACTIONS[SIDE_FACTION[side]] || FACTIONS.alliance;
  const MAX_STR = 10;
  const ROLE_TXT = {
    inf: 'Держит города и лес, дёшево берёт точки. Медленная.',
    mot: 'Быстрая пехота: прорыв по дорогам, захват тылов.',
    rec: 'Видит на 4 клетки, сама малозаметна, выходит из зон контроля.',
    tnk: 'Главная ударная сила. Плохо в лесу и городе против пехоты.',
    art: 'Бьёт на 3 клетки без ответа, подавляет перед атакой.',
    mlrs: 'Бьёт на 5 клеток по площади (цель и соседи). Ход на перезарядку.',
    aa: 'Сбивает авиаудары в радиусе 2 клеток.',
    eng: 'Понтон, подрыв моста, мины, укрепления, противотанковые заграждения.',
    at: 'Засада на танки: в обороне против брони втрое злее, бьёт технику вблизи.',
    hq: 'Управление: части в 5 клетках бьют сильнее и ходят дальше.'
  };

  const CS_N = ['Сокол','Ясень','Клён','Буран','Омега','Рассвет','Тигр','Коршун','Волна','Ручей','Утёс','Иней','Гранит','Полюс','Вереск','Заря','Орбита','Кедр'];
  const CS_S = ['Шторм','Ястреб','Зенит','Пепел','Клин','Набат','Гроза','Филин','Камень','Степь','Барс','Искра','Факел','Вулкан','Орион','Жара','Самум','Кобра'];

  /* точки — город/узел: id, имя, город?, координаты, вес, владелец при старте */
  const POINT_DEF = [
    { id: 'velsk', n: 'Вельск', city: 1, x: 42,  y: 210, w: 3,   owner: N },
    { id: 'gorn',  n: 'Горное', city: 1, x: 58,  y: 78,  w: 2,   owner: N },
    { id: 'lip',   n: 'Липовка', city: 1, x: 64,  y: 340, w: 2,   owner: N },
    { id: 'yary',  n: 'Яры', city: 0, x: 96,  y: 150, w: 1.2, owner: N },
    { id: 'kam',   n: 'Каменка', city: 1, x: 108, y: 268, w: 1.6, owner: N },
    { id: 'vys',   n: 'Высота 214', city: 0, x: 142, y: 92,  w: 1.4, owner: N },
    { id: 'brod',  n: 'Броды', city: 1, x: 148, y: 210, w: 1.5, owner: N },
    { id: 'olh',   n: 'Ольховка', city: 0, x: 152, y: 330, w: 1.3, owner: S },
    { id: 'most',  n: 'Мост', city: 0, x: 168, y: 154, w: 1.5, owner: S },
    { id: 'raz',   n: 'Разъезд', city: 0, x: 176, y: 392, w: 1.1, owner: S },
    { id: 'step',  n: 'Степное', city: 1, x: 198, y: 250, w: 1.8, owner: S },
    { id: 'zar',   n: 'Заречье', city: 1, x: 228, y: 86,  w: 2,   owner: S },
    { id: 'kras',  n: 'Красногор', city: 1, x: 262, y: 210, w: 3,   owner: S },
    { id: 'ugol',  n: 'Угольный', city: 1, x: 244, y: 360, w: 2,   owner: S }
  ];
  const ROAD_LINKS = [[0, 4], [1, 3], [2, 4], [4, 6], [6, 10], [10, 12], [11, 12], [5, 8], [8, 11], [7, 10], [7, 13], [13, 12], [2, 7], [0, 3], [3, 6], [1, 5], [0, 2]];

  /* ---------- экономика и исход ---------- */
  const START_BUDGET = 1300;
  const BASE_INCOME = 30;           /* очков за ход */
  const INCOME_PER_WEIGHT = 10;     /* за единицу веса своей точки (город ×1.5) */
  const ROLE_BUDGET_MUL = { attacker: 1.12, defender: 1, both: 1 };
  const ROLE_INCOME_MUL = { attacker: 1, defender: 1.3, both: 1 };
  /** перевес за ход: разница весов точек × SCORE_RATE; ±100 — победа */
  const SCORE_RATE = 1.8;
  const TURN_LIMIT = 30;            /* 5 суток */
  const MAX_UNITS = 28;
  /** зоны расстановки: столбцы гексов от своего края */
  const DEPLOY_X = { n: [0, 118], s: [182, WW] };
  /** авиация: вылетов за ход (днём / ночью) */
  const AIR = { strike: [2, 1], recon: [1, 1], pow: 10 };
  /** снабжение: запас части 0–3 (боеприпасы, топливо, продовольствие); округа — от городов и тыла */
  const SUPPLY = {
    max: 3,                          /* полный запас */
    regain: 2,                       /* в снабжении — за ход */
    over: 2,                         /* в перегруженном округе запас не выше */
    cityCap: w => 3 + 3 * w,         /* сколько частей держит город */
    cityR: w => 7 + 2 * w,           /* дальность подвоза от города (в шагах, дорога — полшага) */
    edgeCap: 99, edgeR: 14,          /* тыл: край карты */
    att: [0, .6, .85, 1], def: [.5, .8, 1, 1]
  };
  /** командные очки и приказы штаба */
  const CP = { start: 2, per: 1, hq: 1, max: 6 };
  const ORDERS = {
    barrage: { n: 'Артподготовка', cp: 2, tgt: 'none', d: 'В этот ход вся артиллерия бьёт в полтора раза сильнее.' },
    march:   { n: 'Форсированный марш', cp: 1, tgt: 'unit', d: 'Части +3 очка хода, мораль −10.' },
    hold:    { n: 'Стоять насмерть', cp: 1, tgt: 'unit', d: 'До вашего следующего хода часть не отходит и обороняется ×1,3.' },
    smoke:   { n: 'Дымовая завеса', cp: 2, tgt: 'hex', d: 'Клетка и соседние в дыму до вашего хода: противник видит туда только вплотную, огонь и атаки по дыму слабее.' },
    airdrop: { n: 'Снабжение по воздуху', cp: 2, tgt: 'unit', d: 'Транспортники сбрасывают части +2 запаса — спасение для котла. Нужна лётная погода.' },
    reserve: { n: 'Резерв ставки', cp: 6, tgt: 'hex', d: 'Бесплатная мотопехота (7 из 10) в своём городе или узле либо рядом.' },
    counter: { n: 'Контрудар', cp: 2, tgt: 'none', d: 'В этот ход атаки по противнику в ваших исходных точках и рядом с ними — ×1,3, атакующим +10 морали. Чтобы вернуть потерянное.' }
  };
  const ORDER_LIST = ['barrage', 'counter', 'march', 'hold', 'smoke', 'airdrop', 'reserve'];

  const TRAITS = ['решительный', 'осторожный', 'методичный', 'нервный', 'упрямый'];
  const GEN_FIRST = ['Иван', 'Пётр', 'Олег', 'Семён', 'Андрей', 'Глеб', 'Виктор', 'Макар', 'Роман', 'Тимур'];
  const GEN_LAST = ['Воронцов', 'Гром', 'Садовский', 'Крылов', 'Бурый', 'Жилин', 'Остапенко', 'Леднёв', 'Рябов', 'Шахов'];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => a + (b - a) * t;
  function mulberry(a) {
    return () => {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pick(rnd, list) { return list[Math.floor((rnd ? rnd() : Math.random()) * list.length)] }
  /** время хода: ход 0 — 06:00, шаг 4 часа */
  const hourOfTurn = t => (6 + 4 * t) % 24;
  const isNight = t => { const h = hourOfTurn(t); return h === 22 || h === 2 };
  const turnClock = t => String(hourOfTurn(t)).padStart(2, '0') + ':00';
  const dayOfTurn = t => 1 + Math.floor((6 + 4 * t) / 24);
  /** название со строчной, кроме аббревиатур */
  const lc = n => n.length > 1 && /[А-ЯЁ]/.test(n[1]) ? n : n[0].toLowerCase() + n.slice(1);
  /** «квадрат» по координатам — как в «Линии» */
  const sq = p => Math.floor(p.x / 10) + '-' + Math.floor(p.y / 10);
  /** 1 танк, 2 танка, 5 танков — для подписи по-русски не мучаемся: «танков: 7» */
  const elCount = (k, str) => Math.round(UT[k].el * str * 10) / 10;

  const api = {
    GAME_VERSION, WW, WH, N, S, COL, SIDE_NAME, SIDE_GEN, UT, UT_ORDER, MAX_STR,
    FACTIONS, SIDE_FACTION, utFor, unitName, unitsFor, factionOf, MAX_SEATS, ROLE_TXT, CS_N, CS_S, POINT_DEF, ROAD_LINKS,
    START_BUDGET, BASE_INCOME, INCOME_PER_WEIGHT, ROLE_BUDGET_MUL, ROLE_INCOME_MUL, SCORE_RATE, TURN_LIMIT, MAX_UNITS, DEPLOY_X, AIR, SUPPLY, CP, ORDERS, ORDER_LIST,
    TRAITS, GEN_FIRST, GEN_LAST,
    clamp, dist, lerp, mulberry, pick, hourOfTurn, isNight, turnClock, dayOfTurn, lc, sq, elCount
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(g, api);
})(typeof window !== 'undefined' ? window : globalThis);
