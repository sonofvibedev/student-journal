// Тема оформления: светлая / тёмная / системная + шесть цветовых гамм.
//
// Подключается в <head> СРАЗУ ПОСЛЕ app.css и до отрисовки страницы: атрибуты
// data-bs-theme и data-gamma ставятся на <html> ещё до первого кадра, поэтому
// вспышки чужой темы не бывает. Сами цвета — в app.css (блок «Цветовые гаммы»).
//
// «Системная» означает: внутри Telegram — тема Telegram (WebApp.colorScheme и
// событие themeChanged), в обычном браузере и PWA — настройка телефона
// (prefers-color-scheme, вместе с её изменениями на лету).

'use strict';

const THEME_KEY = 'theme';   // 'light' | 'dark' | 'system'
const GAMMA_KEY = 'gamma';   // id из THEME_GAMMAS
const DEFAULT_GAMMA = 'blue';

// Порядок — как в окне выбора. accent показывается кружком на кнопке гаммы.
// Акцент здесь — только кружок в выборе оформления. Рабочие цвета лежат
// в app.css блоками [data-gamma="…"], по паре значений на тёмную и светлую тему.
// Все гаммы проверены на контраст: белый текст на акценте и текст на фоне —
// не ниже WCAG AA (4.5:1) в обеих темах.
const THEME_GAMMAS = [
  { id: 'blue',       name: 'Синий',           accent: '#0A84FF' },
  { id: 'emerald',    name: 'Изумруд',         accent: '#2DD4A0' },
  { id: 'indigo',     name: 'Индиго',          accent: '#7C6CFF' },
  { id: 'amber',      name: 'Янтарь',          accent: '#FFA53D' },
  { id: 'wine',       name: 'Мягкий бордо',    accent: '#F2555A' },
  { id: 'ocean',      name: 'Океан',           accent: '#188095' },
  { id: 'moss',       name: 'Мох',             accent: '#438439' },
  { id: 'plum',       name: 'Слива',           accent: '#B646BE' },
  { id: 'terracotta', name: 'Терракота',       accent: '#C75126' },
  { id: 'graphite',   name: 'Графит',          accent: '#657797' },
  { id: 'lavender',   name: 'Лаванда',         accent: '#7C52E0' }
];

const THEME_MODES = [
  { id: 'light',  name: 'Светлая' },
  { id: 'dark',   name: 'Тёмная' },
  { id: 'system', name: 'Системная' }
];

// Кто хочет знать о смене темы (например, график Chart.js) — кладёт сюда функцию
const themeListeners = [];
function onThemeChange(fn) { if (typeof fn === 'function') themeListeners.push(fn); }

function storedTheme() {
  const v = lsGet(THEME_KEY);
  return THEME_MODES.some((m) => m.id === v) ? v : 'system';
}
function storedGamma() {
  const v = lsGet(GAMMA_KEY);
  return THEME_GAMMAS.some((g) => g.id === v) ? v : DEFAULT_GAMMA;
}

// Telegram считаем «системой» только внутри мини-приложения (есть initData)
function telegramWebApp() {
  const tg = window.Telegram && window.Telegram.WebApp;
  return tg && tg.initData ? tg : null;
}

function systemScheme() {
  const tg = telegramWebApp();
  if (tg && tg.colorScheme) return tg.colorScheme === 'light' ? 'light' : 'dark';
  try {
    if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch (e) { /* старый браузер — остаёмся на тёмной */ }
  return 'dark';
}

// Какая схема показывается прямо сейчас: 'light' или 'dark'
function effectiveScheme() {
  const mode = storedTheme();
  return mode === 'system' ? systemScheme() : mode;
}

// Фон приложения в текущей теме — для <meta name="theme-color"> и Telegram
function appBgColor() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  } catch (e) { /* стили ещё не загрузились */ }
  return effectiveScheme() === 'light' ? '#f2f2f7' : '#060606';
}

function applyTheme() {
  const root = document.documentElement;
  const scheme = effectiveScheme();
  root.setAttribute('data-bs-theme', scheme);   // Bootstrap 5.3 переключается этим же атрибутом
  root.setAttribute('data-theme', storedTheme());
  root.setAttribute('data-gamma', storedGamma());

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', appBgColor());

  themeListeners.forEach((fn) => { try { fn(scheme); } catch (e) { console.error(e); } });
}

function setThemeMode(mode) {
  if (!THEME_MODES.some((m) => m.id === mode)) return;
  lsSet(THEME_KEY, mode);
  applyTheme();
  renderThemePicker();
}

function setThemeGamma(id) {
  if (!THEME_GAMMAS.some((g) => g.id === id)) return;
  lsSet(GAMMA_KEY, id);
  applyTheme();
  renderThemePicker();
}

// --- Блок «Оформление» в личном кабинете ---
// Разметку рисуем здесь, чтобы она не расходилась с перечнем гамм.
function renderThemePicker() {
  const modes = document.getElementById('themeModeRow');
  if (modes) {
    modes.innerHTML = '';
    const current = storedTheme();
    THEME_MODES.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-mode' + (m.id === current ? ' active' : '');
      b.textContent = m.name;
      b.setAttribute('aria-pressed', m.id === current ? 'true' : 'false');
      b.addEventListener('click', () => setThemeMode(m.id));
      modes.appendChild(b);
    });
  }

  const gammas = document.getElementById('themeGammaRow');
  if (gammas) {
    gammas.innerHTML = '';
    const current = storedGamma();
    THEME_GAMMAS.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-gamma' + (g.id === current ? ' active' : '');
      b.setAttribute('aria-pressed', g.id === current ? 'true' : 'false');
      b.title = g.name;
      const dot = document.createElement('i');
      dot.style.background = g.accent;
      b.appendChild(dot);
      const label = document.createElement('span');
      label.textContent = g.name;
      b.appendChild(label);
      b.addEventListener('click', () => setThemeGamma(g.id));
      gammas.appendChild(b);
    });
  }

  const hint = document.getElementById('themeModeHint');
  if (hint) {
    hint.textContent = storedTheme() === 'system'
      ? (telegramWebApp() ? 'Следует теме Telegram' : 'Следует настройке телефона')
      : '';
  }
}

// --- Тему могли сменить снаружи: настройка телефона или тема Telegram ---
try {
  if (window.matchMedia) {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const react = () => { if (storedTheme() === 'system') applyTheme(); };
    if (mq.addEventListener) mq.addEventListener('change', react);
    else if (mq.addListener) mq.addListener(react);   // Safari до 14
  }
} catch (e) { /* нет matchMedia — остаёмся на сохранённой теме */ }

document.addEventListener('DOMContentLoaded', () => {
  const tg = telegramWebApp();
  if (tg && tg.onEvent) tg.onEvent('themeChanged', () => { if (storedTheme() === 'system') applyTheme(); });
  renderThemePicker();
});

// Первое применение — прямо сейчас, до отрисовки страницы
applyTheme();
