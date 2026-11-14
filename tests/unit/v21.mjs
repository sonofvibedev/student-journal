// Модульные проверки 2.1: светлая тема (контраст палитры и семантических цветов по WCAG AA), 5 акцентов × 2 темы.
// Запуск: node tests/unit/v21.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('OK    ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e.message || e)); } };
const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

const ctx = { localStorage: { length: 0, key: () => null, getItem: () => null } }; ctx.window = ctx; ctx.globalThis = ctx;
vm.runInNewContext(read('accent.js'), ctx);
const A = ctx.J2Accent;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));

// токены светлой темы из j2.css
const css = read('j2.css'), light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)[1];
const tok = (n) => { const m = new RegExp('--' + n + ':\\s*(#[0-9A-Fa-f]{6})').exec(light); assert.ok(m, 'нет токена ' + n); return rgb(m[1]); };

await t('светлая тема: токены определены в j2.css, есть переключатель по data-theme', () => {
  assert.ok(/:root\[data-theme="light"\]/.test(css));
  for (const n of ['j-text', 'j-muted', 'j-amber', 'j-coral', 'j-mint', 'j-violet', 'j-blue-t', 'j-pink-t', 'j-ok', 'j-warn', 'j-bad']) tok(n);
});
await t('светлая палитра: пять акцентов, у каждого светлый фон, белые шторки, акцент-текст темнее акцента', () => {
  for (const [hex] of A.ACCENTS) {
    const p = A.palette(hex, 'light');
    assert.equal(p.sheet, '#FFFFFF'); assert.ok(lum(rgb(p.accentText)) < lum(rgb(p.accent)) + 1e-9, hex); assert.ok(lum(p.bgRgb.split(',').map(Number)) > 0.8, 'фон светлый ' + hex);
  }
});
await t('контраст WCAG AA в светлой теме для всех акцентов: акцент как текст, текст, приглушённый текст — на фоне и на карточке', () => {
  for (const [hex] of A.ACCENTS) {
    const p = A.palette(hex, 'light'), bg = p.bgRgb.split(',').map(Number), card = over([255, 255, 255], bg, 0.78);
    assert.ok(cr(rgb(p.accentText), bg) >= 4.5, `акцент-текст ${hex}: ${cr(rgb(p.accentText), bg).toFixed(2)}`);
    for (const [n, min] of [['j-text', 7], ['j-muted', 4.5]]) { assert.ok(cr(tok(n), bg) >= min, `${n} на фоне ${hex}`); assert.ok(cr(tok(n), card) >= min, `${n} на карточке ${hex}`); }
    assert.ok(cr(rgb(p.ink), rgb(p.accent)) >= 4.5, `текст на акценте ${hex}: ${cr(rgb(p.ink), rgb(p.accent)).toFixed(2)}`);
  }
});
await t('контраст WCAG AA в светлой теме: цвета статусов (текст на фоне страницы и на карточке)', () => {
  for (const [hex] of A.ACCENTS) {
    const p = A.palette(hex, 'light'), bg = p.bgRgb.split(',').map(Number), card = over([255, 255, 255], bg, 0.78);
    for (const n of ['j-amber', 'j-coral', 'j-mint', 'j-violet', 'j-blue-t', 'j-pink-t', 'j-bad', 'j-ok', 'j-warn']) {
      assert.ok(cr(tok(n), bg) >= 3, `${n} на фоне ${hex}: ${cr(tok(n), bg).toFixed(2)}`);      // ok/warn/bad — крупные числа и кольцо (3:1), остальные ниже проверяются 4.5
    }
    for (const n of ['j-amber', 'j-coral', 'j-mint', 'j-violet', 'j-blue-t', 'j-pink-t']) assert.ok(cr(tok(n), card) >= 4.5, `${n} (текст) на карточке ${hex}: ${cr(tok(n), card).toFixed(2)}`);
  }
});
await t('тёмная палитра не изменилась (лайм = значения j2.css)', () => {
  const p = A.palette('#C6F432', 'dark'); assert.equal(p.bg, '#0A0C11'); assert.equal(p.accentText, '#C6F432');
  assert.equal(JSON.stringify(A.palette('#C6F432')), JSON.stringify(p));
});
await t('themeNow: явный выбор главнее, «Авто» следует за prefers-color-scheme', () => {
  const mk = (light) => { const w = { matchMedia: () => ({ matches: light }), localStorage: { length: 0, key: () => null, getItem: () => null } }; w.window = w; w.globalThis = w; vm.runInNewContext(read('accent.js'), w); return w.J2Accent; };
  assert.equal(mk(true).themeNow('auto'), 'light'); assert.equal(mk(false).themeNow('auto'), 'dark');
  assert.equal(mk(true).themeNow('dark'), 'dark'); assert.equal(mk(false).themeNow('light'), 'light');
});
console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
