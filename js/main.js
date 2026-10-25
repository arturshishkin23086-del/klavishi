/* Инициализация */
(function (K) {
  'use strict';

  K.recorder.load();
  K.keyboard.init();
  K.ui.init();
  if (K.recorder.loadFromHash()) K.keyboard.build();   // октава могла смениться
  K.ui.render();

  window.addEventListener('hashchange', () => {
    if (K.recorder.loadFromHash()){
      K.keyboard.build();
      K.ui.render();
    }
  });

  // Разблокировка звука. На iOS касание (pointerdown) не считается жестом пользователя,
  // а touchend и click — считаются, поэтому будим AudioContext и на них
  const EVENTS = ['touchend', 'click', 'keydown'];
  function unlock(){
    const c = K.audio.ctx();
    if (c && c.state === 'running') EVENTS.forEach(t => document.removeEventListener(t, unlock, true));
  }
  EVENTS.forEach(t => document.addEventListener(t, unlock, true));
})(window.Klav);
