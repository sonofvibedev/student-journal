// Чистая логика утилиты сисадмина: очистка от секретов, обрезка, доступность и перцентили, пороги, сводка, пути копий, пароль. Без сети и без Deno.
// Запуск: node tests/unit/ops.mjs   (Node 22.6+ читает .ts без сборки)
import {
  stripSecrets, cleanField, LIM, availabilityPct, percentile, topCounts, alertReasons, dueSince, buildDigest,
  backupPath, validEmail, genPassword, PASSWORD_ALPHABET, PASSWORD_LEN,
} from '../../supabase/functions/_shared/ops-text.ts';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };

// ---------- очистка ----------
const hex = 'a'.repeat(31) + 'b' + '0123456789abcdef';
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const bot = 'https://api.telegram.org/bot123456789:AAEhBP0av28ZqDjwNQxRkbDIdLXq7jYk0aw/getMe';
check('Bearer', !/abc123/.test(stripSecrets('fetch failed, Authorization: Bearer abc123.def')) && stripSecrets('x Bearer abc123').includes('Bearer [скрыто]'));
check('access_token=', !stripSecrets('GET /cb?access_token=SECRET123&x=1').includes('SECRET123') && !stripSecrets('access_token: "SECRET123"').includes('SECRET123'));
check('JWT', !stripSecrets(`token ${jwt} end`).includes('eyJ') && stripSecrets(`got ${jwt}`).includes('[jwt]'));
check('hex 32+', !stripSecrets(`key ${hex}`).includes('aaaaaaaa') && stripSecrets('hash ' + 'f'.repeat(40)) === 'hash [hex]');
check('hex короче 32 не трогаем', stripSecrets('id deadbeef12345678') === 'id deadbeef12345678');
check('base64 32+ с цифрой', stripSecrets('k=' + 'Xy3'.repeat(15)).includes('[скрыто]') && !stripSecrets('x ' + 'Zq9/'.repeat(12)).includes('Zq9/Zq9/'));
check('длинный путь без цифр жив', stripSecrets('at supabase/functions/_shared/common.ts failed').includes('supabase/functions/_shared/common.ts'));
check('строка запроса и фрагмент URL', stripSecrets('open https://x.by/app.html?a=1&b=2#/profile now') === 'open https://x.by/app.html now');
check('запрос у относительного адреса', stripSecrets('error in /app.html?room=5 line 3') === 'error in /app.html line 3');
check('токен бота в тексте fetch', !stripSecrets(`error sending request for url (${bot})`).includes('AAEhBP0'));
check('обычное сообщение цело', stripSecrets('TypeError: x is undefined at app.js:12:5') === 'TypeError: x is undefined at app.js:12:5');
check('null и число', stripSecrets(null) === '' && stripSecrets(42) === '42');
check('cleanField режет по лимиту уже после очистки', cleanField('w'.repeat(500), LIM.message).length === 300 && cleanField(`Bearer ${'z'.repeat(400)}`, 20) === 'Bearer [скрыто]');

// ---------- доступность и время ----------
check('доступность', availabilityPct([{ ok: true }, { ok: true }, { ok: false }, { ok: true }]) === 75 && availabilityPct([]) === null);
check('доступность округляется до десятых', availabilityPct([{ ok: true }, { ok: false }, { ok: false }]) === 33.3);
check('p95 по 20 значениям', percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95) === 19);
check('p50 и порядок не важен', percentile([5, 1, 3], 50) === 3 && percentile([], 95) === null && percentile([7], 95) === 7);
check('percentile игнорирует NaN', percentile([NaN, 4, 2], 100) === 4);
const top = topCounts(['b', 'a', 'b', null, 'c', 'a', 'b'], 3);
check('топ ошибок', top.length === 3 && top[0].name === 'b' && top[0].count === 3 && top[1].name === 'a' && top[1].count === 2);

// ---------- пороги и «раз в час» ----------
const LIMS = { errors: 20, availabilityMin: 80, minPings: 3 };
const pings = (ok, bad) => [...Array(ok).fill({ ok: true }), ...Array(bad).fill({ ok: false })];
check('порог ошибок: 19 нет, 20 да', !alertReasons(19, [], LIMS).length && alertReasons(20, [], LIMS).length === 1);
check('доступность: 3 из 4 = 75% → сбой', alertReasons(0, pings(3, 1), LIMS).length === 1);
check('доступность ровно 80% не сбой', !alertReasons(0, pings(4, 1), LIMS).length);
check('меньше 3 проверок не считаем', !alertReasons(0, pings(0, 2), LIMS).length);
check('обе причины, только числа', (() => { const r = alertReasons(25, pings(1, 3), LIMS); return r.length === 2 && r[0].includes('25') && r[1].includes('25%'); })());
const now = Date.parse('2026-11-09T10:00:00Z');
check('dueSince: нет отметки, свежая, старая', dueSince(undefined, now, 3.6e6) && !dueSince('2026-11-09T09:30:00Z', now, 3.6e6) && dueSince('2026-11-09T08:59:00Z', now, 3.6e6) && dueSince('мусор', now, 3.6e6));

// ---------- сводка ----------
const base = { hours: 24, availability_pct: 99.3, pings: 576, resp_p95_ms: 180, client_errors: 12, server_errors: 2,
  top_errors: [{ name: 'TypeError', count: 7 }, { name: 'page', count: 3 }, { name: 'api', count: 2 }, { name: 'x', count: 1 }],
  import_failures: [{ name: 'ФК-21', status: 'bseu_unavailable' }], pending_requests: 3,
  backup_last: { at: '2026-11-09T00:30:12.000Z', status: 'ok', size_bytes: 2_621_440 } };
const text = buildDigest(base);
check('сводка: числа', text.includes('99.3%') && text.includes('180 мс') && text.includes('браузер 12, сервер 2') && text.includes('Заявок на рассмотрении: 3'));
check('сводка: топ-3 без четвёртой', text.includes('• TypeError: 7') && text.includes('• api: 2') && !text.includes('• x: 1'));
check('сводка: группа с кодом и копия', text.includes('ФК-21 (bseu_unavailable)') && text.includes('успешно') && text.includes('2.5 МБ'));
const empty = buildDigest({ ...base, availability_pct: null, resp_p95_ms: null, top_errors: [], import_failures: [], backup_last: null });
check('сводка: пусто', empty.includes('Доступность: нет данных') && empty.includes('Сбоев импорта расписания нет') && empty.includes('ещё не было') && !empty.includes('Частые'));
check('сводка: сбой копии', buildDigest({ ...base, backup_last: { at: '2026-11-09T00:30:12.000Z', status: 'failed' } }).includes('СБОЙ'));

// ---------- копии ----------
check('путь копии', backupPath(new Date('2026-11-09T00:30:07Z'), 'nightly') === '2026-11-09/003007-nightly.json.gz' && backupPath(new Date('2026-01-02T13:05:09Z'), 'manual') === '2026-01-02/130509-manual.json.gz');

// ---------- почта и пароль ----------
check('почта', validEmail('a.b@mail.by') && !validEmail('a@b') && !validEmail('a b@mail.by') && !validEmail('@mail.by') && !validEmail('a@@mail.by') && !validEmail('a@mail..by'));
check('алфавит без похожих знаков', !/[IOilo01]/.test(PASSWORD_ALPHABET) && new Set(PASSWORD_ALPHABET).size === PASSWORD_ALPHABET.length);
const pw = Array.from({ length: 300 }, () => genPassword());
check('пароль 16 знаков из алфавита', pw.every((p) => p.length === PASSWORD_LEN && [...p].every((c) => PASSWORD_ALPHABET.includes(c))));
check('пароли различаются', new Set(pw).size === pw.length);
const seen = new Set(pw.join(''));
check('используется весь алфавит', seen.size >= PASSWORD_ALPHABET.length - 3, String(seen.size));

console.log(failed ? `\nПровалов: ${failed}` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
