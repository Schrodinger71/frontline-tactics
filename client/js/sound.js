'use strict';
/* ============================================================
   ЗВУК (клиент) — всё синтезируется Web Audio, без файлов,
   по рецептам «Ночного рубежа».
     бой      разрывы (удар, раскат, осыпь), очереди, выстрел
              танка, пуск ракет, выходы артиллерии — громкость и
              тембр от удалённости от центра экрана и масштаба;
     моторы   рокот вертолётов и гул штурмовиков рядом с центром;
     эфир     щелчки тангенты на сообщения;
     фон      ветер, дождь, птицы днём, сверчки ночью, далёкая
              канонада, когда бой идёт за краем экрана;
     музыка   медленный тёмный эмбиент на аккордах.
   Всё через компрессор и общий ревер. Настройки — в localStorage.
   ============================================================ */

const Sound = (() => {
  const DEF = { on: true, master: .6, sfx: .75, radio: .4, amb: .55, music: .3 };
  let cfg = Object.assign({}, DEF);
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('line.sound') || '{}')) } catch (e) { /* без настроек */ }
  const save = () => { try { localStorage.setItem('line.sound', JSON.stringify(cfg)) } catch (e) { /* приватный режим */ } };

  let ac = null, out, comp, verb, bus = {}, send = {}, noiseBuf, brownBuf, crush, amb = null;
  let lastBoom = 0, boomsNow = 0, lastShot = 0, lastRadio = 0, mus = null;
  const voices = new Map();
  const ready = () => ac && cfg.on && ac.state === 'running';

  function unlock() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    comp = ac.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 20; comp.ratio.value = 4; comp.attack.value = .008; comp.release.value = .35;
    const shelf = ac.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 5500; shelf.gain.value = -7;
    out = ac.createGain(); out.gain.value = cfg.on ? cfg.master : 0;
    comp.connect(shelf); shelf.connect(out); out.connect(ac.destination);
    verb = ac.createConvolver(); verb.buffer = impulse(3.2, 2.6);
    const vg = ac.createGain(); vg.gain.value = .45; verb.connect(vg); vg.connect(comp);
    /* у каждой категории — сухая шина и свой посыл на общий ревер: иначе ползунок
       категории не управляет хвостом отражений, и слышен только «Общая» */
    for (const k of ['sfx', 'radio', 'amb', 'music']) {
      const g = ac.createGain(); g.gain.value = cfg[k]; g.connect(comp); bus[k] = g;
      const sg = ac.createGain(); sg.gain.value = cfg[k]; sg.connect(verb); send[k] = sg;
    }
    noiseBuf = makeNoise(4); brownBuf = makeBrown(4); crush = softClip(2.6);
    startAmbient();
    startMusic();
  }

  function makeNoise(sec) {
    const b = ac.createBuffer(1, ac.sampleRate * sec, ac.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = .99765 * b0 + w * .099; b1 = .963 * b1 + w * .2965; b2 = .57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * .1848) * .2;
    }
    return b;
  }
  function makeBrown(sec) {
    const b = ac.createBuffer(1, ac.sampleRate * sec, ac.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + .02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5 }
    return b;
  }
  function softClip(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k) }
    return c;
  }
  function impulse(sec, decay) {
    const len = ac.sampleRate * sec, b = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) }
    return b;
  }

  /* ---------- примитивы ---------- */
  function noiseSrc(buf) { const s = ac.createBufferSource(); s.buffer = buf || noiseBuf; s.loop = true; return s }
  function filt(type, f, q) { const x = ac.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q || .7; return x }
  function noise(dest, t, dur, o) {
    const s = noiseSrc(o.brown ? brownBuf : null); s.playbackRate.value = o.rate || 1;
    const f = filt(o.type || 'lowpass', o.f0, o.q);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.vol, t + (o.att || .005));
    if (o.hold) g.gain.setValueAtTime(o.vol, t + (o.att || .005) + o.hold);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t, Math.random() * 3); s.stop(t + dur + .05);
  }
  function tone(dest, t, dur, o) {
    const x = ac.createOscillator(); x.type = o.wave || 'sine';
    x.frequency.setValueAtTime(o.f0, t);
    if (o.f1) x.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.vol, t + (o.att || .01));
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    x.connect(g); g.connect(dest); x.start(t); x.stop(t + dur + .05);
  }

  /** где на карте звучит: near 0..1 (у центра крупным планом — 1), pan */
  function spot(p) {
    const q = w2s(p);
    const dx = (q.x - CW / 2) / (CW / 2), dy = (q.y - CH / 2) / (CH / 2);
    const far = Math.hypot(dx, dy), zoom = clamp((G.view.s - 1.2) / 6, 0, 1);
    return { near: clamp(1 - far * .45, 0, 1) * (.3 + .7 * zoom), far, pan: clamp(dx * .75, -.85, .85) };
  }
  function placed(p, busName, wet) {
    const s = spot(p);
    const g = ac.createGain(), lp = filt('lowpass', 300 + 7000 * s.near * s.near, .5);
    g.connect(lp);
    let tail = lp;
    if (ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = s.pan; lp.connect(pn); tail = pn }
    tail.connect(bus[busName]);
    const w = ac.createGain(); w.gain.value = (wet || .5) * (1.2 - s.near); tail.connect(w); w.connect(send[busName] || verb);
    g.gain.value = .2 + .8 * s.near;
    return { g, s };
  }

  /* ---------- бой ---------- */
  /** разрыв: щелчок фронта вблизи, плотный удар с перегрузом, раскат отражений, осыпь */
  function boom(o, small) {
    if (!ready()) return;
    const now = ac.currentTime;
    if (now - lastBoom < .1) { if (++boomsNow > 3) return } else boomsNow = 0;
    lastBoom = now;
    const { g, s } = placed(o, 'sfx', .9);
    if (s.far > 2.2) return;
    const pw = clamp(o.w ? Math.sqrt(o.w / 30) : small ? .5 : 1, .35, 1.6), k = small ? pw * .55 : pw;
    const t = now + (1 - s.near) * .4 + Math.random() * .04;
    const sh = ac.createWaveShaper(); sh.curve = crush; sh.oversample = '2x';
    const shG = ac.createGain(); shG.gain.value = .7; sh.connect(shG); shG.connect(g);
    if (s.near > .3) {
      noise(g, t, .05, { type: 'highpass', f0: 900, vol: .45 * k, att: .0008 });
      noise(g, t + .004, .16, { type: 'bandpass', f0: 2600, f1: 700, q: .7, vol: .2 * k, att: .001 });
    }
    noise(sh, t, .7 * k + .35, { brown: 1, f0: 180 + s.near * 260, f1: 55, vol: 1.05 * k, att: .002, hold: .03 });
    const n = 2 + (Math.random() * 3 | 0);
    let d = .12 + Math.random() * .1;
    for (let i = 0; i < n; i++) {
      noise(g, t + d, 1.3 + i * .5 + k, { brown: 1, f0: 140 - i * 15, f1: 35, vol: Math.max(.04, (.4 - i * .07) * k * (.6 + Math.random() * .5)), att: .06 + i * .03 });
      d += .18 + Math.random() * .45;
    }
    if (s.near > .45) for (let i = 0; i < 6; i++) noise(g, t + .45 + Math.random() * 1.5, .04, { type: 'bandpass', f0: 1200 + Math.random() * 3000, q: 2, vol: .02 + Math.random() * .03 * k, att: .001 });
  }

  /** стрельба: очередь пулемёта, выстрел танковой пушки, ПТУР, ПЗРК */
  function gun(o) {
    if (!ready()) return;
    const now = ac.currentTime;
    if (now - lastShot < .18) return;
    const { g, s } = placed(o, 'sfx', .4);
    if (s.near < .08) return;
    lastShot = now;
    if (o.kind === 'tank') {
      noise(g, now, .06, { type: 'highpass', f0: 1200, vol: .35, att: .0008 });
      noise(g, now, .8, { brown: 1, f0: 320, f1: 50, vol: .7, att: .002 });
      noise(g, now + .25, 1.6, { brown: 1, f0: 120, f1: 35, vol: .18, att: .1 });
    } else if (o.kind === 'atgm' || o.kind === 'manpad') {
      tone(g, now, .25, { f0: 120, f1: 50, vol: .2, att: .002 });
      noise(g, now + .03, 1.4, { type: 'bandpass', f0: 2400, f1: 700, q: .8, vol: .16, att: .02 });
    } else {
      const n = 5 + (Math.random() * 6 | 0), gap = .07 + Math.random() * .03;
      for (let i = 0; i < n; i++) {
        const t = now + i * gap + Math.random() * .01;
        noise(g, t, .08, { type: 'bandpass', f0: 800 + Math.random() * 500, q: .8, vol: .12, att: .001 });
        tone(g, t, .06, { f0: 150, f1: 70, vol: .08, att: .001 });
      }
    }
  }

  /** пуск ракеты ЗРК: хлопок вышибного заряда и рёв двигателя */
  function launch(o) {
    if (!ready()) return;
    const { g, s } = placed(o, 'sfx', .7);
    if (s.near < .08) return;
    const t = ac.currentTime;
    tone(g, t, .3, { f0: 110, f1: 45, vol: .28, att: .002 });
    noise(g, t, .25, { f0: 3000, f1: 400, vol: .22, att: .002 });
    noise(g, t + .05, 2.6, { type: 'lowpass', f0: 1600, f1: 400, vol: .3, att: .15 });
  }
  /** выход артиллерии: глухой удар и шорох уходящего снаряда */
  function outgoing(o, rockets) {
    if (!ready()) return;
    const { g, s } = placed(o, 'sfx', .8);
    if (s.near < .1) return;
    const t = ac.currentTime;
    if (rockets) for (let i = 0; i < 8; i++) noise(g, t + i * .09, 1.1, { type: 'bandpass', f0: 1800, f1: 500, q: .6, vol: .12, att: .01 });
    else { noise(g, t, .6, { brown: 1, f0: 260, f1: 50, vol: .6, att: .002 }); noise(g, t + .1, 1.2, { type: 'bandpass', f0: 1400, f1: 300, q: .6, vol: .05, att: .2 }) }
  }
  function thunder() {
    if (!ready()) return;
    const t = ac.currentTime + .4 + Math.random();
    noise(bus.amb, t, 5, { brown: 1, f0: 200, f1: 30, vol: .35, att: .05 });
  }

  /* ---------- эфир ---------- */
  function radio(cls) {
    if (!ready()) return;
    const t = ac.currentTime;
    if (t - lastRadio < .25) return;
    lastRadio = t;
    noise(bus.radio, t, .07, { type: 'bandpass', f0: 2400, q: 1.5, vol: .06, att: .002 });
    if (cls === 'crit') { tone(bus.radio, t + .08, .18, { f0: 880, vol: .05, wave: 'square' }); tone(bus.radio, t + .3, .18, { f0: 660, vol: .05, wave: 'square' }) }
    else if (cls === 'hq') tone(bus.radio, t + .06, .12, { f0: 1320, vol: .025, wave: 'triangle' });
    noise(bus.radio, t + .35 + Math.random() * .4, .12, { type: 'bandpass', f0: 2000, q: 1.2, vol: .05, att: .003 });
  }

  /* ---------- моторы ---------- */
  function makeVoice(kind) {
    const g = ac.createGain(); g.gain.value = 0;
    const lp = filt('lowpass', kind === 'jet' ? 2200 : 600, .7);
    let pan = null;
    if (ac.createStereoPanner) { pan = ac.createStereoPanner(); lp.connect(pan); pan.connect(g) } else lp.connect(g);
    g.connect(bus.sfx);
    const v = { g, pan, lp, kind, src: [] };
    if (kind === 'rotor') {
      /* хлопки лопастей: шум с амплитудной модуляцией ~ 16 Гц */
      const s = noiseSrc(brownBuf), am = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 15 + Math.random() * 3; lg.gain.value = .5; am.gain.value = .5;
      lfo.connect(lg); lg.connect(am.gain); s.connect(am); am.connect(lp);
      s.start(); lfo.start(); v.src.push(s, lfo);
    } else {
      const s = noiseSrc(), o = ac.createOscillator(), og = ac.createGain();
      o.type = 'sawtooth'; o.frequency.value = 180 + Math.random() * 40; og.gain.value = .05;
      s.connect(lp); o.connect(og); og.connect(lp); s.start(); o.start(); v.src.push(s, o);
    }
    return v;
  }
  function engines() {
    const want = [];
    if (G.speed) for (const u of G.units) {
      if (u.k !== 'hel' && u.k !== 'jet') continue;
      if (u.st === 'base' || u.st === 'rearm') continue;
      const s = spot(u);
      if (s.far < 1.3 && s.near > .15) want.push({ id: u.id, kind: u.k === 'hel' ? 'rotor' : 'jet', s });
    }
    want.sort((a, b) => b.s.near - a.s.near);
    const keep = new Set(want.slice(0, 4).map(w => w.id));
    for (const [id, v] of voices) if (!keep.has(id)) {
      v.g.gain.setTargetAtTime(0, ac.currentTime, .3);
      setTimeout(() => { for (const s of v.src) try { s.stop() } catch (e) { /* уже остановлен */ } }, 1500);
      voices.delete(id);
    }
    for (const w of want.slice(0, 4)) {
      let v = voices.get(w.id);
      if (!v) { v = makeVoice(w.kind); voices.set(w.id, v) }
      v.g.gain.setTargetAtTime((w.kind === 'jet' ? .22 : .3) * w.s.near, ac.currentTime, .25);
      if (v.pan) v.pan.pan.setTargetAtTime(w.s.pan, ac.currentTime, .2);
    }
  }

  /* ---------- фон ---------- */
  function startAmbient() {
    const bed = (type, f, q) => {
      const s = noiseSrc(), fl = filt(type, f, q), g = ac.createGain(); g.gain.value = 0;
      s.connect(fl); fl.connect(g); g.connect(bus.amb); s.start(0, Math.random() * 3);
      return { fl, g };
    };
    amb = { wind: bed('lowpass', 380, .8), rain: bed('bandpass', 2600, .4), hum: bed('lowpass', 90, .9), next: { bird: 0, cricket: 0, rumble: 0 } };
  }
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);

  function bird(t) {
    const f = 2600 + Math.random() * 1800, n = 2 + (Math.random() * 4 | 0);
    for (let i = 0; i < n; i++) tone(bus.amb, t + i * .13, .1, { f0: f * (1 + Math.random() * .2), f1: f * .8, vol: .012, att: .01 });
  }
  function cricket(t) {
    const f = 4200 + Math.random() * 900;
    for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) tone(bus.amb, t + r * .5 + i * .045, .03, { f0: f, vol: .01, att: .004 });
  }
  function rumble(t) {
    noise(bus.amb, t, 3 + Math.random() * 3, { f0: 150, f1: 40, vol: .08 + Math.random() * .06, att: .3 });
  }

  let busyT = 0;
  /** отметить, что где-то идёт бой (для далёкой канонады) */
  function busy() { busyT = performance.now() }

  /* ============================================================
     МУЗЫКА — живой набор треков (перенесён из «Деградации»).
     Каждый трек: лад, тональность, темп, гармония по тактам и набор
     голосов. Трек играет 16–32 такта и плавно уступает место другому
     из той же группы настроения. Настроение берётся из обстановки:
       day   расстановка и свой ход днём
       calm  ночь, чужой ход, затишье
       raid  недавно был бой
       dawn  итог операции
     Смена настроения — кроссфейд и короткая «вставка».
     ============================================================ */
  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], aeolian: [0, 2, 3, 5, 7, 8, 10]
  };
  /* prog — ступени лада (0 — тоника), по аккорду на такт; inst — какие голоса звучат */
  const TRACKS = [
    { n: 'Штаб днём', mood: 'day', root: 48, sc: 'lydian', bpm: 72, prog: [0, 4, 5, 3], inst: ['pad', 'piano', 'bass'] },
    { n: 'Карта края', mood: 'day', root: 45, sc: 'dorian', bpm: 84, prog: [0, 3, 6, 4], inst: ['arpSlow', 'bell', 'pad'] },
    { n: 'Сводки', mood: 'day', root: 50, sc: 'major', bpm: 66, prog: [0, 5, 3, 4], inst: ['piano', 'strings'] },
    { n: 'Тихое небо', mood: 'calm', root: 50, sc: 'minor', bpm: 58, prog: [0, 5, 3, 6], inst: ['pad', 'bellSparse', 'drone'] },
    { n: 'Дежурство', mood: 'calm', root: 52, sc: 'aeolian', bpm: 70, prog: [0, 6, 5, 4], inst: ['arpSlow', 'strings', 'bass'] },
    { n: 'Огни края', mood: 'calm', root: 42, sc: 'dorian', bpm: 54, prog: [0, 3, 0, 4], inst: ['piano', 'drone', 'pad'] },
    { n: 'Эфир', mood: 'calm', root: 47, sc: 'phrygian', bpm: 62, prog: [0, 1, 0, 6], inst: ['bellSparse', 'strings', 'drone'] },
    { n: 'Волна', mood: 'raid', root: 48, sc: 'minor', bpm: 96, prog: [0, 0, 5, 6], inst: ['ostinato', 'strings', 'bass8', 'pulse'] },
    { n: 'Перехват', mood: 'raid', root: 50, sc: 'phrygian', bpm: 104, prog: [0, 1, 0, 6], inst: ['arpFast', 'bass8', 'pulse', 'drone'] },
    { n: 'Пуск', mood: 'raid', root: 45, sc: 'minor', bpm: 90, prog: [0, 6, 5, 4], inst: ['ostinato', 'pad', 'pulse'] },
    { n: 'Рассвет', mood: 'dawn', root: 55, sc: 'major', bpm: 66, prog: [0, 3, 4, 0], inst: ['strings', 'bell', 'piano'] },
    { n: 'Отбой', mood: 'dawn', root: 52, sc: 'lydian', bpm: 60, prog: [0, 1, 4, 0], inst: ['pad', 'arpSlow'] }
  ];

  function startMusic() {
    const lp = filt('lowpass', 2600, .3), g = ac.createGain(), w = ac.createGain();
    g.gain.value = .6; w.gain.value = .7;
    lp.connect(g); g.connect(bus.music); g.connect(w); w.connect(send.music || verb);
    mus = { lp, cur: null, last: null, mood: null };
  }

  /** ноты аккорда: ступень лада → четыре звука (терции вверх) */
  function chordNotes(tr, deg) {
    const SC = SCALES[tr.sc], out = [];
    for (let k = 0; k < 4; k++) { const i = deg + k * 2; out.push(tr.root + SC[i % 7] + 12 * Math.floor(i / 7)) }
    return out;
  }

  /* голоса: каждый рисует такт начиная с t, длительностью d, на выход o */
  function vPad(o, t, d, n, vol) {
    for (const det of [-7, 6]) {
      const x = ac.createOscillator(), g = ac.createGain(), f = filt('lowpass', 1100, .4);
      x.type = 'sawtooth'; x.frequency.value = midi(n); x.detune.value = det;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + d * .4); g.gain.linearRampToValueAtTime(0, t + d + 1.2);
      x.connect(f); f.connect(g); g.connect(o); x.start(t); x.stop(t + d + 1.3);
    }
  }
  function vPluck(o, t, n, vol, dec) {
    const x = ac.createOscillator(), x2 = ac.createOscillator(), g = ac.createGain();
    x.type = 'triangle'; x2.type = 'sine'; x.frequency.value = midi(n); x2.frequency.value = midi(n) * 2.01;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .006); g.gain.exponentialRampToValueAtTime(.0001, t + dec);
    const g2 = ac.createGain(); g2.gain.value = .25;
    x.connect(g); x2.connect(g2); g2.connect(g); g.connect(o);
    x.start(t); x2.start(t); x.stop(t + dec + .05); x2.stop(t + dec + .05);
  }
  function vBell(o, t, n, vol) {
    tone(o, t, 3.5, { f0: midi(n), vol, att: .004 });
    tone(o, t, 2.2, { f0: midi(n) * 2.76, vol: vol * .35, att: .004 });
  }
  function vString(o, t, d, n, vol) {
    const x = ac.createOscillator(), g = ac.createGain(), f = filt('lowpass', 1500, .5), lfo = ac.createOscillator(), lg = ac.createGain();
    x.type = 'sawtooth'; x.frequency.value = midi(n);
    lfo.frequency.value = 5; lg.gain.value = 3; lfo.connect(lg); lg.connect(x.detune);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + d * .3); g.gain.setValueAtTime(vol, t + d * .8); g.gain.linearRampToValueAtTime(0, t + d + .6);
    x.connect(f); f.connect(g); g.connect(o); x.start(t); lfo.start(t); x.stop(t + d + .7); lfo.stop(t + d + .7);
  }
  function vKick(o, t, vol) { tone(o, t, .45, { f0: 70, f1: 38, vol, att: .004 }) }

  function playBar(tr, bar, t) {
    const o = tr.out, beat = 60 / tr.bpm, B = beat * 4;
    const ch = chordNotes(tr, tr.prog[bar % tr.prog.length]);
    const R = (a, b) => a + Math.random() * (b - a);
    for (const inst of tr.inst) {
      if (inst === 'pad') for (const n of ch.slice(0, 3)) vPad(o, t, B, n, .018);
      else if (inst === 'strings') { vString(o, t, B, ch[0] - 12, .02); vString(o, t, B, ch[2], .012) }
      else if (inst === 'drone' && bar % 2 === 0) vString(o, t, B * 2, tr.root - 12, .022);
      else if (inst === 'bass') vPluck(o, t, ch[0] - 12, .07, B * .9);
      else if (inst === 'bass8') for (let i = 0; i < 8; i++) vPluck(o, t + i * beat / 2, ch[0] - 12, i % 2 ? .035 : .06, beat * .45);
      else if (inst === 'piano') {
        /* мелодия по аккорду: 2–4 ноты в такте, случайный ритм */
        const k = 2 + (Math.random() * 3 | 0);
        for (let i = 0; i < k; i++) vPluck(o, t + Math.floor(R(0, 8)) * beat / 2, ch[(Math.random() * 4) | 0] + 12, .045, 2.2);
        vPluck(o, t, ch[0], .04, 2.5);
      }
      else if (inst === 'arpSlow') for (let i = 0; i < 4; i++) vPluck(o, t + i * beat, ch[[0, 1, 2, 1][i]] + 12, .035, beat * 1.6);
      else if (inst === 'arpFast') for (let i = 0; i < 16; i++) vPluck(o, t + i * beat / 4, ch[[0, 1, 2, 3, 2, 1, 2, 3][i % 8]] + 12, .022, beat * .5);
      else if (inst === 'ostinato') for (let i = 0; i < 8; i++) vPluck(o, t + i * beat / 2, ch[i % 2 ? 2 : 0], .03, beat * .4);
      else if (inst === 'bell' && Math.random() < .7) vBell(o, t + Math.floor(R(0, 4)) * beat, ch[(Math.random() * 3) | 0] + 24, .014);
      else if (inst === 'bellSparse' && Math.random() < .35) vBell(o, t + Math.floor(R(0, 4)) * beat, ch[(Math.random() * 3) | 0] + 24, .012);
      else if (inst === 'pulse') for (let i = 0; i < 4; i++) { vKick(o, t + i * beat, i % 2 ? .05 : .08); if (i === 3) vKick(o, t + i * beat + beat / 2, .04) }
    }
  }

  function startTrack(m, t, fade) {
    const pool = TRACKS.filter(x => x.mood === m && x !== mus.last);
    const tr = Object.assign({}, pool[(Math.random() * pool.length) | 0] || TRACKS[0]);
    tr.out = ac.createGain();
    tr.out.gain.setValueAtTime(0, t); tr.out.gain.linearRampToValueAtTime(1, t + fade);
    tr.out.connect(mus.lp);
    tr.bar = 0; tr.next = t + .05; tr.len = 16 + ((Math.random() * 3) | 0) * 8; tr.mood = m;
    if (mus.cur) {
      const old = mus.cur;
      old.out.gain.setTargetAtTime(0, t, fade / 3);
      setTimeout(() => old.out.disconnect(), (fade + 6) * 1000);
    }
    mus.last = TRACKS.find(x => x.n === tr.n);
    mus.cur = tr;
  }

  /** обстановка на фронте одним словом — под неё и подбирается трек */
  function musMood() {
    if (!G.roomId) return 'day';
    if (G.over) return 'dawn';
    if (G.phase === 'deploy') return 'day';
    if (performance.now() - busyT < 14000) return 'raid';
    if (G.night) return 'calm';
    return G.isMyTurn ? 'day' : 'calm';
  }
  /** короткая вставка на смену настроения: её слышно раньше, чем разойдётся новый трек */
  function sting(from, to, t) {
    if (to === 'raid') {
      /* три глухих удара, как большой барабан вдалеке */
      for (let i = 0; i < 3; i++) {
        tone(bus.music, t + i * .62, .9, { f0: 58, f1: 36, vol: .16, att: .004 });
        noise(bus.music, t + i * .62, .5, { f0: 500, f1: 80, vol: .07, att: .003 });
      }
    } else if (to === 'calm' && from === 'raid') {
      /* низкий аккорд, медленно раскрывается: волна схлынула */
      for (const n of [38, 45, 50]) tone(mus.lp, t, 6, { f0: midi(n), vol: .05, att: 2.4, wave: 'triangle' });
    } else if (to === 'dawn') {
      /* светлый аккорд: операция окончена */
      for (const n of [60, 64, 67, 71, 74]) tone(mus.lp, t, 9, { f0: midi(n), vol: .02, att: 3, wave: 'sine' });
    }
  }
  /** такты раскладываем на четверть секунды вперёд — иначе ритм рвётся на просадках */
  function musicTick(t) {
    if (!mus) return;
    const m = musMood();
    if (m !== mus.mood) { if (mus.mood) sting(mus.mood, m, t); mus.mood = m }
    if (!mus.cur) startTrack(m, t + .2, 3);
    else if (mus.cur.mood !== m) startTrack(m, t + .1, m === 'raid' ? 2.5 : 5);
    else if (mus.cur.bar >= mus.cur.len) startTrack(m, mus.cur.next, 6);
    const tr = mus.cur;
    while (tr.next < t + .25) { playBar(tr, tr.bar++, tr.next); tr.next += 60 / tr.bpm * 4 }
  }

  function update(dt) {
    if (!ready() || !amb) return;
    const t = ac.currentTime, w = G.weather || 'clear', night = nightK(G.t);
    const live = !!G.roomId && G.phase === 'battle' && !G.over;
    const windV = { clear: .04, cloud: .07, rain: .1, fog: .02, snow: .09, storm: .2, frost: .05, blizzard: .24 }[w] || .05;
    const winter = typeof mapWinter === 'function' && mapWinter();
    amb.wind.g.gain.setTargetAtTime(windV, t, 1.5);
    amb.wind.fl.frequency.setTargetAtTime(300 + windV * 1500, t, 2);
    amb.rain.g.gain.setTargetAtTime(w === 'rain' ? .07 : w === 'storm' ? .12 : 0, t, 2);
    amb.hum.g.gain.setTargetAtTime(live ? .04 : .015, t, 2);
    const nx = amb.next;
    /* зимой птиц мало, сверчков нет */
    if (live && night < .5 && w !== 'rain' && w !== 'storm' && w !== 'blizzard' && t > nx.bird) { if (!winter || Math.random() < .25) bird(t); nx.bird = t + 4 + Math.random() * 12 }
    if (live && night > .6 && !winter && (w === 'clear' || w === 'cloud') && t > nx.cricket) { cricket(t); nx.cricket = t + 1 + Math.random() * 4 }
    if (live && performance.now() - busyT < 8000 && t > nx.rumble) { rumble(t); nx.rumble = t + 3 + Math.random() * 6 }
    engines();
    musicTick(t);
  }

  function apply() {
    if (!ac) return;
    out.gain.setTargetAtTime(cfg.on ? cfg.master : 0, ac.currentTime, .05);
    for (const k of ['sfx', 'radio', 'amb', 'music']) {
      bus[k].gain.setTargetAtTime(cfg[k], ac.currentTime, .05);
      if (send[k]) send[k].gain.setTargetAtTime(cfg[k], ac.currentTime, .05);
    }
  }
  function set(k, v) { cfg[k] = v; save(); apply(); syncBtn() }
  function syncBtn() { const b = document.getElementById('btnSound'); if (b) b.textContent = cfg.on ? '🔊' : '🔇' }
  function panelHTML() {
    const row = (k, n) => `<label class="snd"><span>${n}</span><input type="range" min="0" max="1" step=".05" value="${cfg[k]}" data-snd="${k}"></label>`;
    return `<h2>Звук</h2>
      <label class="snd"><span>Включён</span><input type="checkbox" data-snd="on" ${cfg.on ? 'checked' : ''}></label>
      ${row('master', 'Общая')}${row('sfx', 'Бой')}${row('radio', 'Эфир')}${row('amb', 'Фон')}${row('music', 'Музыка')}
      <p class="acts"><button class="btn pri" id="btnClose">Готово</button></p>`;
  }
  function init() {
    const go = () => unlock();
    window.addEventListener('pointerdown', go, { capture: true });
    window.addEventListener('keydown', go, { capture: true });
    document.addEventListener('input', e => {
      const el = e.target.closest && e.target.closest('[data-snd]');
      if (!el) return;
      set(el.dataset.snd, el.type === 'checkbox' ? el.checked : +el.value);
    });
    syncBtn();
  }
  function toggle() { set('on', !cfg.on) }

  /** текущие усиления узлов — для диагностики: видно, что ползунок дошёл до графа */
  function levels() {
    if (!ac) return { ready: false };
    const r = { ready: true, master: out.gain.value };
    for (const k of ['sfx', 'radio', 'amb', 'music']) r[k] = { bus: bus[k].gain.value, send: send[k] ? send[k].gain.value : null };
    return r;
  }
  /** что сейчас играет — для диагностики, как и levels() */
  function music() { return mus && mus.cur ? { mood: mus.mood, track: mus.cur.n, bar: mus.cur.bar, len: mus.cur.len } : null }
  return { init, update, boom: (o, s) => boom(o, s), gun, launch, outgoing, thunder, radio, busy, panelHTML, toggle, levels, music };
})();
