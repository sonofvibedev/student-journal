// Миграция 20261122100000 (чат без пароля) на Postgres в памяти (PGlite) + настоящий chat-crypto.js поверх настоящих RPC.
// Тестового стенда нет, поэтому база — заглушки (auth.uid(), группы, членства, назначения) и чатовые части этапа 4
// (разделы 1–2 и 5 файла 20261108100000), затем up → сценарий → down → up.
//   node tests/db/chat-devices-pglite.mjs   (нужен @electric-sql/pglite в node_modules; нет — тест пропускается)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch (_) { console.log('ПРОПУСК: нет @electric-sql/pglite'); process.exit(0); }

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const stage4 = read('supabase/migrations/20261108100000_journal2_teachers_chat.sql');
const cut = (from, to) => stage4.slice(stage4.indexOf(from), to ? stage4.indexOf(to) : undefined);
const UP = read('supabase/migrations/20261122100000_journal21_chat_devices.sql');
const DOWN = read('supabase/migrations_down/20261122100000_journal21_chat_devices.down.sql');

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.groups (id uuid primary key, name text);
  create table public.memberships (user_id uuid, group_id uuid, student_id uuid, base_role text, extra_role text, status text, primary key (user_id, group_id));
  create table public.teacher_assignments (user_id uuid, group_id uuid, subject text, lesson_kind text);
  create table public.audit_log (id bigint generated always as identity, actor uuid, group_id uuid, action text, details jsonb, at timestamptz default now());
  create table public.notifications (id bigint generated always as identity, user_id uuid, group_id uuid, kind text, title text, body text, ref jsonb, dedupe_key text, read_at timestamptz, unique (user_id, dedupe_key));
  create function public.app_open() returns boolean language sql stable as $$ select true $$;
  create function public.group_open(uuid) returns boolean language sql stable as $$ select true $$;
`);
await db.exec(cut('-- 1. Таблицы', '-- 3. Политики').replace(/^[^\n]*\n/, ''));
await db.exec(cut('-- 5. RPC чата', '-- 6. Сводка').replace(/^[^\n]*\n/, '').replace(/-- =+\s*$/, ''));

const G = '00000000-0000-4000-8000-000000000024';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '44444444-4444-4444-8444-444444444444';
const TH = '33333333-3333-4333-8333-333333333333';
await db.exec(`
  insert into auth.users values ('${A}'), ('${B}'), ('${C}');
  insert into public.groups values ('${G}', '24ДММ-2');
  insert into public.memberships values ('${A}', '${G}', null, 'student', 'headman', 'active'), ('${B}', '${G}', null, 'teacher_lecture', null, 'active'),
                                        ('${C}', '${G}', null, 'student', null, 'active');
  insert into public.teacher_assignments values ('${B}', '${G}', 'Эконометрика', 'lecture');
  insert into public.chat_threads (id, group_id, student_user_id, teacher_user_id, kind) values ('${TH}', '${G}', '${A}', '${B}', 'lecture');
  -- сообщение прежней схемы (версии ключей) переживает up и down
  insert into public.chat_messages (thread_id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext)
    values ('${TH}', '${A}', 1, 1, 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAA');
`);
await db.exec(UP);

const results = [];
async function t(name, fn) {
  try { await fn(); results.push(true); console.log('OK     ' + name); }
  catch (e) { results.push(false); console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); }
}
const TYPES = { p_thread: 'uuid', p_device: 'uuid', p_epoch: 'int', p_wraps: 'jsonb', p_public_jwk: 'jsonb', p_iv: 'text', p_ciphertext: 'text', p_group: 'uuid', p_teacher: 'uuid' };
async function call(uid, name, args = {}) {
  const keys = Object.keys(args);
  const sql = `select to_jsonb(public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k]}`).join(', ')})) as r`;
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  try {
    const r = await db.query(sql, keys.map((k) => (TYPES[k] === 'jsonb' ? JSON.stringify(args[k]) : args[k])));
    return { data: r.rows[0].r, error: null };
  } catch (e) { return { data: null, error: { message: e.message } }; }
}
const sbFor = (uid) => ({ rpc: (n, a) => call(uid, n, a) });
const store = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } }; };
const load = async (tag) => { await import(new URL(`../../chat-crypto.js?pg-${tag}`, import.meta.url).href); return globalThis.ChatCrypto; };
const msgs = async () => (await db.query(`select * from public.chat_messages where thread_id = $1 and key_epoch is not null order by created_at`, [TH])).rows;
async function post(Cc, uid, text) {
  const e = await Cc.encrypt(TH, text);
  const r = await call(uid, 'chat_post', { p_thread: TH, p_device: e.device, p_epoch: e.epoch, p_iv: e.iv, p_ciphertext: e.ciphertext });
  if (r.error) throw new Error(r.error.message);
  return (await db.query(`select * from public.chat_messages where id = $1`, [r.data])).rows[0];
}

const CA = await load('a'), CB = await load('b');
let m1;
await t('устройства регистрируются сами; студент без роли старосты — forbidden; закрытой части в базе нет', async () => {
  assert.equal((await CA.init(sbFor(A), A, { storage: store() })).state, 'ready');
  assert.equal((await CB.init(sbFor(B), B, { storage: store() })).state, 'ready');
  const r = await call(C, 'chat_device_register', { p_public_jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) } });
  assert.equal(r.error && r.error.message, 'forbidden');
  const d = (await db.query(`select public_jwk from public.chat_devices`)).rows;
  assert.equal(d.length, 2); assert.ok(d.every((x) => !('d' in x.public_jwk)));
});
await t('оба открыли → эпоха 1, обмен сообщениями через chat_post; в базе нет текста', async () => {
  assert.equal((await CA.open(TH)).status, 'ready');
  const ob = await CB.open(TH);
  assert.equal(ob.status, 'ready'); assert.equal(ob.epoch, 1);
  m1 = await post(CA, A, 'Перенос пары на 10:00');
  assert.equal(await CB.decrypt(TH, m1), 'Перенос пары на 10:00');
  assert.equal(await CA.decrypt(TH, await post(CB, B, 'Принято')), 'Принято');
  const dump = JSON.stringify((await db.query(`select * from public.chat_messages`)).rows) + JSON.stringify((await db.query(`select * from public.chat_thread_keys`)).rows);
  assert.ok(!/Перенос|Принято/.test(dump));
  assert.equal((await db.query(`select count(*)::int n from public.notifications where kind = 'chat'`)).rows[0].n, 2);
});
await t('чужой (не участник) — forbidden на state, post, wraps', async () => {
  for (const [n, a] of [['chat_thread_state', { p_thread: TH, p_device: m1.sender_device }], ['chat_wraps_add', { p_thread: TH, p_device: m1.sender_device, p_wraps: [] }],
    ['chat_post', { p_thread: TH, p_device: m1.sender_device, p_epoch: 1, p_iv: m1.iv, p_ciphertext: m1.ciphertext }]]) {
    assert.equal((await call(C, n, a)).error?.message, 'forbidden', n);
  }
  assert.equal((await call(B, 'chat_thread_state', { p_thread: TH, p_device: m1.sender_device })).error?.message, 'forbidden', 'чужое устройство');
});
await t('клиент не читает и не пишет новые таблицы напрямую', async () => {
  await db.exec(`set role authenticated`);
  try {
    for (const q of [`select * from public.chat_devices`, `select * from public.chat_thread_keys`, `update public.chat_threads set key_epoch = 9`]) {
      await assert.rejects(db.query(q), /permission denied/);
    }
  } finally { await db.exec(`reset role`); }
});
await t('новое устройство ждёт → прежнее выдаёт ключ → читает историю; эпоха не меняется', async () => {
  const CA2 = await load('a2');
  await CA2.init(sbFor(A), A, { storage: store() });
  assert.equal((await CA2.open(TH)).status, 'waiting');
  const bad = await call(B, 'chat_wraps_add', { p_thread: TH, p_device: m1.sender_device, p_wraps: [] });
  assert.equal(bad.error?.message, 'forbidden');
  assert.equal((await CA.open(TH)).approved, 1);
  assert.equal((await CA2.open(TH)).status, 'ready');
  assert.equal(await CA2.decrypt(TH, m1), 'Перенос пары на 10:00');
  assert.equal((await db.query(`select key_epoch from public.chat_threads`)).rows[0].key_epoch, 1);
});
await t('epoch_create вне очереди → epoch_conflict; «начать заново» → эпоха 2, старая эпоха — key_changed', async () => {
  const devA = m1.sender_device;
  const w = [{ device_id: devA, iv: 'A'.repeat(16), ct: 'A'.repeat(64) }];
  assert.equal((await call(A, 'chat_epoch_create', { p_thread: TH, p_device: devA, p_epoch: 2, p_wraps: w })).error?.message, 'epoch_conflict');
  const CB2 = await load('b2');
  await CB2.init(sbFor(B), B, { storage: store() });
  await CB2.reset();
  const o = await CB2.open(TH);
  assert.equal(o.status, 'ready'); assert.equal(o.epoch, 2);
  assert.equal(await CB2.decrypt(TH, m1), null);
  const r = await call(A, 'chat_post', { p_thread: TH, p_device: devA, p_epoch: 1, p_iv: m1.iv, p_ciphertext: m1.ciphertext });
  assert.equal(r.error?.message, 'key_changed');
  assert.equal((await CA.open(TH)).epoch, 2);
  assert.equal(await CA.decrypt(TH, await post(CB2, B, 'Новый телефон')), 'Новый телефон');
  assert.equal((await call(B, 'chat_thread_state', { p_thread: TH, p_device: (await db.query(`select id from public.chat_devices where user_id = $1 order by created_at limit 1`, [B])).rows[0].id })).error?.message, 'device_revoked');
});
await t('down: новые сообщения, устройства и обёртки удалены, сообщение прежней схемы и треды на месте; повторный up проходит', async () => {
  await db.exec(DOWN);
  const left = (await db.query(`select sender_key_version from public.chat_messages`)).rows;
  assert.deepEqual(left.map((x) => x.sender_key_version), [1]);
  assert.equal((await db.query(`select to_regclass('public.chat_devices') r`)).rows[0].r, null);
  assert.equal((await db.query(`select count(*)::int n from information_schema.columns where table_name = 'chat_threads' and column_name = 'key_epoch'`)).rows[0].n, 0);
  await db.exec(UP);
  assert.equal((await db.query(`select count(*)::int n from public.chat_messages`)).rows[0].n, 1);
});

const bad = results.filter((x) => !x).length;
console.log(`\nchat-devices (PGlite): ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
