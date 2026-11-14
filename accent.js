// «Журнал 2.0.3»: цветовая гамма. Акцент меняет не только --j-lime, но и фон, пятна света, шторки и нижнюю панель.
// Подключается в <head> без defer: сохранённый акцент применяется до первой отрисовки, после перезагрузки фон не мигает.
// Цвета считаются из акцента (оттенок и насыщенность). Лайм — прежние значения j2.css, он выглядит как раньше.
// Работает в браузере (window.J2Accent) и в Node (тест).
(function (root) {
  'use strict';
  const ACCENTS = [['#C6F432', 'Лайм'], ['#A78BFA', 'Фиолетовый'], ['#FFB347', 'Оранжевый'], ['#78A0FF', 'Синий'], ['#FF8CBE', 'Розовый']];
  const KEY = 'j2_accent';

  const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const hue = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const hsl = (h, s, l) => {                                  // h 0–360, s и l 0–1 → [r, g, b] 0–255
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  const trip = (rgb) => rgb.map((v) => Math.round(v)).join(', ');

  // Относительная яркость и контраст (WCAG): нужны, чтобы подобрать цвет акцента-текста на светлом фоне
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  // Палитра для акцента: тёмный фон с оттенком, три пятна света в соседних оттенках, шторки и панель в тон.
  // theme = 'light': светлый фон с лёгким оттенком, белые шторки; текст на акцентной заливке остаётся тёмным (акценты яркие),
  // а сам акцент как цвет текста (accentText) подбирается тёмнее, чтобы на светлом фоне контраст был не меньше 4,5:1.
  function palette(hex, theme) {
    if (!ACCENTS.some((a) => a[0] === hex)) hex = ACCENTS[0][0];
    const rgb = toRgb(hex), h = hue(rgb);
    if (theme === 'light') {
      const bg = hex === ACCENTS[0][0] ? [243, 245, 249] : hsl(h, 0.3, 0.955), s = Math.max(0.6, Math.min(1, 0.9));
      let l = 0.44, t = hsl(h, s, l);
      while (l > 0.12 && contrast(t, bg) < 4.7) { l -= 0.01; t = hsl(h, s, l); }                    // подбираем темнее, пока не хватит контраста
      return { accent: hex, bg: toHex(bg), bgRgb: trip(bg), limeRgb: trip(rgb), glow1: trip(rgb), glow2: trip(hsl(h + 45, 0.65, 0.62)), glow3: trip(hsl(h - 45, 0.8, 0.65)),
        sheet: '#FFFFFF', nav: 'rgba(255, 255, 255, .9)', ink: '#0A0C11', accentText: toHex(t), text: '#12151C', muted: '#566072' };
    }
    if (hex === ACCENTS[0][0]) {                              // лайм: значения из j2.css без пересчёта
      return { accent: hex, bg: '#0A0C11', bgRgb: '10, 12, 17', limeRgb: '198, 244, 50', glow1: '198, 244, 50', glow2: '110, 80, 220', glow3: '255, 160, 60',
        sheet: '#14161D', nav: 'rgba(24, 26, 34, .86)', ink: '#0A0C11', accentText: hex, text: '#F2F4F8', muted: '#9AA0AE' };
    }
    const bg = hsl(h, 0.28, 0.055);
    return { accent: hex, bg: toHex(bg), bgRgb: trip(bg), limeRgb: trip(rgb), glow1: trip(rgb), glow2: trip(hsl(h + 45, 0.65, 0.5)), glow3: trip(hsl(h - 45, 0.8, 0.55)),
      sheet: toHex(hsl(h, 0.2, 0.095)), nav: `rgba(${trip(hsl(h, 0.2, 0.115))}, .86)`, ink: toHex(bg), accentText: hex, text: '#F2F4F8', muted: '#9AA0AE' };
  }

  // ---------- тема: «Авто» / «Тёмная» / «Светлая» ----------
  const THEME_KEY = 'j2_theme', THEMES = [['auto', 'Авто'], ['dark', 'Тёмная'], ['light', 'Светлая']];
  function ls(key) {                                           // ищем по суффиксу ключа: env.js (с префиксом тестового стенда) ещё не загружен
    try {
      const st = root.localStorage;
      for (let i = 0; st && i < st.length; i++) { const k = st.key(i); if (k && k.slice(-key.length) === key) return st.getItem(k); }
    } catch (e) { /* хранилище недоступно */ }
    return null;
  }
  const themePref = () => { const v = ls(THEME_KEY); return THEMES.some((t) => t[0] === v) ? v : 'auto'; };
  // Что показать сейчас: явный выбор, а «Авто» — тема Telegram внутри Mini App, иначе настройка телефона (prefers-color-scheme)
  function themeNow(pref) {
    pref = pref || themePref();
    if (pref !== 'auto') return pref;
    try { const tg = root.Telegram && root.Telegram.WebApp; if (tg && tg.initData && tg.colorScheme) return tg.colorScheme === 'light' ? 'light' : 'dark'; } catch (e) { /* без Telegram */ }
    try { if (root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches) return 'light'; } catch (e) { /* старый браузер */ }
    return 'dark';
  }

  // Ставит палитру на страницу: переменные CSS, тема (data-theme), цвет браузера (theme-color) и шапка Telegram
  function apply(hex, theme) {
    theme = theme || themeNow();
    const p = palette(hex, theme), doc = root.document;
    if (!doc) return p;
    doc.documentElement.setAttribute('data-theme', theme);
    const st = doc.documentElement.style;
    st.setProperty('--j-accent-text', p.accentText); st.setProperty('--j-text', p.text); st.setProperty('--j-muted', p.muted);   // текст ставим сразу: заставка рисуется до j2.css
    st.setProperty('--j-lime', p.accent); st.setProperty('--j-lime-rgb', p.limeRgb); st.setProperty('--j-lime-ink', p.ink); st.setProperty('--j-ink-rgb', trip(toRgb(p.ink)));
    st.setProperty('--j-bg-rgb', p.bgRgb); st.setProperty('--j-glow-1-rgb', p.glow1); st.setProperty('--j-glow-2-rgb', p.glow2); st.setProperty('--j-glow-3-rgb', p.glow3);
    st.setProperty('--j-sheet', p.sheet); st.setProperty('--j-nav', p.nav);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p.bg);
    root.J2_BG = p.bg;
    try { if (root.TGApp && root.TGApp.setBg) root.TGApp.setBg(p.bg); } catch (e) { /* шапка Telegram не критична */ }
    return p;
  }

  // Сохранённый акцент ищем по суффиксу ключа: env.js (с префиксом тестового стенда) ещё не загружен
  const saved = () => ls(KEY);

  // Перерисовать палитру по сохранённым выбору темы и акцента (после смены темы в профиле, при смене настройки телефона или темы Telegram)
  const refresh = () => apply(saved());

  const A = { ACCENTS, THEMES, THEME_KEY, palette, apply, saved, themePref, themeNow, refresh };
  root.J2Accent = A;
  if (root.document) {
    apply(saved());
    try {                                                     // «Авто» следует за телефоном на лету
      const mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: light)');
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (themePref() === 'auto') refresh(); });
    } catch (e) { /* без слежения за настройкой */ }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
