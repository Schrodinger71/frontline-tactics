'use strict';
/* ============================================================
   ПОГОДА — общая таблица для правил и отрисовки
     vis   — множитель дальности наблюдения
     acc   — множитель точности огня
     fly   — авиация и дроны летают (false — нелётная, всё в воздухе уходит на базу)
     drone — множитель живучести дронов в воздухе (ветер, обледенение)
     mud   — распутица: множитель скорости вне дорог (1 — сухо)
     look  — как рисовать: clear · cloud · fog · rain · snow · storm
     w     — вес при выборе следующей погоды
   ============================================================ */
(function (g) {
  const WEATHER = [
    { id: 'clear', n: 'Ясно',      vis: 1,   acc: 1,   fly: true,  drone: 1,  mud: 1,   look: 'clear', w: 3,
      d: 'Видимость полная, авиация и дроны работают без ограничений.' },
    { id: 'cloud', n: 'Облачно',   vis: .92, acc: 1,   fly: true,  drone: 1,  mud: 1,   look: 'cloud', w: 3,
      d: 'Немного хуже наблюдение, в остальном без изменений.' },
    { id: 'rain',  n: 'Дождь',     vis: .78, acc: .9,  fly: true,  drone: .7, mud: .7,  look: 'rain',  w: 1.6,
      d: 'Грунт раскис — техника вне дорог ползёт. Хуже видимость и точность, дроны сносит.' },
    { id: 'fog',   n: 'Туман',     vis: .5,  acc: .82, fly: false, drone: 0,  mud: .9,  look: 'fog',   w: 1.2,
      d: 'Наблюдение вдвое короче, авиация на земле. Время для скрытного выдвижения.' },
    { id: 'snow',  n: 'Снегопад',  vis: .65, acc: .85, fly: false, drone: 0,  mud: .65, look: 'snow',  w: .8,
      d: 'Тяжело всем: техника вязнет, авиация на земле, видимость плохая.' },
    { id: 'storm', n: 'Гроза',     vis: .7,  acc: .85, fly: false, drone: 0,  mud: .75, look: 'storm', w: .7,
      d: 'Шквал и ливень: вертолёты и дроны не летают, связь с помехами.' }
  ];
  const wxById = id => WEATHER.find(w => w.id === id) || WEATHER[0];

  const api = { WEATHER, wxById };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(g, api);
})(typeof window !== 'undefined' ? window : globalThis);
