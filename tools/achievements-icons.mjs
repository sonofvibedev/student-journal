// Значки достижений 2.x: один генератор на всё.
//   icons/achievements/<code>.svg        — с CSS-переменными, запасные значения тёмной темы (inline и <img>)
//   icons/achievements/light/<code>.svg  — то же, запасные значения светлой темы (для <img> на светлом фоне)
//   icons/achievements/achievements-icons.css — токены тёмной/светлой темы и состояния (закрыто, мелкий размер)
//   icons/achievements/sprite.svg        — все значки из achievements.js одним файлом (<symbol id="a-<code>">): кабинет студента
//                                          подгружает его один раз, кладёт в страницу и рисует значки через <use> (app-ach.js)
//   docs/previews/achievements-icons.html — превью, всё инлайн (открывается и с диска, и по http)
// Список достижений берётся из achievements.js (сам файл не меняется).
// Запуск: node tools/achievements-icons.mjs   — генерирует файлы и проверяет контраст (падает, если < 3:1).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// ---------- данные из achievements.js ----------
const src = readFileSync('achievements.js', 'utf8');
const block = src.slice(src.indexOf('const ACH_CATEGORIES'), src.indexOf('// Значки за рекорды выдаёт сервер'));
const { ACH_CATEGORIES, ACHIEVEMENTS } = new Function(block + '; return { ACH_CATEGORIES, ACHIEVEMENTS };')();

// Предложенные значки: в achievements.js их нет, логика — после одобрения владельца.
const PROPOSED = [
  { code: 'hidden', cat: 'proposed', icon: 'hidden', tier: 'accent',
    title: 'Секретное достижение', about: 'Заглушка для скрытых значков: условие откроется после получения' },
  { code: 'session_clean', cat: 'proposed', icon: 'cap', tier: 'gold',
    title: 'Сессия без хвостов', about: 'Все зачёты и экзамены из расписания сданы в срок (новые события 2.1)' },
  { code: 'hw_week', cat: 'proposed', icon: 'checklist', tier: 'silver',
    title: 'Неделя без долгов', about: 'Все домашки недели отмечены сделанными до срока' },
  { code: 'light_side', cat: 'proposed', icon: 'sun', tier: 'accent',
    title: 'Светлая сторона', about: 'Попробовать светлую тему оформления' },
  { code: 'schedule_week', cat: 'proposed', icon: 'calClock', tier: 'bronze',
    title: 'Сверился с расписанием', about: 'Открыть расписание пять учебных дней подряд' }
];
const CATS = [...ACH_CATEGORIES, { id: 'proposed', title: 'Предложено (нет в achievements.js)' }];
const ALL = [...ACHIEVEMENTS, ...PROPOSED];

// ---------- глифы: сетка 24, штрих 2 (смысл взят из badges.js 1.x, перерисованы под медальон) ----------
// data-f — элемент получает мягкую заливку --ach-glyph-soft (дуотон «стекла»).
const CROWN = (x, y) => `<path data-f d="M${x} ${y + 3.4}l1.6-3.4 1.6 3.4 2-1.2-.8 4.2h-5.6l-.8-4.2z"/>`;
const GRID = (y) => `<rect data-f x="3.8" y="${y}" width="11.4" height="11.4" rx="1.6"/><path d="M7.6 ${y}v11.4M11.4 ${y}v11.4M3.8 ${y + 3.8}h11.4M3.8 ${y + 7.6}h11.4"/>`;
const BOLT = '<path data-f d="M18.4 12.6l-2.9 4.6h2.6l-1 4.2 3.5-5h-2.6z"/>';
const STAR = (cx, cy, s) => { const p = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? s * .45 : s, a = -Math.PI / 2 + i * Math.PI / 5; p.push((cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2)); } return `<path data-f d="M${p.join('L')}z"/>`; };
const BULB = '<path data-f d="M9.2 16.4a6 6 0 1 1 5.6 0v1.8H9.2z"/><path d="M9.8 20.6h4.4"/>';
const G = {
  clean: '<path data-f d="M6.8 3.6h6.4l4.6 4.6v11.5a1 1 0 0 1-1 1H6.8a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1z"/><path d="M13.2 3.6v4.6h4.6"/><path d="M9 14l2.1 2.1 3.7-4"/>',
  streak: '<path data-f d="M12 3c3.1 2.8 5.4 5.5 5.4 8.9a5.4 5.4 0 0 1-10.8 0c0-2 .7-3.6 1.9-5 .1 1.1.5 1.8 1.1 2.4-.2-2.4.7-4.5 2.4-6.3z"/><path d="M12 19.9a2.4 2.4 0 0 0 2.4-2.4c0-1.3-1.1-2.2-2.4-3.7-1.2 1.5-2.4 2.4-2.4 3.7a2.4 2.4 0 0 0 2.4 2.4z"/>',
  cup: '<path data-f d="M8 4h8v5.2a4 4 0 0 1-8 0z"/><path d="M8 5.6H5.6v1.6a3 3 0 0 0 2.9 3M16 5.6h2.4v1.6a3 3 0 0 1-2.9 3"/><path d="M12 13.2v2.8"/><path d="M8.6 20.2h6.8l-.7-4.2H9.3z"/>',
  up: '<path d="M12 20V7"/><path d="M6.8 12.2L12 7l5.2 5.2"/><path d="M5.6 3.8h12.8"/>',
  cert: '<path data-f d="M5.4 4.4a1 1 0 0 1 1-1h4.9l3 3v6.3a1 1 0 0 1-1 1H6.4a1 1 0 0 1-1-1z"/><path d="M11.3 3.4v3h3"/><path d="M7.6 7.8h2.2M7.6 10.4h3.8"/><circle data-f cx="16.6" cy="16.6" r="4.1"/><path d="M16.6 14.4v2.2l1.5.9"/>',
  door: '<path d="M4 20.4h16"/><path d="M14.4 4.8h4v15.6"/><path data-f d="M14.4 3.4L7.4 5.6v13l7 2.2z"/><path d="M12.6 11.8v1.8"/>',
  steps: '<path data-f d="M8.5 4.6c1.5 0 2.4 1.4 2.4 3.2 0 1.6-.6 2.8-.6 3.8 0 1-.6 1.6-1.8 1.6-1.8 0-3.1-1.4-3.1-3.4 0-2.9 1.4-5.2 3.1-5.2z"/><ellipse cx="8.2" cy="16" rx="1.8" ry="1.6"/><path data-f d="M15.7 8.8c1.5 0 2.4 1.4 2.4 3.2 0 1.6-.6 2.8-.6 3.8 0 1-.6 1.6-1.8 1.6-1.8 0-3.1-1.4-3.1-3.4 0-2.9 1.4-5.2 3.1-5.2z"/><ellipse cx="15.4" cy="20.2" rx="1.8" ry="1.6"/>',
  tech: '<circle data-f cx="9.4" cy="9.4" r="5"/><path d="M9.4 2.4v2M9.4 14.4v2M2.4 9.4h2M14.4 9.4h2M4.4 4.4l1.4 1.4M13 13l1.4 1.4M14.4 4.4L13 5.8M5.8 13l-1.4 1.4"/><circle cx="9.4" cy="9.4" r="1.8"/><circle cx="16.4" cy="16.4" r="3.2"/><path d="M18.7 18.7l2 2"/>',
  bell: '<path data-f d="M6.8 16.2V11a5.2 5.2 0 0 1 10.4 0v5.2l1.4 1.7H5.4z"/><path d="M10 20.2a2.2 2.2 0 0 0 4 0"/><path d="M4.8 7.2a7.4 7.4 0 0 1 1.8-2.6M19.2 7.2a7.4 7.4 0 0 0-1.8-2.6"/>',
  collector: '<rect data-f x="3.8" y="4.8" width="16.4" height="14.4" rx="2.2"/><path d="M3.8 8.6h16.4"/><circle cx="9" cy="14" r="2.4"/><circle cx="15" cy="14" r="2.4"/>',
  book: '<rect data-f x="7.2" y="3.8" width="11" height="16.4" rx="1.8"/><path d="M10.2 3.8v16.4"/><path d="M7.2 6.8H5.4M7.2 10.2H5.4M7.2 13.6H5.4M7.2 17H5.4"/><path d="M12.8 9h3M12.8 12.2h3"/>',
  shoe: '<path data-f d="M5.2 17v-4.8H8l2.4 1.7 3.3.5 4 1.7a2.8 2.8 0 0 1 1.7 2.6v.4H5.2z"/><path d="M8.2 12.4l1 1.8M11.2 13.8l.9 1.6"/><path d="M2.8 13.2h1.4M2.4 16.2h1.4M4 20.6h16"/>',
  bench: '<path d="M4 12.2h16M4 15h16"/><path d="M6.2 15v5M17.8 15v5M6.2 12.2V8.4M17.8 12.2V8.4"/><path d="M4.8 8.4h14.4"/>',
  coffee: '<path data-f d="M5.4 10.8h11.4v5a3.8 3.8 0 0 1-3.8 3.8H9.2a3.8 3.8 0 0 1-3.8-3.8z"/><path d="M16.8 12h1.2a2.1 2.1 0 0 1 0 4.2h-1.2"/><path d="M8.6 7.8c0-1.1 1-1.5 1-2.6M12.4 7.8c0-1.1 1-1.5 1-2.6"/>',
  desk: '<path d="M3.8 11h16.4"/><path d="M6.2 11v9M17.8 11v9"/><path d="M7.6 15.2h8.8"/><path data-f d="M8.8 11V7.8a1.2 1.2 0 0 1 1.2-1.2h4a1.2 1.2 0 0 1 1.2 1.2V11z"/>',
  ghost: '<path data-f d="M6.2 20.2V10.2a5.8 5.8 0 0 1 11.6 0v10l-1.9-1.6-2 1.6-1.9-1.6-1.9 1.6-2-1.6z"/><path d="M10 10.4v.01M14 10.4v.01"/>',
  warn: '<path data-f d="M12 4L20.6 19.6H3.4z"/><path d="M12 9.8v4.4"/><path d="M12 17v.01"/>',
  envelope: '<rect data-f x="4" y="4.8" width="16" height="10.4" rx="1.8"/><path d="M4 6.6l8 5.2 8-5.2"/><path d="M12 17.4v1.4M12 21v.01"/>',
  sudokuFast: GRID(3.8) + BOLT,
  sudokuSpeed: GRID(3.8) + '<circle data-f cx="17.6" cy="17.6" r="3.8"/><path d="M17.6 15.8v1.8l1.2.8"/>',
  sudokuMaster: GRID(8.6) + CROWN(16.4, 3.4),
  minesSteady: '<path d="M6.4 20.6V3.8"/><path data-f d="M6.4 4.8h8l-1.9 3.1 1.9 3.1h-8z"/>' + BOLT,
  minesPro: '<circle data-f cx="9.4" cy="9.4" r="4.4"/><path d="M9.4 2.4v1.6M9.4 14.8v1.6M2.4 9.4H4M14.8 9.4h1.6M4.5 4.5l1.1 1.1M13.2 13.2l1.1 1.1M14.3 4.5l-1.1 1.1M5.6 13.2l-1.1 1.1"/><circle data-f cx="17.8" cy="17.8" r="3.6"/><path d="M17.8 16v1.8l1.2.8"/>',
  minesPerfect: '<circle data-f cx="12" cy="14.8" r="4.6"/><path d="M12 8.2v1.4M5 14.8h1.6M17.4 14.8H19M7.1 9.9l1.1 1.1M15.8 18.6l1.1 1.1M16.9 9.9l-1.1 1.1M8.2 18.6l-1.1 1.1"/>' + CROWN(9.2, 1.6),
  flappyUp: '<path data-f d="M3.4 15.4c3.4.6 6.4-.4 8.8-3 1.4-1.5 2.3-3.2 2.8-5.2 1.9 2.4 2.6 5 2 7.8-.6 2.8-2.6 4.8-5.8 5.8-3 .9-5.6.2-7.8-2.2z"/><path d="M19 3.2v6.4M16.6 5.6L19 3.2l2.4 2.4"/>',
  flappyKing: '<path data-f d="M4 17.4c3.6.6 7-.4 9.4-3 1.6-1.9 2.4-4 2.1-6.4l2.6-1.6-3.2.2c-1.4-.4-2.8.2-3.6 1.6-.8 1.6-.4 3.4-1.8 5-1.4 1.6-3.4 2.6-5.5 4.2z"/><path d="M13.6 10.2v.01"/>' + CROWN(3.6, 1.8),
  apple: '<path data-f d="M12 8c-1-1-2.4-1.4-3.7-1C6.4 7.6 5.2 9.4 5.2 11.8c0 3.9 2.9 8.2 5 8.2.8 0 1.2-.5 1.8-.5s1 .5 1.8.5c2.1 0 5-4.3 5-8.2 0-2.4-1.2-4.2-3.1-4.8-1.3-.4-2.7 0-3.7 1z"/><path d="M12 8V4.6"/><path d="M12 5.8c1-1.7 2.5-2.3 4.2-2.1-.2 1.9-1.5 2.9-4.2 3.1z"/>',
  snake: '<path d="M4 8.6h8.6a3.1 3.1 0 0 1 0 6.2H7.9a3.1 3.1 0 0 0 0 6.2H20"/><rect data-f x="3.2" y="4.2" width="5.6" height="4.4" rx="1.6"/><path d="M6.4 6.4h.01"/>',
  snakeCrown: '<path d="M4 11.4h8.6a3.1 3.1 0 0 1 0 6.2H7.9a2 2 0 0 0 0 3.4H20"/><rect data-f x="3.2" y="7" width="5.6" height="4.4" rx="1.6"/><path d="M6.4 9.2h.01"/>' + CROWN(13.4, 2.4),
  bulb: BULB + '<path d="M12 9.4v4.6M10 11.6l2-2.2 2 2.2"/>',
  bulbBolt: BULB + '<path d="M12.8 7.6l-2.2 3.8h2.4l-.8 3.2"/>',
  calCheck: '<rect data-f x="3.8" y="5.4" width="16.4" height="14.8" rx="2.2"/><path d="M8.4 3.4v4M15.6 3.4v4M3.8 10h16.4"/><path d="M8.8 14.8l2.2 2.2 4.2-4.4"/>',
  thought: '<path data-f d="M7.8 15a3.6 3.6 0 0 1-.6-7.1 4.2 4.2 0 0 1 7.8-1.5 3.4 3.4 0 0 1 4.4 3.2 3.4 3.4 0 0 1-3.4 3.4h-.4A2 2 0 0 1 13.6 15z"/><circle cx="7.2" cy="18.6" r="1.3"/><circle cx="4.2" cy="21" r=".7"/>',
  joystick: '<rect data-f x="2.4" y="7.6" width="19.2" height="10.8" rx="5.4"/><path d="M7.4 11.2v3.6M5.6 13h3.6"/><path d="M15.6 12h.01M18 14.2h.01"/>',
  joystickStar: '<rect data-f x="2.4" y="10" width="19.2" height="10" rx="5"/><path d="M7 13.2v3.6M5.2 15h3.6"/><path d="M15.4 14h.01M17.8 16.2h.01"/>' + STAR(12, 5.4, 3.6),
  fiveStars: STAR(12, 6.4, 4.2) + STAR(5, 16.2, 3) + STAR(12, 16.2, 3) + STAR(19, 16.2, 3),
  // --- предложенные ---
  hidden: '<circle data-f cx="12" cy="12" r="8.4"/><path d="M9.4 9.6a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2 1-1.2 1.8v.5"/><path d="M12 16.9v.01"/>',
  cap: '<path data-f d="M2.6 9.4L12 4.8l9.4 4.6L12 14z"/><path d="M6.6 11.4v4.4c1.4 1.4 3.2 2.1 5.4 2.1s4-.7 5.4-2.1v-4.4"/><path d="M21.4 9.4v5.2"/>',
  checklist: '<rect data-f x="4.8" y="3.6" width="14.4" height="17" rx="2.2"/><path d="M8.2 9l1.4 1.4 2.2-2.4M8.2 14.6l1.4 1.4 2.2-2.4M14.2 9.2h1.8M14.2 14.8h1.8"/>',
  sun: '<circle data-f cx="12" cy="12" r="4.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>',
  calClock: '<rect data-f x="3.4" y="5" width="13.6" height="13" rx="2"/><path d="M7.2 3.2v3.4M13.2 3.2v3.4M3.4 9.4h13.6"/><circle data-f cx="17.2" cy="17.2" r="4"/><path d="M17.2 15.4v1.8l1.2.8"/>'
};

// ---------- токены ----------
// Тёмная — повторяет j2.css; светлая — лайм затемнён до читаемого на белом.
const T = {
  dark: {
    glass: 'rgba(255,255,255,.07)', rim: 'rgba(255,255,255,.24)', shine: 'rgba(255,255,255,.42)',
    glyph: '#C6F432', 'glyph-soft': 'rgba(198,244,50,.18)',
    anti: '#FF8A80', 'anti-soft': 'rgba(255,138,128,.18)', 'anti-glass': 'rgba(255,138,128,.09)',
    'tier-bronze': '#E0A06A', 'tier-silver': '#C9D2DD', 'tier-gold': '#F2C14E', 'tier-platinum': '#8FE3E0',
    'plate-ink': '#0A0C11', locked: '#6B7280'
  },
  light: {
    glass: 'rgba(18,21,28,.045)', rim: 'rgba(18,21,28,.16)', shine: 'rgba(255,255,255,.95)',
    glyph: '#4A6B00', 'glyph-soft': 'rgba(120,175,0,.20)',
    anti: '#C2372A', 'anti-soft': 'rgba(194,55,42,.14)', 'anti-glass': 'rgba(194,55,42,.06)',
    'tier-bronze': '#9C5A26', 'tier-silver': '#66717F', 'tier-gold': '#946C00', 'tier-platinum': '#13807C',
    'plate-ink': '#FFFFFF', locked: '#9AA0AA'
  }
};
// В тёмной теме глиф и мягкая заливка следуют акценту приложения (accent.js меняет --j-lime)
const DARK_LINKS = { glyph: 'var(--j-lime, #C6F432)', 'glyph-soft': 'rgba(var(--j-lime-rgb, 198, 244, 50), .18)' };

// ---------- медальон, сетка 64 ----------
// Круг стекла r30, кант тира r27, safe-zone глифа 15..49 (глиф 24×1.4), ярлык номера y 50..60.
const STUDS = (r) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = Math.PI / 8 + i * Math.PI / 4; return `<circle cx="${(32 + r * Math.cos(a)).toFixed(2)}" cy="${(32 + r * Math.sin(a)).toFixed(2)}" r="1.9"/>`; }).join('');
function frame(tier, v) {
  const anti = tier.startsWith('anti');
  const key = anti ? 'anti' : tier === 'accent' ? 'glyph' : 'tier-' + tier;
  const c = v(key);
  const ring = (r, w, dash) => `<circle cx="32" cy="32" r="${r}" style="fill:none;stroke:${c};stroke-width:${w}${dash ? ';stroke-dasharray:' + dash : ''}"/>`;
  let s = '';
  if (anti) s = ring(27, 2, '5.3 3.18');                                    // рваный кант: «анти»
  else if (tier === 'accent') s = ring(27, 2) + `<path style="fill:${c}" d="M50.5 6.5l1.5 3.9 3.9 1.5-3.9 1.5-1.5 3.9-1.5-3.9-3.9-1.5 3.9-1.5z"/>`; // искра
  else if (tier === 'bronze') s = ring(27, 2);                               // один кант
  else s = ring(27, 2) + ring(24.4, 1);                                      // серебро и выше: двойной кант
  if (tier === 'gold' || tier === 'platinum') s += `<g style="fill:${c}">${STUDS(27)}</g>`;   // золото: заклёпки
  if (tier === 'platinum') s += `<path style="fill:${c};stroke:${v('plate-ink')};stroke-width:1.2" d="M32 .8l4.4 4.6L32 10l-4.4-4.6z"/>`; // платина: камень
  return { s, c, key };
}
function svg(a, fb) {
  const v = (k) => `var(--ach-${k}, ${fb[k]})`;
  const anti = a.tier.startsWith('anti');
  const { s: rim, c: tierC } = frame(a.tier, v);
  const glyphC = anti ? v('anti') : v('glyph'), soft = anti ? v('anti-soft') : v('glyph-soft');
  const glyph = (G[a.icon] || '').replace(/ data-f/g, ` style="fill:${soft}"`);
  const num = a.rank != null ? a.rank : (a.need != null && ['streak', 'homework'].includes(a.group) ? a.need : null);
  const w = String(num).length > 1 ? 20 : 15;
  const plate = num == null ? '' : `<g style="display:var(--ach-plate-display, inline)"><rect x="${32 - w / 2}" y="49.5" width="${w}" height="11" rx="5.5" style="fill:${tierC}"/>` +
    `<text x="32" y="58" text-anchor="middle" style="fill:${v('plate-ink')};font:800 8.4px Onest,system-ui,sans-serif">${num}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${a.title}">` +
    `<circle cx="32" cy="32" r="30" style="fill:${anti ? v('anti-glass') : v('glass')};stroke:${v('rim')};stroke-width:1"/>` +
    `<path d="M11.5 25.5A21.5 21.5 0 0 1 25.5 11.5" style="fill:none;stroke:${v('shine')};stroke-width:2.2;stroke-linecap:round"/>` +
    rim +
    `<g transform="translate(15.2 15.2) scale(1.4)" style="fill:none;stroke:${glyphC};stroke-width:var(--ach-sw, 2);stroke-linecap:round;stroke-linejoin:round">${glyph}</g>` +
    plate + '</svg>';
}

// ---------- CSS ----------
const decl = (t, links = {}) => Object.keys(t).filter((k) => k !== 'locked').map((k) => `  --ach-${k}: ${links[k] || t[k]};`).join('\n');
const lockedDecl = (t) => ['glyph', 'anti', 'tier-bronze', 'tier-silver', 'tier-gold', 'tier-platinum'].map((k) => `--ach-${k}: ${t.locked};`).join(' ') +
  ' --ach-glyph-soft: transparent; --ach-anti-soft: transparent; --ach-anti-glass: var(--ach-glass);';
const CSS = `/* Значки достижений 2.x — токены. Файл генерирует tools/achievements-icons.mjs, правки — там.
   Тема: data-theme="light"|"dark" на <html>; без атрибута (или data-theme="system") — по prefers-color-scheme. */
:root {
${decl(T.dark, DARK_LINKS)}
}
:root[data-theme="light"] {
${decl(T.light)}
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
${decl(T.light).replace(/^/gm, '  ')}
  }
}
.ach-icon { display: inline-block; width: var(--ach-size, 56px); height: var(--ach-size, 56px); flex: none; vertical-align: middle; }
/* Мелкий значок (24–32 px): штрих толще, ярлык с номером прячется — номер остаётся в подписи */
.ach-icon.ach-sm { --ach-sw: 2.6; --ach-plate-display: none; }
/* Закрыто: тот же значок, силуэт без цвета */
.ach-icon.is-locked { ${lockedDecl(T.dark)} opacity: .75; }
:root[data-theme="light"] .ach-icon.is-locked { ${lockedDecl(T.light)} }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .ach-icon.is-locked { ${lockedDecl(T.light)} } }
/* <img> не видит переменных страницы — только фильтр */
img.ach-icon.is-locked { filter: grayscale(1); opacity: .45; }
`;

// ---------- контраст ----------
const rgba = (s) => { if (s[0] === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(1); const m = s.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1]; };
const over = (top, bot) => { const [r, g, b, a] = rgba(top), [R, G2, B] = bot; return [r * a + R * (1 - a), g * a + G2 * (1 - a), b * a + B * (1 - a)]; };
const lum = (c) => { const l = c.map((x) => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * l[0] + .7152 * l[1] + .0722 * l[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const BACKDROPS = { dark: { 'фон': '#0A0C11', 'карточка': ['rgba(255,255,255,.06)', '#0A0C11'] }, light: { 'фон': '#F4F6FA', 'карточка': ['#FFFFFF', '#F4F6FA'] } };
function contrast() {
  const rows = []; let min = Infinity;
  for (const theme of ['dark', 'light']) {
    const t = T[theme];
    for (const [where, bd] of Object.entries(BACKDROPS[theme])) {
      const base = Array.isArray(bd) ? over(bd[0], rgba(bd[1])) : rgba(bd).slice(0, 3);
      const glass = over(t.glass, base), aglass = over(t['anti-glass'], base);
      const check = (what, fg, bg, need = 3) => { const r = ratio(rgba(fg).slice(0, 3), bg); rows.push({ theme, where, what, r: +r.toFixed(2), need }); if (need) min = Math.min(min, r / need); };
      check('глиф / стекло', t.glyph, glass);
      check('глиф / мягкая заливка', t.glyph, over(t['glyph-soft'], glass));
      check('анти-глиф / анти-стекло', t.anti, aglass);
      check('анти-глиф / анти-заливка', t.anti, over(t['anti-soft'], aglass));
      for (const k of ['bronze', 'silver', 'gold', 'platinum']) check('кант ' + k, t['tier-' + k], glass);
      for (const k of ['bronze', 'silver', 'gold', 'platinum']) check('номер на ярлыке ' + k, t['plate-ink'], rgba(t['tier-' + k]).slice(0, 3), 4.5);
      check('номер на ярлыке accent', t['plate-ink'], rgba(t.glyph).slice(0, 3), 4.5);
      check('закрыто: глиф / стекло (справочно)', t.locked, glass, 0);
    }
  }
  return { rows, ok: min >= 1 };
}

// ---------- превью ----------
const TIER_RU = { bronze: 'бронза', silver: 'серебро', gold: 'золото', platinum: 'платина', accent: 'акцент' };
const tierRu = (t) => TIER_RU[t] || 'анти · ур. ' + t.split('-')[1];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function preview(cr) {
  const sym = ALL.map((a) => svg(a, T.dark).replace(/^<svg[^>]*>/, `<symbol id="a-${a.code}" viewBox="0 0 64 64">`).replace(/<\/svg>$/, '</symbol>')).join('\n');
  const use = (a, size, extra = '') => `<svg class="ach-icon${extra}" style="--ach-size:${size}px" viewBox="0 0 64 64" aria-hidden="true"><use href="#a-${a.code}"/></svg>`;
  const card = (a) => `<article class="card"><div class="big">${use(a, 96)}</div><div class="meta"><h3>${esc(a.title)}</h3><p>${esc(a.about)}</p>` +
    `<div class="tags"><span>${tierRu(a.tier)}</span><code>${a.code}.svg</code></div><div class="sizes">${use(a, 48)}${use(a, 32, ' ach-sm')}${use(a, 24, ' ach-sm')}<small>48 · 32 · 24</small></div></div></article>`;
  const sections = CATS.map((c) => { const list = ALL.filter((a) => a.cat === c.id); return `<section><h2>${c.title} <span>${list.length}</span></h2><div class="grid">${list.map(card).join('')}</div></section>`; }).join('\n');
  const tierRow = ['bronze', 'silver', 'gold', 'platinum', 'accent', 'anti-4'].map((t) => `<figure>${use({ code: 'tier-' + t }, 72)}<figcaption>${tierRu(t)}</figcaption></figure>`).join('');
  const tierSyms = ['bronze', 'silver', 'gold', 'platinum', 'accent', 'anti-4'].map((t) => svg({ code: 'tier-' + t, tier: t, icon: 'streak', title: tierRu(t) }, T.dark).replace(/^<svg[^>]*>/, `<symbol id="a-tier-${t}" viewBox="0 0 64 64">`).replace(/<\/svg>$/, '</symbol>')).join('');
  const imgs = ALL.map((a) => `<img class="ach-icon" style="--ach-size:40px" alt="${esc(a.title)}" data-code="${a.code}" src="../../icons/achievements/${a.code}.svg">`).join('');
  const crRows = cr.rows.filter((r) => r.where === 'карточка').map((r) => `<tr><td>${r.theme === 'dark' ? 'тёмная' : 'светлая'}</td><td>${r.what}</td><td>${r.r}:1</td><td>${r.need ? (r.r >= r.need ? 'ok' : 'МАЛО') + ' (≥ ' + r.need + ')' : '—'}</td></tr>`).join('');
  return `<!doctype html>
<html lang="ru" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Значки достижений</title>
<!-- Файл генерирует tools/achievements-icons.mjs. Значки — инлайн (symbol), поэтому страница открывается и с диска. -->
<style>
@font-face { font-family: 'Onest'; font-weight: 400 800; src: url(../../fonts/Onest-cyrillic.woff2) format('woff2'); unicode-range: U+0400-045F; }
@font-face { font-family: 'Onest'; font-weight: 400 800; src: url(../../fonts/Onest-latin.woff2) format('woff2'); unicode-range: U+0000-00FF, U+2000-206F; }
:root { --bg: #0A0C11; --card: rgba(255,255,255,.06); --card-border: rgba(255,255,255,.10); --text: #F2F4F8; --muted: #9AA0AE; --lime: #C6F432; --lime-ink: #0A0C11; color-scheme: dark; }
:root[data-theme="light"] { --bg: #F4F6FA; --card: #FFFFFF; --card-border: rgba(18,21,28,.10); --text: #12151C; --muted: #5B6270; --lime: #4A6B00; --lime-ink: #FFFFFF; color-scheme: light; }
${CSS}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 Onest, system-ui, sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
h1 { font-size: 26px; margin: 0; letter-spacing: -.01em; }
.lead { color: var(--muted); margin: 4px 0 20px; max-width: 70ch; }
.seg { display: inline-flex; padding: 3px; gap: 3px; border-radius: 999px; background: var(--card); border: 1px solid var(--card-border); }
.seg button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 8px 14px; min-height: 40px; background: transparent; color: var(--muted); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--lime); color: var(--lime-ink); }
.seg button:focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
.controls { display: flex; gap: 10px; flex-wrap: wrap; }
h2 { font-size: 19px; margin: 32px 0 12px; } h2 span { color: var(--muted); font-weight: 500; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; }
.card, .panel { background: var(--card); border: 1px solid var(--card-border); border-radius: 20px; backdrop-filter: blur(16px); }
.card { display: flex; gap: 14px; padding: 14px; }
.big { flex: none; }
.meta { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
h3 { font-size: 15px; margin: 0; } .meta p { margin: 0; color: var(--muted); font-size: 13px; }
.tags { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.tags span { padding: 1px 8px; border-radius: 999px; border: 1px solid var(--card-border); }
code { font: 12px ui-monospace, Consolas, monospace; }
.sizes { display: flex; gap: 10px; align-items: center; margin-top: auto; padding-top: 6px; }
.sizes small { color: var(--muted); font-size: 11px; }
.panel { padding: 16px; }
.tiers { display: flex; gap: 18px; flex-wrap: wrap; } figure { margin: 0; text-align: center; } figcaption { font-size: 13px; color: var(--muted); }
.imgs { display: flex; flex-wrap: wrap; gap: 8px; }
table { border-collapse: collapse; font-size: 13px; width: 100%; } td { padding: 4px 8px; border-top: 1px solid var(--card-border); } td:nth-child(3) { font-variant-numeric: tabular-nums; }
details summary { cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
${sym}
${tierSyms}
</svg>
<main>
<header>
  <h1>Значки достижений · превью</h1>
  <div class="controls">
    <div class="seg" role="group" aria-label="Тема"><button data-theme-btn="dark" aria-pressed="true">Тёмная</button><button data-theme-btn="light" aria-pressed="false">Светлая</button></div>
    <div class="seg" role="group" aria-label="Состояние"><button data-lock-btn="0" aria-pressed="true">Получено</button><button data-lock-btn="1" aria-pressed="false">Закрыто</button></div>
  </div>
</header>
<p class="lead">${ALL.length} значков: ${ACHIEVEMENTS.length} из achievements.js и ${PROPOSED.length} предложенных. Сетка 64, стекло, глиф лаймом, тир читается по канту: бронза — один кант, серебро — двойной, золото — двойной с заклёпками, платина — плюс камень сверху, акцент — кант с искрой, анти — рваный кант кораллом.</p>
<div class="panel"><div class="tiers">${tierRow}</div></div>
${sections}
<h2>Файлы для &lt;img&gt; <span>(icons/achievements/${'{'}code${'}'}.svg и light/)</span></h2>
<div class="panel"><div class="imgs">${imgs}</div></div>
<h2>Контраст <span>(на карточке)</span></h2>
<div class="panel"><table>${crRows}</table></div>
</main>
<script>
const ACHIEVEMENTS = ${JSON.stringify(ALL.map(({ code, cat, tier, title, about, need, rank }) => ({ code, cat, tier, title, about, need, rank })))};
const root = document.documentElement;
function setTheme(t) {
  root.setAttribute('data-theme', t);
  document.querySelectorAll('[data-theme-btn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeBtn === t)));
  document.querySelectorAll('img[data-code]').forEach((i) => { i.src = '../../icons/achievements/' + (t === 'light' ? 'light/' : '') + i.dataset.code + '.svg'; });
}
function setLocked(on) {
  document.querySelectorAll('.ach-icon').forEach((i) => i.classList.toggle('is-locked', on));
  document.querySelectorAll('[data-lock-btn]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.lockBtn === '1') === on)));
}
document.querySelectorAll('[data-theme-btn]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeBtn)));
document.querySelectorAll('[data-lock-btn]').forEach((b) => b.addEventListener('click', () => setLocked(b.dataset.lockBtn === '1')));
const q = new URLSearchParams(location.search);
if (q.get('theme')) setTheme(q.get('theme'));
if (q.get('locked') === '1') setLocked(true);
</script>
</body>
</html>
`;
}

// ---------- запись ----------
const missing = ALL.filter((a) => !G[a.icon]).map((a) => a.code);
if (missing.length) throw new Error('нет глифа: ' + missing.join(', '));
mkdirSync('icons/achievements/light', { recursive: true });
mkdirSync('docs/previews', { recursive: true });
for (const a of ALL) {
  writeFileSync(`icons/achievements/${a.code}.svg`, svg(a, T.dark) + '\n');
  writeFileSync(`icons/achievements/light/${a.code}.svg`, svg(a, T.light) + '\n');
}
writeFileSync('icons/achievements/achievements-icons.css', CSS);
const symbol = (a) => svg(a, T.dark).replace(/^<svg[^>]*>/, `<symbol id="a-${a.code}" viewBox="0 0 64 64">`).replace(/<\/svg>$/, '</symbol>');
writeFileSync('icons/achievements/sprite.svg', ['<svg xmlns="http://www.w3.org/2000/svg">', ...ACHIEVEMENTS.map(symbol), '</svg>', ''].join('\n'));   // предложенных значков (PROPOSED) в кабинете пока нет
const cr = contrast();
writeFileSync('docs/previews/achievements-icons.html', preview(cr));
console.table(cr.rows.map((r) => ({ тема: r.theme, где: r.where, что: r.what, контраст: r.r, нужно: r.need || '—' })));
console.log(`значков: ${ALL.length} (${ACHIEVEMENTS.length} + ${PROPOSED.length} предложено)`);
if (!cr.ok) { console.error('КОНТРАСТ НИЖЕ НОРМЫ'); process.exit(1); }
