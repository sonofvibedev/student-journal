// Код сброса пароля (supabase/functions/_shared/reset.ts): формат, алфавит без похожих знаков, разбор ввода.
import assert from 'node:assert/strict';
import { newResetCode, normResetCode, RESET_CODE_RE, RESET_ALPHABET } from '../../supabase/functions/_shared/reset.ts';

assert.ok(!/[01OIL]/.test(RESET_ALPHABET), 'в алфавите нет 0/O/1/I/L');
const seen = new Set();
for (let i = 0; i < 2000; i++) {
  const { raw, shown } = newResetCode();
  assert.match(shown, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, 'вид ABCDE-23456');
  assert.ok(RESET_CODE_RE.test(raw), `raw из алфавита: ${raw}`);
  assert.equal(normResetCode(shown), raw, 'показанный код разбирается обратно');
  seen.add(raw);
}
assert.equal(seen.size, 2000, 'коды не повторяются');
for (const ch of RESET_ALPHABET) assert.ok([...seen].some((c) => c.includes(ch)), `знак ${ch} встречается`);

assert.equal(normResetCode(' abcde-23456 '), 'ABCDE23456', 'регистр, пробелы, дефис');
assert.equal(normResetCode('ab cd e2 34 56'), 'ABCDE23456', 'пробелы внутри');
assert.equal(normResetCode(null), '', 'пустой ввод');
assert.ok(!RESET_CODE_RE.test('ABCDE2345'), '9 знаков');
assert.ok(!RESET_CODE_RE.test('ABCDE234567'), '11 знаков');
assert.ok(!RESET_CODE_RE.test('ABCDE2345O'), 'буква O');
assert.ok(!RESET_CODE_RE.test('ABCDE23451'), 'цифра 1');
console.log('password-reset: ok');
