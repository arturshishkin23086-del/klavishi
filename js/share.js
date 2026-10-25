/* Кодирование мелодии в короткую строку для ссылки вида  сайт/#<код>.
   Формат (версия 1), всё в байтах, затем base64url (буквы, цифры, «-» и «_»):
     версия, октава, число дорожек,
     для каждой дорожки: номер звучания, громкость 0–100, число нот (varint),
     для каждой ноты: midi, сдвиг от начала прошлой ноты (varint, шаг 10 мс), длительность (varint, шаг 10 мс).
   Сдвиги вместо абсолютного времени и varint дают 3–4 байта на ноту. */
(function (K) {
  'use strict';
  const { clamp, notesWord } = K.util;
  const VERSION = 1;
  const MAX_CODE = 3000;   // ссылка около 3 КБ ещё нормально проходит через мессенджеры

  const instIds = () => K.audio.INSTRUMENTS.map(i => i.id);

  function varint(out, v){
    while (v >= 128){ out.push((v & 127) | 128); v = Math.floor(v / 128); }
    out.push(v);
  }

  function toB64url(bytes){
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(code){
    let s = code.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function encode(){
    const S = K.state;
    const tracks = S.tracks.filter(tr => !tr.muted && tr.events.length);
    if (!tracks.length) return { error: 'Нечего отправлять: нет звучащих дорожек.' };
    const ids = instIds();
    const b = [VERSION, S.octave, tracks.length];
    let notes = 0;
    tracks.forEach(tr => {
      b.push(Math.max(0, ids.indexOf(tr.inst)), Math.round(tr.vol * 100));
      const evs = tr.events.slice().sort((x, y) => x.t - y.t);
      varint(b, evs.length);
      let prev = 0;
      evs.forEach(e => {
        const t = Math.round(e.t / 10);
        b.push(e.midi & 127);
        varint(b, t - prev);
        varint(b, Math.max(1, Math.round(e.dur / 10)));
        prev = t;
      });
      notes += evs.length;
    });
    const code = toB64url(b);
    if (code.length > MAX_CODE){
      const fit = Math.floor(MAX_CODE / (code.length / notes));
      return { error: 'Слишком длинно для ссылки: ' + notesWord(notes) + ', а помещается примерно ' + fit + '. Выключи или удали часть дорожек.' };
    }
    return { code };
  }

  function decode(code){
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
      const b = fromB64url(code);
      let p = 0;
      const byte = () => { if (p >= b.length) throw new Error('short'); return b[p++]; };
      const vint = () => {
        let v = 0, mul = 1, x;
        do {
          x = byte();
          v += (x & 127) * mul;
          mul *= 128;
          if (mul > 2 ** 35) throw new Error('varint');
        } while (x & 128);
        return v;
      };
      if (byte() !== VERSION) return null;
      const octave = clamp(byte(), 2, 6);
      const n = byte();
      if (n < 1 || n > K.MAX_TRACKS) return null;
      const ids = instIds(), tracks = [];
      for (let i = 0; i < n; i++){
        const inst = ids[byte()] || 'piano';
        const vol = clamp(byte(), 0, 100) / 100;
        const count = vint();
        if (count > 5000) return null;
        const events = [];
        let t = 0;
        for (let j = 0; j < count; j++){
          const midi = byte() & 127;
          t += vint();
          events.push({ midi, t: t * 10, dur: Math.max(30, vint() * 10) });
        }
        tracks.push({ inst, vol, events });
      }
      return { octave, tracks };
    } catch (e) {
      return null;
    }
  }

  K.share = { encode, decode };
})(window.Klav);
