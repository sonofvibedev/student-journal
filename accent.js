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

  // Палитра для акцента: тёмный фон с оттенком, три пятна света в соседних оттенках, шторки и панель в тон
  function palette(hex) {
    if (!ACCENTS.some((a) => a[0] === hex)) hex = ACCENTS[0][0];
    if (hex === ACCENTS[0][0]) {                              // лайм: значения из j2.css без пересчёта
      return { accent: hex, bg: '#0A0C11', bgRgb: '10, 12, 17', limeRgb: '198, 244, 50', glow1: '198, 244, 50', glow2: '110, 80, 220', glow3: '255, 160, 60',
        sheet: '#14161D', nav: 'rgba(24, 26, 34, .86)', ink: '#0A0C11' };
    }
    const rgb = toRgb(hex), h = hue(rgb), bg = hsl(h, 0.28, 0.055);
    return { accent: hex, bg: toHex(bg), bgRgb: trip(bg), limeRgb: trip(rgb), glow1: trip(rgb), glow2: trip(hsl(h + 45, 0.65, 0.5)), glow3: trip(hsl(h - 45, 0.8, 0.55)),
      sheet: toHex(hsl(h, 0.2, 0.095)), nav: `rgba(${trip(hsl(h, 0.2, 0.115))}, .86)`, ink: toHex(bg) };
  }

  // Ставит палитру на страницу: переменные CSS, цвет браузера (theme-color) и шапка Telegram
  function apply(hex) {
    const p = palette(hex), doc = root.document;
    if (!doc) return p;
    const st = doc.documentElement.style;
    st.setProperty('--j-lime', p.accent); st.setProperty('--j-lime-rgb', p.limeRgb); st.setProperty('--j-lime-ink', p.ink);
    st.setProperty('--j-bg-rgb', p.bgRgb); st.setProperty('--j-glow-1-rgb', p.glow1); st.setProperty('--j-glow-2-rgb', p.glow2); st.setProperty('--j-glow-3-rgb', p.glow3);
    st.setProperty('--j-sheet', p.sheet); st.setProperty('--j-nav', p.nav);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p.bg);
    root.J2_BG = p.bg;
    try { if (root.TGApp && root.TGApp.setBg) root.TGApp.setBg(p.bg); } catch (e) { /* шапка Telegram не критична */ }
    return p;
  }

  // Сохранённый акцент ищем по суффиксу ключа: env.js (с префиксом тестового стенда) ещё не загружен
  function saved() {
    try {
      const ls = root.localStorage;
      for (let i = 0; ls && i < ls.length; i++) { const k = ls.key(i); if (k && k.slice(-KEY.length) === KEY) return ls.getItem(k); }
    } catch (e) { /* хранилище недоступно: останется лайм */ }
    return null;
  }

  const A = { ACCENTS, palette, apply, saved };
  root.J2Accent = A;
  if (root.document) apply(saved());
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
