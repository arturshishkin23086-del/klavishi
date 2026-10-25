/* Интерфейс: кнопки, статус, список дорожек с мини-роликом нот, уведомления, тема */
(function (K) {
  'use strict';
  const { $, fmt, notesWord, tracksWord, hue, clamp } = K.util;
  const S = K.state;

  const svg = d => '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' + d + '</svg>';
  const ST = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const ICON = {
    rec:   svg('<circle cx="12" cy="12" r="7" fill="currentColor"/>'),
    stop:  svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
    play:  svg('<path d="M8 5v14l11-7z" fill="currentColor"/>'),
    loop:  svg('<path d="M7 7h9a3 3 0 0 1 3 3v1M17 17H8a3 3 0 0 1-3-3v-1M15 4l3 3-3 3M9 20l-3-3 3-3" ' + ST + '/>'),
    metro: svg('<path d="M9 3h6l4 18H5zM8 16h8M12 16l5-9" ' + ST + '/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" ' + ST + '/>'),
    link:  svg('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" ' + ST + '/>'),
    down:  svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14" ' + ST + '/>'),
    sound: svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" ' + ST + '/>'),
    muted: svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" ' + ST + '/>'),
    auto:  svg('<circle cx="12" cy="12" r="8" ' + ST + '/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
    light: svg('<circle cx="12" cy="12" r="4" ' + ST + '/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" ' + ST + '/>'),
    dark:  svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" ' + ST + '/>')
  };
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };

  let els = null, toastTimer = 0, trackSig = '', laneScale = 1000, clearTimer = 0;
  // Страница открыта внутри рамки: там нельзя скачивать файлы и вызывать системное меню «Поделиться»
  const FRAMED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const shown = new WeakMap();   // кнопка → последняя разметка, чтобы не перерисовывать зря

  function setHTML(el, html){
    if (shown.get(el) === html) return;
    shown.set(el, html);
    el.innerHTML = html;
  }
  const setBtn = (b, icon, label) => setHTML(b, icon + '<span>' + label + '</span>');

  /* ---------- статус ---------- */
  function statusText(){
    if (S.recording){
      const ms = K.recorder.recElapsed();
      if (ms < 0) return 'Отсчёт: ' + Math.ceil(-ms / (60000 / S.bpm)) + '…';
      return 'Идёт запись дорожки ' + (S.tracks.length + 1) + ': ' + fmt(ms) + ', ' + notesWord(K.recorder.liveEvents().length);
    }
    const n = S.tracks.length;
    if (!n) return 'Дорожек пока нет. Нажми «Запись» и играй.';
    const on = S.tracks.filter(t => !t.muted).length;
    const total = fmt(K.recorder.songDur());
    if (S.playing) return 'Играет: ' + tracksWord(on) + (S.loop ? ' по кругу' : '') + ', ' + total;
    return tracksWord(n) + ', ' + total + (on < n ? ' (без звука: ' + (n - on) + ')' : '');
  }
  function renderStatus(){
    const t = statusText();
    if (els.status.textContent !== t) els.status.textContent = t;
  }

  /* ---------- дорожки ---------- */
  function trackEl(tr){
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = String(tr.id);
    const opts = K.audio.INSTRUMENTS.map(i => '<option value="' + i.id + '">' + i.name + '</option>').join('');
    li.innerHTML =
      '<div class="track-top"><span class="track-name"></span><span class="track-meta"></span></div>' +
      '<div class="lane"><canvas></canvas></div>' +
      '<div class="track-ctrl">' +
        '<select class="sel">' + opts + '</select>' +
        '<button type="button" class="icon-btn mute"></button>' +
        '<input type="range" class="vol" min="0" max="100" step="1">' +
        '<button type="button" class="icon-btn del">' + ICON.trash + '</button>' +
      '</div>';
    return li;
  }
  function recEl(){
    const li = document.createElement('li');
    li.className = 'track recording';
    li.dataset.id = 'rec';
    li.innerHTML = '<div class="track-top"><span class="track-name"></span><span class="track-meta"></span></div><div class="lane"><canvas></canvas></div>';
    return li;
  }

  // Мини-ролик: время по горизонтали, высота нот по вертикали, цвет — как у клавиши
  function drawLane(cv, events, liveNow){
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H){ cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!events.length) return;
    let lo = 127, hi = 0;
    events.forEach(e => { if (e.midi < lo) lo = e.midi; if (e.midi > hi) hi = e.midi; });
    const pad = Math.max(0, 12 - (hi - lo)) / 2;
    lo -= Math.floor(pad);
    hi += Math.ceil(pad);
    const rh = (h - 6) / (hi - lo + 1);
    events.forEach(e => {
      const d = e.dur === null ? Math.max(30, liveNow - e.t) : e.dur;
      g.fillStyle = 'hsl(' + hue(e.midi) + ' 80% 58%)';
      g.fillRect(e.t / laneScale * w, 3 + (hi - e.midi) * rh, Math.max(2, d / laneScale * w), Math.max(2, rh - 1));
    });
  }

  function updateTrackEl(li){
    const name = li.querySelector('.track-name'), meta = li.querySelector('.track-meta');
    const cv = li.querySelector('canvas');
    if (li.dataset.id === 'rec'){
      const evs = K.recorder.liveEvents();
      li.style.setProperty('--h', String(K.TRACK_HUES[S.tracks.length % K.TRACK_HUES.length]));
      name.textContent = 'Дорожка ' + (S.tracks.length + 1);
      meta.textContent = 'запись · ' + K.audio.instName(S.inst) + ' · ' + notesWord(evs.length);
      drawLane(cv, evs, K.recorder.recElapsed());
      return;
    }
    const i = S.tracks.findIndex(t => String(t.id) === li.dataset.id);
    const tr = S.tracks[i];
    if (!tr) return;
    const n = i + 1;
    li.style.setProperty('--h', String(K.TRACK_HUES[i % K.TRACK_HUES.length]));
    li.classList.toggle('muted', tr.muted);
    name.textContent = 'Дорожка ' + n;
    meta.textContent = notesWord(tr.events.length) + ' · ' + fmt(K.recorder.trackDur(tr));

    const sel = li.querySelector('.sel');
    if (sel.value !== tr.inst) sel.value = tr.inst;
    sel.setAttribute('aria-label', 'Звучание дорожки ' + n);
    sel.disabled = S.recording;

    const mute = li.querySelector('.mute');
    setHTML(mute, tr.muted ? ICON.muted : ICON.sound);
    mute.classList.toggle('on', tr.muted);
    mute.setAttribute('aria-pressed', String(tr.muted));
    mute.setAttribute('aria-label', 'Без звука: дорожка ' + n);
    mute.title = tr.muted ? 'Включить звук' : 'Выключить звук';

    const vol = li.querySelector('.vol');
    if (document.activeElement !== vol) vol.value = String(Math.round(tr.vol * 100));
    vol.setAttribute('aria-label', 'Громкость дорожки ' + n);

    const del = li.querySelector('.del');
    del.setAttribute('aria-label', 'Удалить дорожку ' + n);
    del.title = 'Удалить';
    del.disabled = S.recording;

    drawLane(cv, tr.events, 0);
  }

  function renderTracks(){
    const list = els.tracks;
    const sig = S.tracks.map(t => t.id).join(',') + (S.recording ? '|rec' : '');
    if (sig !== trackSig){
      trackSig = sig;
      // после перестройки списка возвращаем фокус туда, где он был
      const ae = document.activeElement, li = ae && ae.closest ? ae.closest('.track') : null;
      const keep = li ? { id: li.dataset.id, cls: ae.classList[ae.classList.length - 1] } : null;
      list.textContent = '';
      S.tracks.forEach(tr => list.appendChild(trackEl(tr)));
      if (S.recording) list.appendChild(recEl());
      if (keep){
        const back = list.querySelector('[data-id="' + keep.id + '"] .' + keep.cls);
        if (back) back.focus();
      }
    }
    laneScale = Math.max(1000, K.recorder.songDur(), K.recorder.recElapsed());
    Array.from(list.children).forEach(updateTrackEl);
    els.empty.hidden = S.tracks.length > 0 || S.recording;
    els.trackCount.textContent = S.tracks.length ? S.tracks.length + ' из ' + K.MAX_TRACKS : '';
  }

  function playhead(ms){
    if (!els) return;
    if (ms === null){ els.tracks.classList.remove('ph'); return; }
    els.tracks.classList.add('ph');
    els.tracks.style.setProperty('--ph', clamp(ms / laneScale, 0, 1).toFixed(4));
  }

  /* ---------- общий рендер ---------- */
  function render(){
    const has = K.recorder.hasNotes();
    const full = S.tracks.length >= K.MAX_TRACKS;

    setBtn(els.rec, S.recording ? ICON.stop : ICON.rec, S.recording ? 'Стоп' : 'Запись');
    els.rec.classList.toggle('on', S.recording);
    els.rec.disabled = !S.recording && full;
    els.rec.title = S.tracks.length && !S.recording ? 'Записать новую дорожку поверх' : '';

    setBtn(els.play, S.playing ? ICON.stop : ICON.play, S.playing ? 'Стоп' : 'Играть');
    els.play.classList.toggle('on', S.playing);
    els.play.disabled = !has || S.recording;

    setBtn(els.loop, ICON.loop, 'Повтор');
    els.loop.classList.toggle('on', S.loop);
    els.loop.setAttribute('aria-pressed', String(S.loop));

    setBtn(els.metro, ICON.metro, 'Метроном');
    els.metro.classList.toggle('on', S.metronome);
    els.metro.setAttribute('aria-pressed', String(S.metronome));

    els.octLabel.textContent = 'Октава ' + S.octave;
    els.octDown.disabled = S.octave <= 2;
    els.octUp.disabled = S.octave >= 6;
    setHTML(els.bpmLabel, S.bpm + '<span class="unit"> уд/мин</span>');
    els.bpmLabel.title = 'Темп: ' + S.bpm + ' ударов в минуту';
    els.bpmDown.disabled = S.bpm <= 40;
    els.bpmUp.disabled = S.bpm >= 240;
    if (document.activeElement !== els.reverb) els.reverb.value = String(Math.round(S.reverb * 100));

    els.instBtns.forEach(b => {
      const on = b.dataset.inst === S.inst;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });

    setBtn(els.share, ICON.link, 'Поделиться');
    setBtn(els.wav, ICON.down, 'Скачать WAV');
    setBtn(els.midi, ICON.down, 'Скачать MIDI');
    [els.share, els.wav, els.midi].forEach(b => { b.disabled = !has || S.recording || b.dataset.busy === '1'; });
    els.clearAll.disabled = !S.tracks.length || S.recording;
    // в рамке и во встроенном браузере Telegram скачивание файлов не работает
    const noFiles = FRAMED || K.tg.active;
    els.wav.hidden = noFiles;
    els.midi.hidden = noFiles;
    els.exportNote.textContent = noFiles
      ? 'Скачать WAV и MIDI можно в обычном браузере. ' + els.exportNoteText
      : els.exportNoteText;

    renderStatus();
    renderTracks();
  }

  // во время записи: статус и растущий ролик
  function tick(){
    renderStatus();
    renderTracks();
  }

  /* ---------- уведомления ---------- */
  function hideToast(){ els.toast.classList.remove('show'); }
  function toast(msg, action){
    if (!els) return;
    clearTimeout(toastTimer);
    els.toast.textContent = '';
    const span = document.createElement('span');
    span.textContent = msg;
    els.toast.appendChild(span);
    if (action){
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-btn';
      b.textContent = action.label;
      b.addEventListener('click', () => { hideToast(); action.run(); });
      els.toast.appendChild(b);
    }
    els.toast.classList.add('show');
    toastTimer = setTimeout(hideToast, action ? 6000 : 3200);
  }

  /* ---------- действия ---------- */
  function selectInst(id){
    if (!K.audio.has(id)) return;
    S.inst = id;
    K.recorder.save();
    K.keyboard.applyInst();
    render();
    const c = K.audio.ctx();
    if (c){
      const v = K.audio.voice(c, null, id, K.keyboard.baseMidi() + (id === 'drums' ? 0 : 7));
      v.release(c.currentTime + 0.4);
    }
  }

  function changeOctave(d){
    const next = S.octave + d;
    if (next < 2 || next > 6) return;
    K.keyboard.releaseAll();
    S.octave = next;
    K.keyboard.build();
    K.recorder.save();
    render();
  }

  function changeBpm(d){
    S.bpm = clamp(S.bpm + d, 40, 240);
    K.recorder.save();
    render();
  }

  async function copy(text){
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    // запасной путь для file:// и старых браузеров
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  async function share(){
    const res = K.share.encode();
    if (res.error){ toast(res.error); return; }
    // внутри чужой рамки (например, опубликованной страницы) свой адрес не тот, что видит человек
    const meta = document.querySelector('meta[name="klavishi:share-base"]');
    // только адрес страницы: без служебных параметров Telegram и прочего хвоста
    const base = (meta && meta.content) || location.href.split(/[?#]/)[0];
    const url = (K.tg.active && K.tg.appLink(res.code)) || base + '#' + res.code;
    // ссылку показываем всегда: если буфер обмена недоступен, её можно выделить вручную
    els.shareLink.value = url;
    els.shareLink.hidden = false;
    if (K.tg.active){ K.tg.share(url); return; }
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!FRAMED && coarse && navigator.share){
      try { await navigator.share({ title: 'Мелодия из «Клавиш»', url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    if (await copy(url)) toast('Ссылка скопирована. Отправь её кому хочешь.');
    else {
      els.shareLink.focus();
      els.shareLink.select();
      toast('Скопируй ссылку из поля под кнопками.');
    }
  }

  const fileName = ext => 'klavishi-' + new Date().toISOString().slice(0, 10) + '.' + ext;

  async function exportWav(){
    els.wav.dataset.busy = '1';
    render();
    toast('Готовлю WAV…');
    try {
      K.exporter.download(await K.exporter.wav(), fileName('wav'));
      toast('WAV готов.');
    } catch (e) {
      toast('Не получилось собрать WAV в этом браузере.');
    }
    els.wav.dataset.busy = '';
    render();
  }

  function exportMidi(){
    try {
      K.exporter.download(K.exporter.midi(), fileName('mid'));
      toast('MIDI готов. Его можно открыть в любом нотном редакторе или DAW.');
    } catch (e) {
      toast('Не получилось собрать MIDI.');
    }
  }

  function disarmClear(){
    els.clearAll.dataset.armed = '';
    els.clearAll.classList.remove('danger');
    els.clearAll.textContent = 'Очистить всё';
  }

  function applyTheme(mode){
    if (mode === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    setHTML(els.theme, ICON[mode]);
    els.theme.setAttribute('aria-label', THEME_LABEL[mode]);
    els.theme.title = THEME_LABEL[mode];
    els.theme.dataset.mode = mode;
  }

  function init(){
    els = {};
    ['rec', 'play', 'loop', 'metro', 'status', 'inst', 'octDown', 'octUp', 'octLabel', 'bpmDown', 'bpmUp', 'bpmLabel',
     'reverb', 'tracks', 'empty', 'trackCount', 'clearAll', 'share', 'wav', 'midi', 'toast', 'theme',
     'shareLink', 'exportNote']
      .forEach(id => { els[id] = $(id); });

    K.audio.INSTRUMENTS.forEach(i => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.inst = i.id;
      b.textContent = i.name;
      els.inst.appendChild(b);
    });
    els.instBtns = Array.from(els.inst.querySelectorAll('button'));
    els.inst.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) selectInst(b.dataset.inst);
    });
    // стрелки внутри группы звучаний, как у обычных радиокнопок
    els.inst.addEventListener('keydown', e => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const ids = K.audio.INSTRUMENTS.map(i => i.id);
      const next = ids[(ids.indexOf(S.inst) + dir + ids.length) % ids.length];
      selectInst(next);
      const b = els.instBtns.find(x => x.dataset.inst === next);
      b.focus();
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    els.rec.addEventListener('click', () => K.recorder.toggleRecording());
    els.play.addEventListener('click', () => K.recorder.togglePlayback());
    els.loop.addEventListener('click', () => { S.loop = !S.loop; K.recorder.save(); render(); });
    els.metro.addEventListener('click', () => { S.metronome = !S.metronome; K.recorder.save(); render(); });
    els.octDown.addEventListener('click', () => changeOctave(-1));
    els.octUp.addEventListener('click', () => changeOctave(1));
    els.bpmDown.addEventListener('click', () => changeBpm(-5));
    els.bpmUp.addEventListener('click', () => changeBpm(5));
    els.reverb.addEventListener('input', () => { S.reverb = Number(els.reverb.value) / 100; K.audio.setReverb(S.reverb); });
    els.reverb.addEventListener('change', () => K.recorder.save());
    // подтверждение прямо на кнопке: второе нажатие в течение 4 секунд удаляет всё
    els.clearAll.addEventListener('click', () => {
      if (els.clearAll.dataset.armed === '1'){
        clearTimeout(clearTimer);
        disarmClear();
        K.recorder.clearAll();
        toast('Все дорожки удалены.');
        return;
      }
      els.clearAll.dataset.armed = '1';
      els.clearAll.classList.add('danger');
      els.clearAll.textContent = 'Точно удалить всё?';
      clearTimer = setTimeout(disarmClear, 4000);
    });
    els.exportNoteText = els.exportNote.textContent;
    els.share.addEventListener('click', share);
    els.wav.addEventListener('click', exportWav);
    els.midi.addEventListener('click', exportMidi);

    const idOf = el => { const li = el.closest('.track'); return li ? Number(li.dataset.id) : NaN; };
    els.tracks.addEventListener('change', e => {
      if (e.target.matches('.sel')) K.recorder.trackOp(idOf(e.target), 'inst', e.target.value);
      else if (e.target.matches('.vol')) K.recorder.save(true);
    });
    els.tracks.addEventListener('input', e => {
      if (e.target.matches('.vol')) K.recorder.trackOp(idOf(e.target), 'vol', Number(e.target.value) / 100, true);
    });
    els.tracks.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = idOf(b);
      if (b.classList.contains('mute')) K.recorder.trackOp(id, 'mute');
      else if (b.classList.contains('del')){
        const removed = K.recorder.trackOp(id, 'remove');
        if (removed) toast('Дорожка удалена.', { label: 'Вернуть', run: () => K.recorder.restoreTrack(removed) });
      }
    });

    let theme = 'auto';
    try { theme = localStorage.getItem('klavishi:theme') || 'auto'; } catch (e) {}
    applyTheme(THEMES.includes(theme) ? theme : 'auto');
    els.theme.addEventListener('click', () => {
      const next = THEMES[(THEMES.indexOf(els.theme.dataset.mode) + 1) % THEMES.length];
      applyTheme(next);
      try { localStorage.setItem('klavishi:theme', next); } catch (e) {}
    });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderTracks, 120);
    });
  }

  K.ui = { init, render, renderStatus, tick, toast, playhead, changeOctave };
})(window.Klav);
