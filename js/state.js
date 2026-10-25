/* Общее состояние и мелкие помощники.
   Все модули живут в одном пространстве имён window.Klav — это единственная глобальная переменная.
   ES-модули не используем: они не работают при открытии index.html двойным кликом (file://). */
(function (K) {
  'use strict';

  const NOTE_NAMES = ['до', 'до♯', 'ре', 'ре♯', 'ми', 'фа', 'фа♯', 'соль', 'соль♯', 'ля', 'ля♯', 'си'];
  const pc = m => ((m % 12) + 12) % 12;

  // Русское склонение: 1 нота, 2 ноты, 5 нот
  function plural(n, one, few, many){
    const a = n % 10, b = n % 100;
    const w = (a === 1 && b !== 11) ? one : (a >= 2 && a <= 4 && (b < 12 || b > 14)) ? few : many;
    return n + ' ' + w;
  }

  K.util = {
    $: id => document.getElementById(id),
    pc,
    isBlack: m => [1, 3, 6, 8, 10].includes(pc(m)),
    noteName: m => NOTE_NAMES[pc(m)] + ' ' + (Math.floor(m / 12) - 1),
    hue: m => pc(m) * 30,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    fmt: ms => {
      const s = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    },
    plural,
    notesWord: n => plural(n, 'нота', 'ноты', 'нот'),
    tracksWord: n => plural(n, 'дорожка', 'дорожки', 'дорожек')
  };

  K.MAX_TRACKS = 8;
  K.TRACK_HUES = [248, 338, 158, 28, 198, 288, 98, 0];

  K.state = {
    inst: 'piano',      // звучание для живой игры и новой дорожки
    octave: 4,          // 2–6
    octaves: 2,         // сколько октав видно на экране
    loop: false,
    metronome: false,
    bpm: 100,
    reverb: 0.25,       // 0–1
    recording: false,
    playing: false,
    fromLink: false,    // мелодия открыта по ссылке и ещё не менялась
    tracks: []          // { id, inst, vol (0–1), muted, events: [{ midi, t, dur }] }
  };
})(window.Klav = window.Klav || {});
