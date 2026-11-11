// Модульный тест offline-queue.js (Node, без сети): очередь, отправка без дублей, обрыв связи, отказ сервера.
//   node tests/unit/offline-queue.mjs
import assert from 'node:assert/strict';


const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
await import('../../offline-queue.js');   // скрипт браузера: кладёт себя в globalThis.OQ
const OQ = globalThis.OQ;
OQ.DELAYS = [];   // здесь повторы выключены: проверяем саму очередь; повторы и пачки — в v203.mjs

const results = [];
async function t(name, fn) {
  try { await fn(); results.push([name, true]); console.log('OK     ' + name); }
  catch (e) { results.push([name, false]); console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); }
}

// Подделка Supabase: absences в памяти, ответ upsert настраивается
function fakeSb() {
  const db = { rows: [], upserts: 0, failNext: null };
  const chain = (rows) => { const c = { eq: () => c, then: (f) => f({ data: rows, error: null }) }; return c; };
  return {
    db,
    from: () => ({
      select: () => chain(db.rows.map((r) => ({ student_id: r.student_id, subject: r.subject }))),
      upsert: (rows) => {
        db.upserts++;
        if (db.failNext) { const e = db.failNext; db.failNext = null; return Promise.resolve({ error: e }); }
        rows.forEach((r) => { if (!db.rows.some((x) => x.id === r.id)) db.rows.push(r); });
        return Promise.resolve({ error: null });
      },
    }),
  };
}
const row = (n, over = {}) => ({ id: 'ab-' + n, group_id: 'g1', student_id: 's' + n, date: '2026-11-05', subject: 'Статистика', hours: 2, lesson_kind: 'lecture', ...over });

await t('newId: префикс ab- и уникальность', () => {
  const a = OQ.newId(), b = OQ.newId();
  assert.match(a, /^ab-[0-9a-f]{32}$/); assert.notEqual(a, b);
});
await t('add: сохраняет в очередь пользователя, повтор того же id не дублирует', () => {
  mem.clear();
  assert.equal(OQ.add('u1', [row(1), row(2)]), 2);
  assert.equal(OQ.add('u1', [row(2), row(3)]), 1);
  assert.equal(OQ.count('u1'), 3); assert.equal(OQ.count('u2'), 0);
});
await t('pending: часы по предмету и дню без учёта регистра', () => {
  const m = OQ.pending('u1', 'g1', '2026-11-05', ' статистика ');
  assert.equal(m.size, 3); assert.equal(m.get('s1'), 2);
  assert.equal(OQ.pending('u1', 'g1', '2026-11-06', 'Статистика').size, 0);
});
await t('flush: всё уходит, очередь пуста, created_at из очереди', async () => {
  const sb = fakeSb();
  const r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.dropped, r.left, r.net], [3, 0, 0, false]);
  assert.equal(sb.db.rows.length, 3); assert.ok(sb.db.rows.every((x) => x.created_at && x.is_excused === false && !('uid' in x) && !('at' in x)));
});
await t('flush: пустая очередь — нет запросов', async () => {
  const sb = fakeSb(); const r = await OQ.flush(sb, 'u1');
  assert.equal(sb.db.upserts, 0); assert.equal(r.sent, 0);
});
await t('flush: уже внесённое на сервере (другое устройство) пропускается, не дублируется', async () => {
  mem.clear(); const sb = fakeSb();
  sb.db.rows.push({ id: 'ab-other', student_id: 's1', subject: 'статистика' });
  OQ.add('u1', [row(1), row(2)]);
  const r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.dropped, r.left], [1, 1, 0]); assert.equal(sb.db.rows.length, 2);
});
await t('flush: обрыв связи — очередь цела, потом уходит без дублей (даже если первая отправка дошла)', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', [row(1), row(2)]);
  sb.db.failNext = { message: 'TypeError: Failed to fetch' };
  let r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.left, r.net], [0, 2, true]);
  sb.db.rows.push(row(1));   // ответ потерян, но запись на сервере уже есть (тот же id)
  r = await OQ.flush(sb, 'u1');
  assert.equal(r.left, 0); assert.equal(sb.db.rows.filter((x) => x.id === 'ab-1').length, 1);
});
await t('flush: отказ сервера (журнал закрыт, 42501) — пачка снимается, не зацикливается', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', [row(1), row(2)]);
  sb.db.failNext = { code: '42501', message: 'row-level security' };
  const r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.dropped, r.left, r.error], [0, 2, 0, '42501']);
});
await t('flush: неизвестная ошибка сервера — очередь остаётся, повторим позже', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', [row(1)]);
  sb.db.failNext = { code: '500', message: 'boom' };
  const r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.left, r.net], [0, 1, false]); assert.equal(r.error, '500');
});
await t('flush: две отправки сразу — одна реальная (без гонки)', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', [row(1), row(2)]);
  const [a, b] = await Promise.all([OQ.flush(sb, 'u1'), OQ.flush(sb, 'u1')]);
  assert.equal(a, b); assert.equal(sb.db.rows.length, 2); assert.equal(sb.db.upserts, 1);
});
await t('flush: чужая очередь не трогается', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', [row(1)]); OQ.add('u2', [row(2)]);
  await OQ.flush(sb, 'u1');
  assert.equal(OQ.count('u2'), 1); assert.equal(sb.db.rows.length, 1);
});
await t('flush: большая очередь уходит пачками по OQ.CHUNK', async () => {
  mem.clear(); const sb = fakeSb();
  OQ.add('u1', Array.from({ length: 230 }, (_, i) => row(i + 1)));
  const r = await OQ.flush(sb, 'u1');
  assert.deepEqual([r.sent, r.left], [230, 0]); assert.equal(sb.db.upserts, Math.ceil(230 / OQ.CHUNK));
});
await t('isNetError / isPermanent', () => {
  assert.ok(OQ.isNetError(new Error('Load failed'))); assert.ok(!OQ.isNetError(new Error('duplicate key')));
  assert.ok(OQ.isPermanent({ code: '42501' })); assert.ok(!OQ.isPermanent({ code: '500' })); assert.ok(!OQ.isPermanent(null));
});
await t('битое хранилище не роняет модуль', () => {
  mem.set('j2.oq.v1', '{не json'); assert.equal(OQ.count('u1'), 0); assert.equal(OQ.add('u1', [row(9)]), 1);
});

const bad = results.filter((r) => !r[1]).length;
console.log(bad ? `\nПровалов: ${bad}` : '\nВсё хорошо');
process.exit(bad ? 1 : 0);
