// Проверка подписи initData (supabase/functions/_shared/tginit.ts): неверная подпись, старые данные, подмена пользователя.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifiedTelegramId } from '../../supabase/functions/_shared/tginit.ts';

const BOT = '123456:TEST-TOKEN';
const NOW = 1_800_000_000;
function sign(fields, token = BOT) {
  const p = new URLSearchParams(fields);
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const user = (id) => JSON.stringify({ id, first_name: 'Тест' });
const ok = sign({ auth_date: String(NOW - 60), user: user(777), query_id: 'q' });

assert.equal(await verifiedTelegramId(ok, BOT, NOW), 777, 'верная подпись');
assert.equal(await verifiedTelegramId(ok, 'other:TOKEN', NOW), null, 'чужой токен бота');
assert.equal(await verifiedTelegramId(ok.replace('777', '778'), BOT, NOW), null, 'подмена пользователя');
assert.equal(await verifiedTelegramId(ok.replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)), BOT, NOW), null, 'неверный hash');
assert.equal(await verifiedTelegramId(new URLSearchParams({ auth_date: String(NOW), user: user(1) }).toString(), BOT, NOW), null, 'без hash');
assert.equal(await verifiedTelegramId(sign({ auth_date: String(NOW - 3601), user: user(777) }), BOT, NOW), null, 'старше часа');
assert.equal(await verifiedTelegramId(sign({ auth_date: String(NOW + 3601), user: user(777) }), BOT, NOW), null, 'из будущего');
assert.equal(await verifiedTelegramId(sign({ auth_date: String(NOW), user: 'не json' }), BOT, NOW), null, 'user не JSON');
assert.equal(await verifiedTelegramId(sign({ auth_date: String(NOW), user: user(-5) }), BOT, NOW), null, 'id не положительный');
assert.equal(await verifiedTelegramId(sign({ user: user(777) }), BOT, NOW), null, 'без auth_date');
console.log('tg-init: ok');
