// Проверка замка Mini App (tg-gate.js): node tools/test-tg-gate.js
'use strict';
const assert = require('assert');
const { tgGateAllowed, inTelegram } = require('../tg-gate.js');

const KEY = 'abc123';
let n = 0;
function ok(name, fn) { fn(); n++; console.log('  ok  ' + name); }

ok('замок выключен (ключ пуст) — пускает всех', () => {
  assert.strictEqual(tgGateAllowed('', true, '', ''), true);
});
ok('обычный браузер и PWA без Telegram — пускает без ключа', () => {
  assert.strictEqual(tgGateAllowed(KEY, false, '', ''), true);
});
ok('Telegram, старый адрес без ключа — 404', () => {
  assert.strictEqual(tgGateAllowed(KEY, true, '', ''), false);
});
ok('Telegram, чужой ключ — 404', () => {
  assert.strictEqual(tgGateAllowed(KEY, true, '?b=other', ''), false);
});
ok('Telegram, правильный ключ в адресе — пускает', () => {
  assert.strictEqual(tgGateAllowed(KEY, true, '?b=' + KEY, ''), true);
  assert.strictEqual(tgGateAllowed(KEY, true, '?x=1&b=' + KEY, ''), true);
});
ok('Telegram, ключ запомнен в сессии окна (переход без ?b=) — пускает', () => {
  assert.strictEqual(tgGateAllowed(KEY, true, '', KEY), true);
});
ok('запомненный чужой ключ не пускает', () => {
  assert.strictEqual(tgGateAllowed(KEY, true, '', 'other'), false);
});
ok('определение Telegram: hash, sessionStorage Telegram или initData', () => {
  assert.strictEqual(inTelegram('#tgWebAppData=query_id%3DAA', '', ''), true);
  assert.strictEqual(inTelegram('', '{"tgWebAppData":"x"}', ''), true);
  assert.strictEqual(inTelegram('', '', 'query_id=AA'), true);
  assert.strictEqual(inTelegram('#home', '', ''), false);
  assert.strictEqual(inTelegram(undefined, undefined, undefined), false);
});

console.log('\nПроверок пройдено: ' + n);
