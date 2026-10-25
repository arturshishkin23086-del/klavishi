/* Скачивание: WAV (рендер через OfflineAudioContext — тот же синтез, что и вживую)
   и MIDI-файл формата 1 с отдельной дорожкой на каждый слой. Без внешних библиотек. */
(function (K) {
  'use strict';

  const audible = () => K.state.tracks.filter(tr => !tr.muted && tr.events.length);
  const append = (a, b) => { for (let i = 0; i < b.length; i++) a.push(b[i]); };

  /* ---------- WAV ---------- */
  function encodeWav(buf){
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    // срезаем тишину в хвосте, оставляя 0,1 с
    let end = buf.length;
    outer: while (end > 0){
      for (let c = 0; c < chans.length; c++) if (Math.abs(chans[c][end - 1]) > 0.0005) break outer;
      end--;
    }
    end = Math.min(buf.length, end + Math.round(buf.sampleRate * 0.1));
    const nch = chans.length, bytes = end * nch * 2, sr = buf.sampleRate;
    const v = new DataView(new ArrayBuffer(44 + bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < end; i++){
      for (let c = 0; c < nch; c++){
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([v], { type: 'audio/wav' });
  }

  async function wav(){
    const tracks = audible();
    const total = tracks.reduce((m, tr) => Math.max(m, K.recorder.trackDur(tr)), 0);
    return encodeWav(await K.audio.render(tracks, total));
  }

  /* ---------- MIDI ---------- */
  function vlq(out, n){
    const b = [n & 127];
    while ((n = Math.floor(n / 128)) > 0) b.unshift((n & 127) | 128);
    append(out, b);
  }
  function chunk(out, body){
    const n = body.length;
    append(out, [0x4D, 0x54, 0x72, 0x6B, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    append(out, body);
  }

  function midi(){
    const S = K.state, PPQ = 480;
    const ticks = ms => Math.round(ms * PPQ * S.bpm / 60000);
    const tracks = audible();
    const us = Math.round(60000000 / S.bpm);   // микросекунд на четверть
    const out = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length + 1, PPQ >> 8, PPQ & 255];
    chunk(out, [0, 0xFF, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xFF, 0x2F, 0]);
    // канал 10 (индекс 9) в General MIDI отдан ударным
    const CH = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    let k = 0;
    const enc = window.TextEncoder ? new TextEncoder() : null;
    tracks.forEach((tr, i) => {
      const drums = tr.inst === 'drums';
      const ch = drums ? 9 : CH[k++ % CH.length];
      const vel = Math.max(1, Math.min(127, Math.round(30 + tr.vol * 90)));
      const evs = [];
      tr.events.forEach(e => {
        const note = drums ? K.audio.drumGm(e.midi) : e.midi;
        evs.push({ at: ticks(e.t), on: 1, note }, { at: ticks(e.t + e.dur), on: 0, note });
      });
      evs.sort((a, b) => a.at - b.at || a.on - b.on);   // в один момент сначала отпускания
      const body = [];
      const name = enc ? Array.from(enc.encode('Дорожка ' + (i + 1))) : [];
      body.push(0, 0xFF, 0x03);
      vlq(body, name.length);
      append(body, name);
      if (!drums) body.push(0, 0xC0 | ch, K.audio.gm(tr.inst));
      let last = 0;
      evs.forEach(ev => {
        vlq(body, ev.at - last);
        last = ev.at;
        body.push(ev.on ? 0x90 | ch : 0x80 | ch, ev.note, ev.on ? vel : 0);
      });
      body.push(0, 0xFF, 0x2F, 0);
      chunk(out, body);
    });
    return new Blob([new Uint8Array(out)], { type: 'audio/midi' });
  }

  function download(blob, name){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  K.exporter = { wav, midi, download };
})(window.Klav);
