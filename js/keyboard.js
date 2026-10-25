/* Экранная клавиатура и ввод: мышь, касания (мультитач и глиссандо), клавиатура компьютера, педаль */
(function (K) {
  'use strict';
  const { $, isBlack, noteName, hue, pc } = K.util;
  const S = K.state;

  // Привязка к физическим клавишам (event.code), поэтому раскладка языка не важна
  const KEYMAP = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23
  };
  const LABEL = {};
  Object.keys(KEYMAP).forEach(code => { LABEL[KEYMAP[code]] = code.replace('Key', '').replace('Digit', ''); });

  let stage, keysEl, fx, pedalBtn;
  const held = new Map();      // источник (палец, клавиша) → { midi, voice, ev }
  const sustained = [];        // отпущенные ноты, которые держит педаль
  let pedal = false;
  const keyEls = new Map();    // midi → элемент
  const lit = { active: new Map(), playing: new Map() };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const baseMidi = () => 12 * (S.octave + 1);   // октава 4 → до первой октавы = 60
  const wantedOctaves = () => (stage.clientWidth && stage.clientWidth < 560) ? 1 : 2;
  const keyLabel = midi => (S.inst === 'drums' ? K.audio.drumName(midi) + ', ' : '') + noteName(midi);

  // Облик инструмента на экране. Всё, что не указано, — обычные клавиши в своей расцветке (skin-*)
  const VIEW = { marimba: 'bars', bells: 'bars', flute: 'holes', guitar: 'strings', bass: 'strings', strings: 'strings', drums: 'pads' };
  const CAPTION = {
    strings: 'проведи пальцем по струнам',
    pads: 'каждая площадка — свой звук',
    bars: 'внизу белые ноты, вверху диезы',
    holes: 'внизу белые ноты, вверху диезы'
  };
  // Пэды ударных: сверху основа ритма, ниже тарелки, внизу томы
  const PAD_ORDER = [0, 2, 3, 1, 4, 6, 8, 10, 5, 7, 9, 11];
  const viewOf = inst => VIEW[inst] || 'keys';
  let view = 'keys';

  function makeKey(midi, cls, o){
    const k = document.createElement('div');
    k.className = 'key ' + cls;
    k.dataset.midi = String(midi);
    k.setAttribute('role', 'button');
    k.setAttribute('aria-label', keyLabel(midi));
    k.style.setProperty('--h', String(hue(midi)));
    if (LABEL[o] !== undefined){
      const s = document.createElement('span');
      s.className = 'lbl';
      s.textContent = LABEL[o];
      k.appendChild(s);
    }
    keyEls.set(midi, k);
    return k;
  }

  function caption(){
    const hint = CAPTION[view];
    $('stageCap').textContent = K.audio.instName(S.inst) + (hint ? ' · ' + hint : '');
  }

  function build(){
    S.octaves = wantedOctaves();
    view = viewOf(S.inst);
    keysEl.className = 'keys view-' + view + ' skin-' + S.inst;
    keysEl.textContent = '';
    keyEls.clear();
    lit.active.clear();
    lit.playing.clear();
    const base = baseMidi(), total = S.octaves * 12;
    const frag = document.createDocumentFragment();
    if (view === 'pads'){
      // у ударных одна октава звуков — 12 площадок
      PAD_ORDER.forEach(o => {
        const k = makeKey(base + o, 'pad', o);
        const name = document.createElement('span');
        name.className = 'pad-name';
        name.textContent = K.audio.drumName(base + o);
        k.insertBefore(name, k.firstChild);
        frag.appendChild(k);
      });
    } else {
      let whites = 0;
      for (let o = 0; o <= total; o++){
        const midi = base + o, black = isBlack(midi);
        const k = makeKey(midi, black ? 'black' : 'white', o);
        // --i: позиция чёрной клавиши, --j: номер по белым (длина пластин), --k: номер струны
        k.style.setProperty('--j', String(whites));
        k.style.setProperty('--k', String(o));
        if (black) k.style.setProperty('--i', String(whites)); else whites++;
        frag.appendChild(k);
      }
      keysEl.style.setProperty('--n', String(whites));
      keysEl.style.setProperty('--m', String(total + 1));
    }
    keysEl.appendChild(frag);
    caption();
  }

  // Сменили звучание: если облик другой — перестраиваем, иначе только расцветка и подписи
  function applyInst(){
    if (viewOf(S.inst) !== view){ releaseAll(); build(); return; }
    keysEl.className = 'keys view-' + view + ' skin-' + S.inst;
    keyEls.forEach((el, midi) => el.setAttribute('aria-label', keyLabel(midi)));
    caption();
  }

  // На пэдах любая октава попадает в свою площадку
  const elFor = midi => keyEls.get(midi) || (view === 'pads' ? keyEls.get(baseMidi() + pc(midi)) : undefined);

  function light(midi, kind, on){
    const m = lit[kind];
    const n = (m.get(midi) || 0) + (on ? 1 : -1);
    if (n <= 0) m.delete(midi); else m.set(midi, n);
    const el = elFor(midi);
    if (el) el.classList.toggle(kind, n > 0);
  }
  function clearLights(kind){
    lit[kind].clear();
    keyEls.forEach(el => el.classList.remove(kind));
  }

  function burst(midi){
    if (reduceMotion) return;
    const el = elFor(midi);
    if (!el) return;
    const sr = stage.getBoundingClientRect(), kr = el.getBoundingClientRect();
    const x = kr.left - sr.left + kr.width / 2, y = kr.top - sr.top;
    for (let i = 0; i < 3; i++){
      if (fx.childElementCount > 60) break;
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.left = (x + (Math.random() * 16 - 8)) + 'px';
      d.style.top = y + 'px';
      d.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px');
      d.style.setProperty('--hue', String(hue(midi)));
      fx.appendChild(d);
      setTimeout(() => d.remove(), 1100);
    }
  }

  /* ---------- живая игра ---------- */
  function finish(h){
    if (h.voice) h.voice.release(K.audio.now());
    if (h.ev) K.recorder.finish(h.ev);
  }

  function noteOn(id, midi){
    if (held.has(id)) return;
    // та же нота ещё тянется на педали — гасим её, чтобы голоса не копились
    for (let i = sustained.length - 1; i >= 0; i--){
      if (sustained[i].midi === midi) finish(sustained.splice(i, 1)[0]);
    }
    const c = K.audio.ctx();
    const voice = c ? K.audio.voice(c, null, S.inst, midi) : null;
    const ev = K.recorder.capture(midi);
    held.set(id, { midi, voice, ev });
    light(midi, 'active', true);
    burst(midi);
  }
  function noteOff(id){
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    light(h.midi, 'active', false);
    if (pedal) sustained.push(h); else finish(h);
  }

  function setPedal(on){
    if (pedal === on) return;
    pedal = on;
    if (!on) while (sustained.length) finish(sustained.shift());
    pedalBtn.classList.toggle('on', on);
    pedalBtn.setAttribute('aria-pressed', String(on));
  }

  function releaseAll(){
    Array.from(held.keys()).forEach(noteOff);
    setPedal(false);
  }

  const isTyping = el => { const tag = el && el.tagName; return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'; };

  function init(){
    stage = $('stage');
    keysEl = $('keys');
    fx = $('fx');
    pedalBtn = $('pedal');

    keysEl.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const k = e.target.closest && e.target.closest('.key');
      if (!k) return;
      e.preventDefault();
      noteOn('p' + e.pointerId, Number(k.dataset.midi));
    });
    // глиссандо: палец уехал на соседнюю клавишу
    keysEl.addEventListener('pointermove', e => {
      const id = 'p' + e.pointerId, h = held.get(id);
      if (!h) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const k = under && under.closest ? under.closest('.key') : null;
      if (k && Number(k.dataset.midi) !== h.midi){
        noteOff(id);
        noteOn(id, Number(k.dataset.midi));
      }
    });
    keysEl.addEventListener('contextmenu', e => e.preventDefault());
    const pointerEnd = e => noteOff('p' + e.pointerId);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    // ноты не должны зависать, если окно потеряло фокус или вкладку свернули
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.code === 'Space'){
        e.preventDefault();
        if (!e.repeat) setPedal(true);
        return;
      }
      const off = KEYMAP[e.code];
      if (e.repeat){ if (off !== undefined) e.preventDefault(); return; }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract'){ K.ui.changeOctave(-1); return; }
      if (e.code === 'Equal' || e.code === 'NumpadAdd'){ K.ui.changeOctave(1); return; }
      if (off === undefined) return;
      e.preventDefault();
      noteOn('k' + e.code, baseMidi() + off);
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space' && !isTyping(e.target)){ e.preventDefault(); setPedal(false); return; }
      if (KEYMAP[e.code] !== undefined) noteOff('k' + e.code);
    });

    // Педаль на экране: держать пальцем. С клавиатуры (Enter) — переключатель
    pedalBtn.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { pedalBtn.setPointerCapture(e.pointerId); } catch (err) {}
      setPedal(true);
    });
    pedalBtn.addEventListener('pointerup', () => setPedal(false));
    pedalBtn.addEventListener('pointercancel', () => setPedal(false));
    pedalBtn.addEventListener('contextmenu', e => e.preventDefault());
    pedalBtn.addEventListener('click', e => { if (e.detail === 0) setPedal(!pedal); });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (wantedOctaves() !== S.octaves){ releaseAll(); build(); }
      }, 150);
    });

    build();
  }

  K.keyboard = { init, build, applyInst, light, clearLights, burst, releaseAll, baseMidi };
})(window.Klav);
