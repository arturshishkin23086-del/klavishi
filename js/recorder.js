/* Дорожки: запись, воспроизведение, метроном, хранение.
   Воспроизведение идёт через планировщик с упреждением: раз в 25 мс ставим в очередь аудиоконтекста
   ноты на ближайшие 0,2 с. Так «Повтор» склеивается без паузы, а длинные записи не создают
   тысячи узлов разом. */
(function (K) {
  'use strict';
  const S = K.state;
  const { clamp } = K.util;
  const KEY = 'klavishi:v2', OLD_KEY = 'klavishi:v1';
  let seq = 0;

  function makeTrack(inst, events, vol, muted){
    return {
      id: ++seq,
      inst: K.audio.has(inst) ? inst : 'piano',
      vol: vol === undefined ? 0.9 : vol,
      muted: !!muted,
      events
    };
  }
  const trackDur = tr => tr.events.reduce((m, e) => Math.max(m, e.t + (e.dur || 0)), 0);
  const songDur = () => S.tracks.reduce((m, tr) => Math.max(m, trackDur(tr)), 0);
  const hasNotes = () => S.tracks.some(tr => tr.events.length);

  /* ---------- запись ---------- */
  let recEvents = [], recStart = 0, recLatency = 0, recAligned = false, recTimer = 0;

  // Время от начала записи. При наложении вычитаем задержку вывода звука:
  // человек нажимает в такт тому, что слышит, а слышит он с опозданием
  const recNow = () => performance.now() - recStart - recLatency;
  const recElapsed = () => (S.recording ? recNow() : 0);

  function capture(midi){
    if (!S.recording) return null;
    const t = recNow();
    if (t < -250) return null;          // нажали во время отсчёта — не пишем
    const ev = { midi, t: Math.max(0, t), dur: null };
    recEvents.push(ev);
    K.ui.renderStatus();
    return ev;
  }
  function finish(ev){
    if (ev.dur !== null) return;        // уже закрыта при остановке записи
    ev.dur = Math.max(30, recNow() - ev.t);
  }

  function startRecording(){
    if (S.tracks.length >= K.MAX_TRACKS){
      K.ui.toast('Уже ' + K.MAX_TRACKS + ' дорожек. Удали одну, чтобы записать новую.');
      return;
    }
    stopPlayback('silent');
    const c = K.audio.ctx();
    if (!c){ K.ui.toast('Этот браузер не умеет синтезировать звук.'); return; }
    recEvents = [];
    const backing = S.tracks.some(tr => !tr.muted && tr.events.length);
    // с метрономом или поверх других дорожек время не обрезаем, иначе потеряется сетка
    recAligned = backing || S.metronome;
    S.recording = true;
    if (recAligned){
      recLatency = (c.outputLatency || c.baseLatency || 0) * 1000;
      const startAt = startPlayer({ recording: true, countIn: S.metronome });
      recStart = performance.now() + (startAt - c.currentTime) * 1000;
    } else {
      recLatency = 0;
      recStart = performance.now();
    }
    recTimer = setInterval(() => K.ui.tick(), 250);
    K.ui.render();
  }

  function stopRecording(){
    if (!S.recording) return;
    const end = recNow();
    S.recording = false;
    clearInterval(recTimer);
    recEvents.forEach(e => { if (e.dur === null) e.dur = Math.max(30, end - e.t); });
    const events = recEvents;
    recEvents = [];
    stopPlayback('silent');
    if (!recAligned && events.length){
      const off = Math.min.apply(null, events.map(e => e.t));   // тишина до первой ноты
      events.forEach(e => { e.t -= off; });
    }
    events.forEach(e => { e.t = Math.round(e.t); e.dur = Math.round(e.dur); });
    if (events.length){
      S.tracks.push(makeTrack(S.inst, events));
      K.ui.toast('Дорожка ' + S.tracks.length + ' записана.');
      save(true);
    } else {
      K.ui.toast('Ничего не записано.');
    }
    K.ui.render();
  }

  /* ---------- воспроизведение ---------- */
  const P = {
    active: false, recording: false, c: null, timer: 0, raf: 0,
    list: [], idx: 0, iter: 0, L: 0, total: 0, startAt: 0, ended: true, endAt: 0,
    beat: 0, beatSec: 0.6, voices: [], timeouts: new Set(), buses: new Map()
  };

  // Длина круга для «Повтора». С метрономом — целое число тактов, чтобы круг попадал в долю
  function loopLength(total){
    if (!total) return 0;
    if (!S.metronome) return total + 300;
    const bar = 4 * 60000 / S.bpm;
    const lastStart = S.tracks.reduce((m, tr) => tr.events.reduce((mm, e) => Math.max(mm, e.t), m), 0);
    let L = Math.max(1, Math.ceil((total - bar * 0.2) / bar)) * bar;
    while (L <= lastStart) L += bar;
    return L;
  }

  function startPlayer(opts){
    stopPlayback('silent');
    const c = K.audio.ctx();
    P.c = c;
    P.recording = !!opts.recording;
    P.list = [];
    S.tracks.forEach(tr => {
      P.buses.set(tr.id, K.audio.bus(c, tr.muted ? 0 : tr.vol));
      tr.events.forEach(ev => P.list.push({ ev, tr }));
    });
    P.list.sort((a, b) => a.ev.t - b.ev.t);
    P.total = songDur();
    P.L = loopLength(P.total);
    P.beatSec = 60 / S.bpm;
    const countBeats = opts.countIn ? 4 : 0;
    P.startAt = c.currentTime + 0.12 + countBeats * P.beatSec;
    P.idx = 0;
    P.iter = 0;
    P.ended = P.list.length === 0;
    P.endAt = P.startAt + P.total / 1000;
    P.beat = -countBeats;
    P.active = true;
    P.timer = setInterval(tick, 25);
    tick();
    P.raf = requestAnimationFrame(frame);
    return P.startAt;
  }

  function later(fn, ms){
    const id = setTimeout(() => { P.timeouts.delete(id); fn(); }, Math.max(0, ms));
    P.timeouts.add(id);
  }

  function scheduleNote(item, at){
    const ev = item.ev, tr = item.tr;
    if (tr.muted) return;
    const end = at + ev.dur / 1000;
    const v = K.audio.voice(P.c, P.buses.get(tr.id), tr.inst, ev.midi, at);
    v.release(end);
    P.voices.push({ v, end });
    const d = (at - P.c.currentTime) * 1000;
    later(() => { K.keyboard.light(ev.midi, 'playing', true); K.keyboard.burst(ev.midi); }, d);
    later(() => K.keyboard.light(ev.midi, 'playing', false), d + ev.dur);
  }

  function tick(){
    const c = P.c, now = c.currentTime;
    // в фоновой вкладке таймеры тормозят до 1 раза в секунду — планируем дальше вперёд
    const horizon = now + (document.hidden ? 1.5 : 0.2);
    while (!P.ended){
      const item = P.list[P.idx];
      const at = P.startAt + (P.iter * P.L + item.ev.t) / 1000;
      if (at > horizon) break;
      scheduleNote(item, at);
      if (++P.idx >= P.list.length){
        if (S.loop && !P.recording){ P.idx = 0; P.iter++; }
        else { P.ended = true; P.endAt = P.startAt + (P.iter * P.L + P.total) / 1000; }
      }
    }
    // доли метронома идут всегда, а щёлкают только когда он включён или идёт отсчёт
    let bt;
    while ((bt = P.startAt + P.beat * P.beatSec) <= horizon){
      if (bt >= now - 0.01 && (S.metronome || P.beat < 0)) K.audio.click(c, bt, ((P.beat % 4) + 4) % 4 === 0);
      P.beat++;
    }
    if (P.voices.length > 64) P.voices = P.voices.filter(x => x.end + 4 > now);
    if (P.ended && !P.recording && now > P.endAt + 0.3) stopPlayback('soft');
  }

  function frame(){
    if (!P.active) return;
    let ms = (P.c.currentTime - P.startAt) * 1000;
    if (!P.recording && P.L) ms %= P.L;
    K.ui.playhead(ms);
    P.raf = requestAnimationFrame(frame);
  }

  // mode: 'soft' — дать нотам доиграть, 'silent' — без перерисовки интерфейса
  function stopPlayback(mode){
    if (P.active){
      P.active = false;
      clearInterval(P.timer);
      cancelAnimationFrame(P.raf);
      P.timeouts.forEach(clearTimeout);
      P.timeouts.clear();
      if (mode !== 'soft') P.voices.forEach(x => x.v.kill());
      P.voices = [];
      const buses = Array.from(P.buses.values());
      P.buses.clear();
      setTimeout(() => buses.forEach(b => { try { b.disconnect(); } catch (e) {} }), mode === 'soft' ? 6000 : 300);
      K.keyboard.clearLights('playing');
      K.ui.playhead(null);
    }
    S.playing = false;
    if (mode !== 'silent') K.ui.render();
  }

  function startPlayback(){
    if (S.recording || !hasNotes() || !K.audio.ctx()) return;
    startPlayer({});
    S.playing = true;
    K.ui.render();
  }

  /* ---------- операции с дорожками ---------- */
  function setBusGain(tr){
    const b = P.buses.get(tr.id);
    if (b && P.c) b.gain.setTargetAtTime(tr.muted ? 0 : tr.vol, P.c.currentTime, 0.02);
  }

  // quiet — без сохранения и перерисовки (ползунок громкости во время движения)
  function trackOp(id, op, val, quiet){
    const i = S.tracks.findIndex(t => t.id === id);
    if (i < 0) return null;
    const tr = S.tracks[i];
    let result = null;
    if (op === 'inst' && K.audio.has(val)) tr.inst = val;
    else if (op === 'mute'){ tr.muted = !tr.muted; setBusGain(tr); }
    else if (op === 'vol'){ tr.vol = clamp(val, 0, 1); setBusGain(tr); }
    else if (op === 'remove'){
      if (S.playing) stopPlayback('silent');
      S.tracks.splice(i, 1);
      result = { track: tr, index: i };
    }
    if (!quiet){ save(true); K.ui.render(); }
    return result;
  }

  function restoreTrack(r){
    if (!r || S.tracks.length >= K.MAX_TRACKS) return;
    S.tracks.splice(Math.min(r.index, S.tracks.length), 0, r.track);
    save(true);
    K.ui.render();
  }

  function clearAll(){
    stopPlayback('silent');
    S.tracks = [];
    save(true);
    K.ui.render();
  }

  /* ---------- хранение (только в этом браузере) ---------- */
  function serialize(tracks){
    return tracks.map(tr => ({
      inst: tr.inst, vol: Math.round(tr.vol * 100) / 100, muted: tr.muted,
      events: tr.events.map(e => [e.midi, Math.round(e.t), Math.round(e.dur)])
    }));
  }

  function save(tracksChanged){
    if (tracksChanged && S.fromLink){
      // мелодию из ссылки начали менять — теперь она своя, ссылку из адреса убираем
      S.fromLink = false;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
    try {
      let tracks;
      if (S.fromLink){
        // пока чужая мелодия не менялась, свои сохранённые дорожки не трогаем
        const old = JSON.parse(localStorage.getItem(KEY) || 'null');
        tracks = old && Array.isArray(old.tracks) ? old.tracks : [];
      } else {
        tracks = serialize(S.tracks);
      }
      localStorage.setItem(KEY, JSON.stringify({
        v: 2, inst: S.inst, octave: S.octave, loop: S.loop, metronome: S.metronome,
        bpm: S.bpm, reverb: S.reverb, tracks
      }));
    } catch (e) {}
  }

  function parseEvents(arr){
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) && a[0] >= 0 && a[0] <= 127 && a[1] >= 0)
      .map(a => ({ midi: a[0], t: a[1], dur: Math.max(30, a[2]) }));
  }
  function applyPrefs(d){
    if (typeof d.inst === 'string' && K.audio.has(d.inst)) S.inst = d.inst;
    if (Number.isInteger(d.octave) && d.octave >= 2 && d.octave <= 6) S.octave = d.octave;
    if (typeof d.loop === 'boolean') S.loop = d.loop;
    if (typeof d.metronome === 'boolean') S.metronome = d.metronome;
    if (Number.isFinite(d.bpm)) S.bpm = clamp(Math.round(d.bpm), 40, 240);
    if (Number.isFinite(d.reverb)) S.reverb = clamp(d.reverb, 0, 1);
  }

  function load(){
    try {
      const raw = localStorage.getItem(KEY);
      if (raw){
        const d = JSON.parse(raw) || {};
        applyPrefs(d);
        if (Array.isArray(d.tracks)){
          S.tracks = d.tracks.slice(0, K.MAX_TRACKS)
            .filter(tr => tr && typeof tr === 'object')
            .map(tr => makeTrack(tr.inst, parseEvents(tr.events), Number.isFinite(tr.vol) ? clamp(tr.vol, 0, 1) : 0.9, tr.muted))
            .filter(tr => tr.events.length);
        }
        return;
      }
      // формат прототипа: одна запись становится первой дорожкой
      const old = localStorage.getItem(OLD_KEY);
      if (old){
        const d = JSON.parse(old) || {};
        applyPrefs(d);
        const events = parseEvents(d.events);
        if (events.length) S.tracks = [makeTrack(S.inst, events)];
      }
    } catch (e) {}
  }

  function loadFromHash(){
    const code = location.hash.replace(/^#/, '');
    return code ? loadCode(code) : false;
  }

  function loadCode(code){
    const d = K.share.decode(code);
    if (!d){
      K.ui.toast('Ссылку не удалось прочитать: возможно, она обрезана.');
      return false;
    }
    if (S.recording) stopRecording();
    stopPlayback('silent');
    S.octave = d.octave;
    S.tracks = d.tracks.map(tr => makeTrack(tr.inst, tr.events, tr.vol));
    if (S.tracks.length) S.inst = S.tracks[0].inst;
    S.fromLink = true;
    K.ui.toast('Мелодия из ссылки загружена. Нажми «Играть».');
    return true;
  }

  K.recorder = {
    capture, finish, recElapsed, songDur, trackDur, hasNotes,
    liveEvents: () => recEvents,
    toggleRecording: () => (S.recording ? stopRecording() : startRecording()),
    togglePlayback: () => (S.playing ? stopPlayback() : startPlayback()),
    stopPlayback, trackOp, restoreTrack, clearAll,
    save, load, loadFromHash, loadCode
  };
})(window.Klav);
