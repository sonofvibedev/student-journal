// Чат и права преподавателя через настоящий REST (PostgREST) ТЕСТОВОГО проекта, этап 4.
// SQL-тесты идут под postgres через CLI и не видят ограничений PostgREST (pg-safeupdate, права на колонки при upsert,
// заголовки Prefer). Здесь каждый RPC и путь кабинета преподавателя вызывается настоящим JWT пользователя.
//   node tests/e2e/chat-rest.mjs     (после применённой миграции 20261108100000; браузер не нужен)
// Своя временная группа и аккаунты (*-chatrest-*@journal-test.example) создаются service-ключом и удаляются в конце.
// Шифрование — настоящий chat-crypto.js (Web Crypto Node 24), хранилище ключей — в памяти.
import { readFileSync } from 'node:fs';
import { assertTestTarget } from '../../tools/test/guard.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL_SB = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL_SB);
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY;
if (!ANON || !SERVICE) { console.error('Нет ключей в .env.test: запустите npm run test:reset'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + String(detail).slice(0, 200)}`); };

// ----- service -----
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function svc(path, init = {}) {
  const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SH, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const sPost = (table, rows) => svc(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows) });
const sPatch = (path, body) => svc(`/rest/v1/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
const sDel = (path) => svc(`/rest/v1/${path}`, { method: 'DELETE' }).catch(() => null);

// ----- пользователь (JWT) -----
const uh = (tok, extra = {}) => ({ apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...extra });
async function req(tok, method, path, body, prefer) {
  const r = await fetch(URL_SB + path, { method, headers: uh(tok, prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch (_) { data = t; }
  return { status: r.status, ok: r.ok, data, msg: r.ok ? null : data?.message ?? String(r.status) };
}
const rpc = (tok, name, args = {}) => req(tok, 'POST', `/rest/v1/rpc/${name}`, args);
const get = (tok, path) => req(tok, 'GET', `/rest/v1/${path}`);
// supabase-js-подобная обёртка ровно под то, что зовёт chat-crypto.js
const sbShim = (tok) => ({
  from(table) {
    const f = []; let cols = '*';
    const q = {
      select(c) { cols = c.replace(/\s+/g, ''); return q; },
      eq(c, v) { f.push(`${c}=eq.${encodeURIComponent(v)}`); return q; },
      async maybeSingle() { const r = await get(tok, `${table}?select=${cols}&${f.join('&')}`); return r.ok ? { data: r.data[0] ?? null, error: null } : { data: null, error: { message: r.msg } }; },
    };
    return q;
  },
  async rpc(name, args) { const r = await rpc(tok, name, args); return r.ok ? { data: r.data, error: null } : { data: null, error: { message: r.msg } }; },
});
const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } }; };
const loadCC = async (tag) => { await import(new URL(`../../chat-crypto.js?${tag}`, import.meta.url).href); return globalThis.ChatCrypto; };

// ----- фикстуры -----
const run = Date.now().toString(36);
const PW = `T${run}x9Qz!chat`;
const ROLES = ['hm', 'dp', 'st', 'tl', 'tp', 'out', 'sys'];
const U = {};
let G = null, G2 = null;

async function cleanup() {
  for (const g of [G, G2].filter(Boolean)) {
    for (const t of ['lesson_notes', 'tasks', 'absences', 'grades', 'schedule_lessons']) await sDel(`${t}?group_id=eq.${g}`);
  }
  const list = await svc('/auth/v1/admin/users?per_page=1000').catch(() => null);
  for (const u of (list?.users ?? []).filter((x) => /-chatrest-/.test(x.email ?? ''))) {
    await svc(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' }).catch(() => {});   // каскад: членства, ключи, треды, сообщения
  }
  for (const g of [G, G2].filter(Boolean)) { await sDel(`students?group_id=eq.${g}`); await sDel(`groups?id=eq.${g}`); }
}

try {
  await cleanup();                                                       // остатки прошлых запусков (по email)
  [{ id: G }, { id: G2 }] = await sPost('groups', [{ name: `ЧАТ-${run}`, status: 'active' }, { name: `ЧАТ2-${run}`, status: 'active' }]);
  for (const r of ROLES) {
    const u = await svc('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: `${r}-chatrest-${run}@journal-test.example`, password: PW, email_confirm: true }) });
    U[r] = { id: u.id };
  }
  const st = await sPost('students', ['hm', 'dp', 'st', null, null].map((r, i) => ({ group_id: G, last_name: 'Чат', first_name: `С${i}`, claim_status: r ? 'active' : 'free', claimed_by: r ? U[r].id : null, sort: i })));
  const sid = Object.fromEntries(['hm', 'dp', 'st'].map((r, i) => [r, st[i].id]));
  const m = (u, g, student_id, base_role, extra_role = null) => ({ user_id: u, group_id: g, student_id, base_role, extra_role, status: 'active' });
  await sPost('memberships', [
    m(U.hm.id, G, sid.hm, 'student', 'headman'), m(U.dp.id, G, sid.dp, 'student', 'deputy'), m(U.st.id, G, sid.st, 'student'),
    m(U.tl.id, G, null, 'teacher_lecture'), m(U.tp.id, G, null, 'teacher_practice'), m(U.out.id, G2, null, 'teacher_lecture'),
  ]);
  await sPost('teacher_assignments', [
    { user_id: U.tl.id, group_id: G, subject: 'Эконометрика', lesson_kind: 'lecture' },
    { user_id: U.tp.id, group_id: G, subject: 'Эконометрика', lesson_kind: 'practice' },
    { user_id: U.out.id, group_id: G2, subject: 'Логистика', lesson_kind: 'lecture' },
  ]);
  await sPost('sysadmins', [{ user_id: U.sys.id }]);
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Минск, UTC+3
  const ago = (n) => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
  await sPost('schedule_lessons', [1, 2].map((n) => ({ group_id: G, lesson_date: ago(n), pair_no: 1, subject: 'Эконометрика', kind: 'lecture' })));
  for (const r of ROLES) {
    const s = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${r}-chatrest-${run}@journal-test.example`, password: PW }) })).json();
    if (!s.access_token) throw new Error('вход не удался: ' + r);
    U[r].tok = s.access_token;
  }
  check('фикстуры: группа, 7 аккаунтов, вход по паролю', true);

  // ===== ключи =====
  const CC = {};
  for (const r of ['hm', 'dp', 'tl']) {
    CC[r] = await loadCC(`${r}-${run}`);
    const i = await CC[r].init(sbShim(U[r].tok), U[r].id, { storage: mem() });
    const s = await CC[r].setup(`пароль-${r}-${run}`);
    check(`ключи: ${r} none → ready, версия 1`, i.state === 'none' && s.state === 'ready' && s.key_version === 1, JSON.stringify([i, s]));
  }
  let r = await rpc(U.st.tok, 'chat_keys_publish', { p_public_jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }, p_backup: {} });
  check('ключи: обычный студент → forbidden', r.msg === 'forbidden', r.msg);
  r = await get(U.tl.tok, `chat_keys?user_id=eq.${U.hm.id}&select=user_id`);
  check('ключи: преподаватель не читает строку старосты', r.ok && r.data.length === 0, JSON.stringify(r.data));
  r = await get(U.sys.tok, 'chat_keys?select=user_id,backup');
  check('ключи: сисадмин не читает ни ключей, ни копий', r.ok && r.data.length === 0, JSON.stringify(r.data).slice(0, 80));
  r = await get(U.hm.tok, 'chat_keys?select=user_id,backup,public_jwk');
  check('ключи: своя строка с копией, без d', r.ok && r.data.length === 1 && r.data[0].backup.iter === 600000 && !('d' in r.data[0].public_jwk), JSON.stringify(r.data).slice(0, 120));
  r = await req(U.hm.tok, 'PATCH', `/rest/v1/chat_keys?user_id=eq.${U.hm.id}`, { key_version: 9 }, 'return=representation');
  check('ключи: прямая правка закрыта', !r.ok || r.data.length === 0, r.status);

  // ===== треды =====
  r = await rpc(U.hm.tok, 'chat_threads_my');
  const todo = r.ok ? r.data.filter((x) => x.thread_id === null).map((x) => x.peer_role).sort().join(',') : r.msg;
  check('треды: у старосты оба преподавателя без треда', todo === 'teacher_lecture,teacher_practice', todo);
  r = await rpc(U.hm.tok, 'chat_thread_open', { p_group: G, p_teacher: U.tl.id });
  const TH = r.data;
  check('треды: староста открывает тред с лектором', r.ok && /^[0-9a-f-]{36}$/.test(TH), r.msg);
  r = await rpc(U.hm.tok, 'chat_thread_open', { p_group: G, p_teacher: U.tl.id });
  check('треды: повтор → тот же id', r.data === TH, r.data);
  r = await rpc(U.st.tok, 'chat_thread_open', { p_group: G, p_teacher: U.tl.id });
  check('треды: студент → forbidden', r.msg === 'forbidden', r.msg);
  r = await rpc(U.tl.tok, 'chat_thread_open', { p_group: G, p_teacher: U.tp.id });
  check('треды: преподаватель → forbidden', r.msg === 'forbidden', r.msg);
  r = await rpc(U.hm.tok, 'chat_thread_open', { p_group: G, p_teacher: U.out.id });
  check('треды: преподаватель чужой группы → not_teacher', r.msg === 'not_teacher', r.msg);
  r = await req(U.hm.tok, 'POST', '/rest/v1/chat_threads', { group_id: G, student_user_id: U.hm.id, teacher_user_id: U.tp.id, kind: 'practice' });
  check('треды: прямая вставка закрыта', !r.ok, r.status);

  // ===== переписка =====
  const peer = async (tok) => { const p = await rpc(tok, 'chat_peer_key', { p_thread: TH }); return p.data; };
  const thHm = { id: TH, me: { id: U.hm.id }, peer: { ...(await peer(U.hm.tok)), id: U.tl.id }, my_key_version: 1 };
  const thTl = { id: TH, me: { id: U.tl.id }, peer: { ...(await peer(U.tl.tok)), id: U.hm.id }, my_key_version: 1 };
  check('ключ собеседника: обе стороны получают ключ версии 1', thHm.peer.key_version === 1 && thTl.peer.key_version === 1 && thHm.peer.user_id === U.tl.id);
  r = await rpc(U.tp.tok, 'chat_peer_key', { p_thread: TH });
  check('ключ собеседника: практик → forbidden', r.msg === 'forbidden', r.msg);
  const TEXT = `Перенос пары ${run}`;
  const send = async (who, th, text, over = {}) => {
    const m = await CC[who].encrypt(th, text);
    return rpc(U[who].tok, 'chat_send', { p_thread: TH, p_iv: m.iv, p_ciphertext: m.ciphertext, p_sender_kv: m.sender_key_version, p_recipient_kv: m.recipient_key_version, ...over });
  };
  r = await send('hm', thHm, TEXT);
  check('отправка: староста → лектор', r.ok && /^[0-9a-f-]{36}$/.test(r.data), r.msg);
  r = await send('tl', thTl, 'Принято');
  check('отправка: лектор отвечает', r.ok, r.msg);
  r = await get(U.tl.tok, `chat_messages?thread_id=eq.${TH}&order=created_at`);
  const plain = r.ok ? await Promise.all(r.data.map((m) => CC.tl.decrypt(thTl, m))) : [];
  check('чтение: лектор расшифровывает обе реплики', plain.join('|') === `${TEXT}|Принято`, plain.join('|'));
  check('чтение: в базе только шифртекст', r.ok && !JSON.stringify(r.data).includes('Перенос'));
  const fa = await CC.hm.fingerprint(thHm), fb = await CC.tl.fingerprint(thTl);
  check('отпечаток: у обоих одинаковый', fa === fb && /^[0-9A-F]{4} [0-9A-F]{4}$/.test(fa), `${fa} / ${fb}`);

  r = await send('hm', thHm, 'x', { p_sender_kv: 2 });
  check('отправка: чужая версия → key_changed', r.msg === 'key_changed', r.msg);
  r = await send('hm', thHm, 'x', { p_ciphertext: 'A'.repeat(10924) });
  check('отправка: > 8 КБ → too_long', r.msg === 'too_long', r.msg);
  r = await send('hm', thHm, 'x', { p_ciphertext: 'открытый текст' });
  check('отправка: не шифртекст → bad_message', r.msg === 'bad_message', r.msg);
  r = await rpc(U.tp.tok, 'chat_send', { p_thread: TH, p_iv: 'A'.repeat(16), p_ciphertext: 'A'.repeat(40), p_sender_kv: 1, p_recipient_kv: 1 });
  check('отправка: практик в чужой тред → forbidden', r.msg === 'forbidden', r.msg);
  r = await rpc(U.dp.tok, 'chat_send', { p_thread: TH, p_iv: 'A'.repeat(16), p_ciphertext: 'A'.repeat(40), p_sender_kv: 1, p_recipient_kv: 1 });
  check('отправка: зам в тред старосты → forbidden', r.msg === 'forbidden', r.msg);
  r = await req(U.hm.tok, 'POST', '/rest/v1/chat_messages', { thread_id: TH, sender_id: U.tl.id, sender_key_version: 1, recipient_key_version: 1, iv: 'A'.repeat(16), ciphertext: 'A'.repeat(40) });
  check('сообщения: прямая вставка (от чужого имени) закрыта', !r.ok, r.status);
  r = await req(U.tl.tok, 'DELETE', `/rest/v1/chat_messages?thread_id=eq.${TH}`, undefined, 'return=representation');
  check('сообщения: удаление закрыто', !r.ok || r.data.length === 0, r.status);
  for (const [who, name] of [['tp', 'практик'], ['dp', 'зам'], ['st', 'студент'], ['sys', 'сисадмин'], ['out', 'преподаватель другой группы']]) {
    r = await get(U[who].tok, 'chat_messages?select=id');
    const t2 = await get(U[who].tok, 'chat_threads?select=id');
    check(`чтение: ${name} не видит ни сообщений, ни тредов`, r.ok && r.data.length === 0 && t2.ok && t2.data.length === 0, JSON.stringify([r.data, t2.data]).slice(0, 80));
  }

  // ===== уведомления, прочтение =====
  r = await get(U.tl.tok, `notifications?kind=eq.chat&select=title,body,ref,read_at`);
  check('уведомление: лектору одно, фиксированный текст и подпись', r.ok && r.data.length === 1 && r.data[0].title === 'Новое сообщение в чате'
    && r.data[0].body === `Староста ЧАТ-${run}` && r.data[0].ref.thread_id === TH, JSON.stringify(r.data));
  r = await get(U.hm.tok, `notifications?kind=eq.chat&select=body`);
  check('уведомление: старосте — «Преподаватель»', r.ok && r.data.length === 1 && r.data[0].body === 'Преподаватель', JSON.stringify(r.data));
  r = await rpc(U.tl.tok, 'chat_threads_my');
  check('мои треды: у лектора 1 непрочитанное, подпись старосты', r.ok && r.data.length === 1 && r.data[0].unread === 1 && r.data[0].peer_name === `Староста ЧАТ-${run}` && r.data[0].peer_role === 'headman', JSON.stringify(r.data));
  r = await rpc(U.tl.tok, 'chat_mark_read', { p_thread: TH });
  check('прочтение: chat_mark_read', r.ok, r.msg);
  r = await rpc(U.tl.tok, 'chat_threads_my');
  const n = await get(U.tl.tok, 'notifications?kind=eq.chat&read_at=is.null&select=id');
  check('прочтение: unread 0 и уведомление погашено', r.data?.[0]?.unread === 0 && n.data.length === 0, JSON.stringify([r.data, n.data]));
  r = await rpc(U.sys.tok, 'chat_mark_read', { p_thread: TH });
  check('прочтение: сисадмин → forbidden', r.msg === 'forbidden', r.msg);

  // ===== лимит =====
  let lim = null;
  for (let i = 0; i < 31 && !lim; i++) { const x = await send('hm', thHm, `спам ${i}`); if (!x.ok) lim = { i, msg: x.msg }; }
  check('лимит: не больше 30 в минуту → rate_limited', lim && lim.msg === 'rate_limited' && (lim.i === 29 || lim.i === 30), JSON.stringify(lim));

  // ===== смена роли =====
  await sPatch(`memberships?user_id=eq.${U.hm.id}&group_id=eq.${G}`, { extra_role: null });
  r = await get(U.hm.tok, 'chat_messages?select=id');
  const mine = await rpc(U.hm.tok, 'chat_threads_my');
  const s2 = await rpc(U.hm.tok, 'chat_send', { p_thread: TH, p_iv: 'A'.repeat(16), p_ciphertext: 'A'.repeat(40), p_sender_kv: 1, p_recipient_kv: 1 });
  const tlSees = await get(U.tl.tok, `chat_messages?thread_id=eq.${TH}&select=id`);
  check('роль снята: бывший староста не читает, не пишет, тредов нет; лектор тред не видит',
    r.data.length === 0 && mine.data.length === 0 && s2.msg === 'forbidden' && tlSees.data.length === 0, JSON.stringify([r.data.length, mine.data, s2.msg, tlSees.data.length]));
  await sPatch(`memberships?user_id=eq.${U.hm.id}&group_id=eq.${G}`, { extra_role: 'headman' });

  // ===== сброс ключа =====
  const rs = await CC.hm.reset(`новый-${run}`);
  const thTl2 = { ...thTl, peer: { ...(await peer(U.tl.tok)), id: U.hm.id } };
  r = await get(U.tl.tok, `chat_messages?thread_id=eq.${TH}&order=created_at&limit=1`);
  check('сброс: версия 2, старое сообщение у собеседника → null', rs.key_version === 2 && thTl2.peer.key_version === 2 && (await CC.tl.decrypt(thTl2, r.data[0])) === null);
  check('сброс: отпечаток сменился', (await CC.tl.fingerprint(thTl2)) !== fb);

  // ===== кабинет преподавателя: статистика, темы, задания, пропуски =====
  await sPost('absences', [{ group_id: G, student_id: sid.st, date: ago(1), subject: 'Эконометрика', hours: 2, lesson_kind: 'lecture', created_by: U.hm.id }]);
  r = await rpc(U.tl.tok, 'teacher_group_stats', { p_group: G });
  // 2 лекции × 2 ч × 5 студентов = 20, пропущено 2 → 90.0
  check('статистика: лектор', r.ok && r.data.students === 5 && Number(r.data.attendance_pct) === 90 && Number(r.data.absences_week) === 2, JSON.stringify(r.data ?? r.msg));
  r = await rpc(U.st.tok, 'teacher_group_stats', { p_group: G });
  check('статистика: студент → forbidden', r.msg === 'forbidden', r.msg);

  const note = { group_id: G, lesson_date: today, pair_no: 1, subject: 'Эконометрика', lesson_kind: 'lecture', topic: 'Регрессия', plan: 'МНК' };
  r = await req(U.tl.tok, 'POST', '/rest/v1/lesson_notes?on_conflict=group_id,lesson_date,pair_no,subject', note, 'resolution=merge-duplicates,return=representation');
  check('темы: upsert лектора (вставка)', r.ok && r.data[0]?.updated_by === U.tl.id, r.msg);
  r = await req(U.tl.tok, 'POST', '/rest/v1/lesson_notes?on_conflict=group_id,lesson_date,pair_no,subject', { ...note, topic: 'Регрессия 2' }, 'resolution=merge-duplicates,return=representation');
  check('темы: upsert лектора (правка)', r.ok && r.data[0]?.topic === 'Регрессия 2', r.msg);
  r = await req(U.tp.tok, 'POST', '/rest/v1/lesson_notes?on_conflict=group_id,lesson_date,pair_no,subject', { ...note, lesson_kind: 'practice', topic: 'чужая' }, 'resolution=merge-duplicates,return=representation');
  check('темы: практик не перезаписывает лекцию', !r.ok, r.status);
  r = await get(U.st.tok, `lesson_notes?group_id=eq.${G}&select=topic`);
  check('темы: студент читает', r.ok && r.data.length === 1 && r.data[0].topic === 'Регрессия 2', JSON.stringify(r.data));

  r = await req(U.tl.tok, 'POST', '/rest/v1/tasks', { id: `tk-${run}`, kind: 'homework', group_id: G, rec: { id: `tk-${run}`, subject: 'Эконометрика', text: 'Задачи 1–5' } }, 'return=representation');
  check('задания: лектор вносит по своему предмету', r.ok && r.data[0]?.created_by === U.tl.id, r.msg);
  const tn = await get(U.st.tok, `notifications?kind=eq.task&ref->>task_id=eq.tk-${run}&select=id`);
  const tnSelf = await get(U.tl.tok, `notifications?kind=eq.task&select=id`);
  check('задания: уведомление студенту, не автору', tn.data?.length === 1 && tnSelf.data?.length === 0, JSON.stringify([tn.data, tnSelf.data]));
  r = await req(U.tl.tok, 'POST', '/rest/v1/tasks', { id: `tk2-${run}`, kind: 'homework', group_id: G, rec: { subject: 'Статистика' } });
  check('задания: чужой предмет → отказ', !r.ok, r.status);
  r = await req(U.hm.tok, 'DELETE', `/rest/v1/tasks?id=eq.tk-${run}`, undefined, 'return=representation');
  check('задания: староста не удаляет задание преподавателя', r.ok && r.data.length === 0, r.status);
  r = await req(U.tl.tok, 'PATCH', `/rest/v1/tasks?id=eq.tk-${run}`, { rec: { id: `tk-${run}`, subject: 'Эконометрика', text: 'Задачи 1–7' } }, 'return=representation');
  check('задания: лектор правит своё', r.ok && r.data.length === 1, r.msg);
  r = await req(U.tl.tok, 'DELETE', `/rest/v1/tasks?id=eq.tk-${run}`, undefined, 'return=representation');
  check('задания: лектор удаляет своё', r.ok && r.data.length === 1, r.msg);

  r = await req(U.tl.tok, 'POST', '/rest/v1/absences', [{ group_id: G, student_id: sid.dp, date: today, subject: 'Эконометрика', hours: 2, lesson_kind: 'lecture', is_excused: false }], 'return=representation');
  const myAb = r.data?.[0]?.id;
  check('пропуски: лектор вносит по своей лекции', r.ok && !!myAb, r.msg);
  r = await req(U.tl.tok, 'POST', '/rest/v1/absences', [{ group_id: G, student_id: sid.dp, date: today, subject: null, hours: 2, lesson_kind: 'lecture' }]);
  check('пропуски: без дисциплины → отказ', !r.ok, r.status);
  r = await req(U.tl.tok, 'POST', '/rest/v1/absences', [{ group_id: G, student_id: sid.dp, date: today, subject: 'Эконометрика', hours: 2, lesson_kind: 'practice' }]);
  check('пропуски: чужой вид занятий → отказ', !r.ok, r.status);
  const hmAb = (await get(U.tl.tok, `absences?group_id=eq.${G}&created_by=eq.${U.hm.id}&select=id`)).data?.[0]?.id;
  r = await req(U.tl.tok, 'PATCH', `/rest/v1/absences?id=eq.${hmAb}`, { is_excused: true }, 'return=representation');
  check('пропуски: лектор ставит «уважительный» в записи старосты', r.ok && r.data.length === 1 && r.data[0].is_excused === true, r.msg);
  r = await req(U.tl.tok, 'PATCH', `/rest/v1/absences?id=eq.${hmAb}`, { hours: 1 });
  check('пропуски: часы в записи старосты лектор не меняет', !r.ok, r.status);
  r = await req(U.tp.tok, 'DELETE', `/rest/v1/absences?id=eq.${hmAb}`, undefined, 'return=representation');
  check('пропуски: практик не отменяет лекционную', r.ok && r.data.length === 0, r.status);
  r = await req(U.tl.tok, 'DELETE', `/rest/v1/absences?id=eq.${hmAb}`, undefined, 'return=representation');
  const r2 = await req(U.tl.tok, 'DELETE', `/rest/v1/absences?id=eq.${myAb}`, undefined, 'return=representation');
  check('пропуски: лектор отменяет запись старосты и свою', r.data?.length === 1 && r2.data?.length === 1, JSON.stringify([r.status, r2.status]));
  r = await req(U.tl.tok, 'POST', '/rest/v1/grades', { group_id: G, student_id: sid.st, subject: 'Эконометрика', lesson_kind: 'lecture', passed: true, lesson_date: today, comment: 'Тема' }, 'return=representation');
  check('оценки: лектор ставит «зачтено»', r.ok && r.data.length === 1, r.msg);
} catch (e) {
  check('сценарий дошёл до конца', false, e.message);
} finally {
  await cleanup();
}
const bad = results.filter((x) => !x).length;
console.log(`\nchat-rest: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
