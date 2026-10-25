/* Запуск внутри Telegram как мини-приложение.
   Скрипт Telegram грузится асинхронно и вызывает K.tg.init(); без Telegram сайт работает как обычно. */
(function (K) {
  'use strict';

  K.tg = {
    active: false,
    app: null,

    init(){
      const tg = window.Telegram && window.Telegram.WebApp;
      if (!tg || !tg.initData) return;   // страница открыта не из Telegram
      this.active = true;
      this.app = tg;
      document.documentElement.classList.add('in-telegram');
      tg.ready();
      tg.expand();
      // без этого свайп вниз по клавишам сворачивает приложение
      try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) {}

      // тема как в Telegram, если человек не выбрал свою на сайте
      let own = null;
      try { own = localStorage.getItem('klavishi:theme'); } catch (e) {}
      const follow = () => {
        if (!own || own === 'auto') document.documentElement.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); } catch (e) {}
      };
      follow();
      tg.onEvent('themeChanged', follow);

      // мелодия по ссылке t.me/<бот>/<приложение>?startapp=<код>
      const code = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (code && K.recorder.loadCode(code)) K.keyboard.build();
      K.ui.render();
    },

    // Прямая ссылка на мини-приложение, если она указана в <meta name="klavishi:tg-app">.
    // В startapp Telegram пропускает не больше 512 символов
    appLink(code){
      const meta = document.querySelector('meta[name="klavishi:tg-app"]');
      const base = meta && meta.content;
      return base && code.length <= 512 ? base + '?startapp=' + code : null;
    },

    share(url){
      const text = 'Послушай мою мелодию в «Клавишах»';
      this.app.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text));
    }
  };
})(window.Klav);
