/* Звук: AudioContext, общая шина с ревербом, инструменты, метроном и офлайн-рендер для WAV.
   Все инструменты синтезируются, аудиофайлов нет. Каждая функция получает контекст параметром,
   поэтому один и тот же код звучит и вживую, и в OfflineAudioContext при скачивании. */
(function (K) {
  'use strict';
  const { pc } = K.util;

  // gm — номер программы General MIDI для экспорта в .mid
  const INSTRUMENTS = [
    { id: 'piano',   name: 'Пианино',       gm: 0 },
    { id: 'epiano',  name: 'Электропиано',  gm: 4 },
    { id: 'organ',   name: 'Орган',         gm: 16 },
    { id: 'strings', name: 'Струнные',      gm: 48 },
    { id: 'guitar',  name: 'Гитара',        gm: 24 },
    { id: 'marimba', name: 'Маримба',       gm: 12 },
    { id: 'bells',   name: 'Колокольчики',  gm: 14 },
    { id: 'flute',   name: 'Флейта',        gm: 73 },
    { id: 'bass',    name: 'Бас',           gm: 38 },
    { id: 'chip',    name: '8-бит',         gm: 80 },
    { id: 'pad',     name: 'Мягкий синт',   gm: 89 },
    { id: 'drums',   name: 'Ударные',       gm: -1 }
  ];
  // Ударные: каждая ступень октавы — свой звук. gm — номер ноты в канале ударных General MIDI
  const DRUMS = [
    { name: 'Бочка', gm: 36 }, { name: 'Римшот', gm: 37 }, { name: 'Малый барабан', gm: 38 },
    { name: 'Хлопок', gm: 39 }, { name: 'Хай-хэт', gm: 42 }, { name: 'Низкий том', gm: 41 },
    { name: 'Открытый хай-хэт', gm: 46 }, { name: 'Средний том', gm: 45 }, { name: 'Шейкер', gm: 70 },
    { name: 'Высокий том', gm: 48 }, { name: 'Тарелка', gm: 49 }, { name: 'Ковбелл', gm: 56 }
  ];
  const byId = {};
  INSTRUMENTS.forEach(i => { byId[i.id] = i; });

  /* ---------- общая шина: вход → компрессор, параллельно посыл на ревербератор ---------- */
  const RES = new WeakMap();   // контекст → { noise, input, wet }
  const wetLevel = v => Math.max(0, Math.min(1, v)) * 0.6;

  function impulse(c, sec){
    const len = Math.floor(c.sampleRate * sec), buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++){
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return buf;
  }

  function resources(c){
    let r = RES.get(c);
    if (r) return r;
    const noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const input = c.createGain();
    input.gain.value = 0.8;
    const comp = c.createDynamicsCompressor();
    const verb = c.createConvolver();
    verb.buffer = impulse(c, 2.2);
    const wet = c.createGain();
    wet.gain.value = wetLevel(K.state.reverb);
    input.connect(comp);
    input.connect(verb);
    verb.connect(wet);
    wet.connect(comp);
    comp.connect(c.destination);
    r = { noise, input, wet };
    RES.set(c, r);
    return r;
  }

  let live = null;
  function ctx(){
    if (!live){
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      // iOS 16.4+: иначе Web Audio глушится боковым переключателем «Бесшумно»
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      // 'interactive' — минимальная задержка между касанием и звуком
      try { live = new AC({ latencyHint: 'interactive' }); } catch (e) { live = new AC(); }
      resources(live);
    }
    // suspended — до первого жеста, interrupted — на iOS после звонка или Siri
    if (live.state !== 'running' && live.state !== 'closed'){
      try { const p = live.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
    return live;
  }
  const now = () => (live ? live.currentTime : 0);

  function setReverb(v){
    if (!live) return;
    resources(live).wet.gain.setTargetAtTime(wetLevel(v), live.currentTime, 0.05);
  }

  // Отдельный узел громкости для дорожки
  function bus(c, gain){
    const g = c.createGain();
    g.gain.value = gain;
    g.connect(resources(c).input);
    return g;
  }

  /* ---------- кирпичики синтеза ---------- */
  function osc(c, type, freq, t, dest, gain, detune){
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    const g = c.createGain();
    g.gain.value = gain;
    o.connect(g);
    g.connect(dest);
    o.start(t);
    return o;
  }
  // Низкочастотный генератор, модулирует сразу несколько параметров (вибрато, тремоло)
  function lfo(c, rate, depth, t, params){
    const o = c.createOscillator();
    o.frequency.value = rate;
    const g = c.createGain();
    g.gain.value = depth;
    o.connect(g);
    params.forEach(p => g.connect(p));
    o.start(t);
    return { o, g };
  }
  function noise(c, r, t, dest, gain){
    const s = c.createBufferSource();
    s.buffer = r.noise;
    s.loop = true;
    const g = c.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(dest);
    s.start(t, Math.random() * 0.5);
    return { s, g };
  }
  function filter(c, type, freq, q, dest){
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q) f.Q.value = q;
    f.connect(dest);
    return f;
  }
  function decay(param, t, peak, len){
    param.setValueAtTime(peak, t);
    param.exponentialRampToValueAtTime(0.0001, t + len);
  }

  /* ---------- инструменты ----------
     Каждый строит голос в env и возвращает { os: источники, tau: скорость затухания после отпускания,
     life: когда голос замолкает сам (Infinity — звучит, пока держат), oneShot: не реагирует на отпускание } */
  const INST = {
    piano(c, f, t, env){
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(f * 9, 9000), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2, 500), t + 1.2);
      lp.connect(env);
      const os = [
        osc(c, 'triangle', f, t, lp, 0.6),
        osc(c, 'sine', f * 2, t, lp, 0.25),
        osc(c, 'sine', f * 3, t, lp, 0.08),
        osc(c, 'triangle', f, t, lp, 0.22, 6)
      ];
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.4, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.1, t + 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 6);
      return { os, tau: 0.12, life: 6.2 };
    },

    // Частотная модуляция: глубина модуляции спадает, тембр из звонкого становится мягким
    epiano(c, f, t, env){
      const car = c.createOscillator();
      car.frequency.setValueAtTime(f, t);
      const mod = c.createOscillator();
      mod.frequency.setValueAtTime(f, t);
      const depth = c.createGain();
      depth.gain.setValueAtTime(f * 1.6, t);
      depth.gain.exponentialRampToValueAtTime(f * 0.15 + 1, t + 1.5);
      mod.connect(depth);
      depth.connect(car.frequency);
      const cg = c.createGain();
      cg.gain.value = 0.7;
      car.connect(cg);
      cg.connect(env);
      car.start(t);
      mod.start(t);
      const tg = c.createGain();
      decay(tg.gain, t, 0.15, 0.25);
      tg.connect(env);
      const tine = osc(c, 'sine', f * 7, t, tg, 1);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.42, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.12, t + 1.4);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 5);
      return { os: [car, mod, tine], tau: 0.15, life: 5.1 };
    },

    // «Регистры» органа: набор синусов на гармониках плюс лёгкое тремоло
    organ(c, f, t, env){
      const trem = c.createGain();
      trem.gain.value = 0.9;
      trem.connect(env);
      const os = [[0.5, 0.22], [1, 0.36], [2, 0.26], [3, 0.12], [4, 0.1], [6, 0.05]]
        .filter(h => f * h[0] < 12000)
        .map(h => osc(c, 'sine', f * h[0], t, trem, h[1]));
      os.push(lfo(c, 5.6, 0.1, t, [trem.gain]).o);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.26, t + 0.012);
      return { os, tau: 0.04, life: Infinity };
    },

    strings(c, f, t, env){
      const lp = filter(c, 'lowpass', Math.min(f * 5, 5000), 0.6, env);
      const os = [-11, 0, 10].map(d => osc(c, 'sawtooth', f, t, lp, 0.16, d));
      os.push(lfo(c, 5.2, 7, t, os.map(o => o.detune)).o);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.32, t + 0.32);
      return { os, tau: 0.35, life: Infinity };
    },

    // Щипок: яркий фильтр быстро закрывается, плюс короткий шумовой «удар» по струне
    guitar(c, f, t, env, midi, r){
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(Math.min(f * 12, 12000), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, 250), t + 0.9);
      lp.connect(env);
      const os = [osc(c, 'sawtooth', f, t, lp, 0.32), osc(c, 'triangle', f * 2, t, lp, 0.12, 4)];
      const pick = noise(c, r, t, filter(c, 'bandpass', Math.min(f * 4, 8000), 1.2, env), 0);
      decay(pick.g.gain, t, 0.5, 0.04);
      os.push(pick.s);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      return { os, tau: 0.09, life: 3.1 };
    },

    marimba(c, f, t, env){
      const hg = c.createGain();
      decay(hg.gain, t, 0.3, 0.12);
      hg.connect(env);
      const os = [osc(c, 'sine', f, t, env, 0.7), osc(c, 'sine', f * 4, t, hg, 1)];
      const len = Math.max(0.4, 1.4 - f / 2000);   // высокие пластины звучат короче
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len);
      return { os, tau: 0.08, life: len + 0.05 };
    },

    bells(c, f, t, env){
      const os = [
        osc(c, 'sine', f, t, env, 0.6),
        osc(c, 'sine', f * 2.76, t, env, 0.25),
        osc(c, 'sine', f * 5.4, t, env, 0.12),
        osc(c, 'sine', f * 8.93, t, env, 0.05)
      ];
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.4, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
      return { os, tau: 0.5, life: 3.6 };
    },

    // Вибрато появляется не сразу, как у живого исполнителя; шум — это дыхание
    flute(c, f, t, env, midi, r){
      const os = [osc(c, 'sine', f, t, env, 0.55), osc(c, 'triangle', f, t, env, 0.1), osc(c, 'sine', f * 2, t, env, 0.06)];
      const vib = lfo(c, 5, 0, t, os.map(o => o.detune));
      vib.g.gain.setValueAtTime(0, t);
      vib.g.gain.linearRampToValueAtTime(14, t + 0.6);
      os.push(vib.o);
      const air = noise(c, r, t, filter(c, 'bandpass', Math.min(f * 2, 9000), 1.5, env), 0);
      air.g.gain.setValueAtTime(0.0001, t);
      air.g.gain.exponentialRampToValueAtTime(0.18, t + 0.04);
      air.g.gain.exponentialRampToValueAtTime(0.04, t + 0.3);
      os.push(air.s);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.3, t + 0.07);
      return { os, tau: 0.08, life: Infinity };
    },

    // Бас звучит на октаву ниже нажатой клавиши
    bass(c, f, t, env){
      const b = f / 2;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 7;
      lp.frequency.setValueAtTime(Math.min(b * 10, 6000), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(b * 2.5, 120), t + 0.25);
      lp.connect(env);
      const os = [osc(c, 'sawtooth', b, t, lp, 0.4), osc(c, 'square', b, t, lp, 0.18, -6), osc(c, 'sine', b, t, env, 0.35)];
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
      env.gain.exponentialRampToValueAtTime(0.28, t + 0.3);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 5);
      return { os, tau: 0.05, life: 5.1 };
    },

    chip(c, f, t, env){
      const os = [osc(c, 'square', f, t, env, 0.5)];
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.2, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.14, t + 0.18);
      return { os, tau: 0.03, life: Infinity };
    },

    pad(c, f, t, env){
      const lp = filter(c, 'lowpass', 1500, 0, env);
      const os = [
        osc(c, 'sawtooth', f, t, lp, 0.35, -8),
        osc(c, 'sawtooth', f, t, lp, 0.35, 8),
        osc(c, 'sine', f / 2, t, lp, 0.3)
      ];
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.28, t + 0.25);
      return { os, tau: 0.45, life: Infinity };
    },

    drums(c, f, t, env, midi, r){
      env.gain.setValueAtTime(0.75, t);
      const os = [];
      const life = KIT[pc(midi)](c, t, env, r, os);
      return { os, tau: 0.05, life, oneShot: true };
    }
  };

  /* ---------- ударная установка ---------- */
  // Тон с падающей высотой: бочка, томы
  function hit(c, t, dest, type, f0, f1, len, peak, os){
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.6);
    const g = c.createGain();
    decay(g.gain, t, peak, len);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    os.push(o);
  }
  // Отфильтрованный шум: малый, тарелки, шейкер
  function hiss(c, r, t, dest, type, freq, q, len, peak, os){
    const n = noise(c, r, t, filter(c, type, freq, q, dest), 0);
    decay(n.g.gain, t, peak, len);
    os.push(n.s);
    return n;
  }
  const KIT = [
    (c, t, d, r, os) => { hit(c, t, d, 'sine', 160, 42, 0.45, 1, os); hit(c, t, d, 'triangle', 600, 120, 0.03, 0.3, os); return 0.5; },
    (c, t, d, r, os) => { hit(c, t, d, 'triangle', 1700, 1500, 0.04, 0.35, os); hiss(c, r, t, d, 'highpass', 2500, 0.7, 0.03, 0.3, os); return 0.08; },
    (c, t, d, r, os) => { hit(c, t, d, 'triangle', 220, 160, 0.12, 0.45, os); hiss(c, r, t, d, 'highpass', 1300, 0.7, 0.2, 0.55, os); return 0.25; },
    (c, t, d, r, os) => {
      // хлопок — три быстрых шумовых всплеска подряд
      const g = hiss(c, r, t, d, 'bandpass', 1400, 1.2, 0.25, 0.8, os).g.gain;
      g.cancelScheduledValues(t);
      [0, 0.02, 0.04].forEach(o => { g.setValueAtTime(0.8, t + o); g.exponentialRampToValueAtTime(0.08, t + o + 0.012); });
      g.setValueAtTime(0.7, t + 0.045);
      g.exponentialRampToValueAtTime(0.0001, t + 0.25);
      return 0.28;
    },
    (c, t, d, r, os) => { hiss(c, r, t, d, 'highpass', 7500, 0.7, 0.06, 0.45, os); return 0.08; },
    (c, t, d, r, os) => { hit(c, t, d, 'sine', 130, 80, 0.45, 0.9, os); return 0.5; },
    (c, t, d, r, os) => { hiss(c, r, t, d, 'highpass', 7000, 0.7, 0.4, 0.4, os); return 0.45; },
    (c, t, d, r, os) => { hit(c, t, d, 'sine', 170, 105, 0.4, 0.9, os); return 0.45; },
    (c, t, d, r, os) => { hiss(c, r, t, d, 'bandpass', 5500, 1.5, 0.1, 0.4, os); return 0.12; },
    (c, t, d, r, os) => { hit(c, t, d, 'sine', 220, 140, 0.35, 0.9, os); return 0.4; },
    (c, t, d, r, os) => { hiss(c, r, t, d, 'highpass', 4500, 0.6, 1.6, 0.4, os); return 1.7; },
    (c, t, d, r, os) => {
      const bp = filter(c, 'bandpass', 800, 1.5, d);
      hit(c, t, bp, 'square', 545, 545, 0.35, 0.25, os);
      hit(c, t, bp, 'square', 815, 815, 0.35, 0.2, os);
      return 0.4;
    }
  ];

  /* ---------- голос ---------- */
  function stopAt(o, time){ try { o.stop(time); } catch (e) {} }

  function voice(c, dest, inst, midi, when){
    const r = resources(c);
    const t = Math.max(when === undefined ? 0 : when, c.currentTime);
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const rel = c.createGain();
    rel.connect(dest || r.input);
    const env = c.createGain();
    env.connect(rel);
    const b = (INST[inst] || INST.piano)(c, f, t, env, midi, r);
    const lifeEnd = t + b.life;
    if (isFinite(b.life)) b.os.forEach(o => stopAt(o, lifeEnd));
    // когда голос отзвучал, отцепляем его от шины, чтобы узлы не копились
    if (b.os[0]) b.os[0].onended = () => { try { rel.disconnect(); } catch (e) {} };
    let done = false;
    return {
      release(at){
        if (done) return;
        done = true;
        if (b.oneShot) return;
        const w = Math.max(at, c.currentTime);
        rel.gain.setTargetAtTime(0.0001, w, b.tau);
        const end = Math.min(w + b.tau * 8 + 0.05, lifeEnd);
        b.os.forEach(o => stopAt(o, end));
      },
      // мгновенно, но без щелчка
      kill(){
        done = true;
        const n = c.currentTime;
        rel.gain.cancelScheduledValues(n);
        rel.gain.setValueAtTime(rel.gain.value, n);
        rel.gain.setTargetAtTime(0.0001, n, 0.015);
        b.os.forEach(o => stopAt(o, n + 0.15));
      }
    };
  }

  function click(c, t, accent){
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1175;
    const g = c.createGain();
    decay(g.gain, t, accent ? 0.2 : 0.12, 0.045);
    o.connect(g);
    g.connect(resources(c).input);
    o.start(t);
    o.stop(t + 0.06);
  }

  /* ---------- офлайн-рендер для скачивания ---------- */
  function render(tracks, totalMs){
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error('OfflineAudioContext не поддерживается'));
    const sr = 44100;
    const oc = new OAC(2, Math.ceil(sr * (totalMs / 1000 + 3)), sr);
    tracks.forEach(tr => {
      const g = bus(oc, tr.vol);
      tr.events.forEach(ev => {
        const s = ev.t / 1000;
        voice(oc, g, tr.inst, ev.midi, s).release(s + ev.dur / 1000);
      });
    });
    return new Promise((resolve, reject) => {
      oc.oncomplete = e => resolve(e.renderedBuffer);
      const p = oc.startRendering();   // старый Safari возвращает undefined и шлёт oncomplete
      if (p && p.then) p.then(resolve, reject);
    });
  }

  K.audio = {
    INSTRUMENTS,
    has: id => !!byId[id],
    instName: id => (byId[id] ? byId[id].name : id),
    gm: id => (byId[id] && byId[id].gm >= 0 ? byId[id].gm : 0),
    drumName: midi => DRUMS[pc(midi)].name,
    drumGm: midi => DRUMS[pc(midi)].gm,
    ctx, now, voice, bus, click, setReverb, render
  };
})(window.Klav);
