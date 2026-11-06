// Утилита сисадмина через настоящий REST (PostgREST) ТЕСТОВОГО проекта, этап 5.
// SQL-тесты идут под postgres через CLI и не видят ограничений PostgREST (pg-safeupdate, права ролей API),
// поэтому здесь каждый RPC этапа 5 вызывается настоящим JWT пользователя через /rest/v1/rpc, плюс запрещённые пути.
//   node tests/e2e/ops-rest.mjs     (после применённой миграции 20261109100000; браузер не нужен)
// Свои временные группы, аккаунты (*-opsrest-*@journal-test.example), события и записи копий создаются service-ключом
// и удаляются в конце (в т. ч. записи audit_log этих аккаунтов и групп).
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
const sDel = (path) => svc(`/rest/v1/${path}`, { method: 'DELETE' }).catch(() => null);

// ----- пользователь (JWT) или аноним -----
const uh = (tok, extra = {}) => ({ apikey: ANON, Authorization: `Bearer ${tok ?? ANON}`, 'Content-Type': 'application/json', ...extra });
async function req(tok, method, path, body, prefer) {
  const r = await fetch(URL_SB + path, { method, headers: uh(tok, prefer ? { Prefer: prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch (_) { data = t; }
  return { status: r.status, ok: r.ok, data, msg: r.ok ? null : data?.message ?? String(r.status) };
}
const rpc = (tok, name, args = {}) => req(tok, 'POST', `/rest/v1/rpc/${name}`, args);
const get = (tok, path) => req(tok, 'GET', `/rest/v1/${path}`);

// ----- фикстуры -----
const run = Date.now().toString(36);
const PW = `T${run}x9Qz!ops`;
const ROLES = ['sys', 'sys2', 'hm', 'st', 'tch'];
const U = {};
const email = (r) => `${r}-opsrest-${run}@journal-test.example`;
let G = null;
const created = [];                                                       // группы из sysadmin_create_group
const TAG = `ops-rest-${run}`;

async function cleanup() {
  const groups = (await svc(`/rest/v1/groups?select=id&name=like.${encodeURIComponent('ОПС-*')}`).catch(() => [])) ?? [];
  const gids = [...new Set([G, ...created, ...groups.map((g) => g.id)].filter(Boolean))];
  const list = await svc('/auth/v1/admin/users?per_page=1000').catch(() => null);
  const users = (list?.users ?? []).filter((x) => /-opsrest-/.test(x.email ?? ''));
  for (const u of users) await sDel(`audit_log?or=(actor.eq.${u.id},details->>user_id.eq.${u.id})`);
  for (const g of gids) {
    await sDel(`audit_log?group_id=eq.${g}`);
    for (const t of ['absences', 'schedule_lessons', 'teacher_assignments', 'memberships']) await sDel(`${t}?group_id=eq.${g}`);
  }
  for (const u of users) await svc(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' }).catch(() => {});   // каскад: членства, сисадмины
  for (const g of gids) { await sDel(`students?group_id=eq.${g}`); await sDel(`groups?id=eq.${g}`); }       // group_invites — каскад
  await sDel(`client_events?name=like.${encodeURIComponent('ops-rest-*')}`);
  await sDel(`backups?path=like.${encodeURIComponent('ops-rest-*')}`);
}

try {
  await cleanup();                                                       // остатки прошлых запусков
  [{ id: G }] = await sPost('groups', [{ name: `ОПС-${run}`, status: 'active' }]);
  for (const r of ROLES) {
    const u = await svc('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: email(r), password: PW, email_confirm: true }) });
    U[r] = { id: u.id };
  }
  const st = await sPost('students', ['hm', 'st'].map((r, i) => ({ group_id: G, last_name: 'Опс', first_name: `С${i}`, claim_status: 'active', claimed_by: U[r].id, sort: i })));
  await sPost('memberships', [
    { user_id: U.hm.id, group_id: G, student_id: st[0].id, base_role: 'student', extra_role: 'headman', status: 'active' },
    { user_id: U.st.id, group_id: G, student_id: st[1].id, base_role: 'student', extra_role: null, status: 'active' },
  ]);
  await sPost('sysadmins', [{ user_id: U.sys.id }]);
  await sPost('schedule_lessons', [
    { group_id: G, lesson_date: '2099-03-01', pair_no: 1, subject: 'Эконометрика', kind: 'lecture' },
    { group_id: G, lesson_date: '2099-03-01', pair_no: 2, subject: 'Аудит', kind: 'practice' },
    { group_id: G, lesson_date: '2099-03-02', pair_no: 1, subject: 'Эконометрика', kind: 'practice' },
  ]);
  for (const e of [
    { source: 'health', kind: 'ping', name: `${TAG}-db`, ms: 42, ok: true },
    { source: 'server', kind: 'error', name: `${TAG}-srv`, message: 'сбой', group_id: G },
    { source: 'client', kind: 'error', name: `${TAG}-cli`, message: 'TypeError' },
  ]) await sPost('client_events', e);
  await sPost('backups', [{ kind: 'manual', path: `${TAG}/x.json.gz`, size_bytes: 123, tables: { groups: 1 }, status: 'ok' }]);
  for (const r of ROLES) {
    const s = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email(r), password: PW }) })).json();
    if (!s.access_token) throw new Error('вход не удался: ' + r);
    U[r].tok = s.access_token;
  }
  check('фикстуры: группа, 5 аккаунтов, события, копия, вход по паролю', true);

  // ===== таблицы: чтение и запись =====
  let r = await get(U.sys.tok, `client_events?name=like.${encodeURIComponent(TAG + '*')}&select=id,name`);
  check('client_events: сисадмин читает', r.ok && r.data.length === 3, JSON.stringify(r.data ?? r.msg));
  for (const who of ['hm', 'st', 'tch']) {
    r = await get(U[who].tok, 'client_events?select=id');
    const b = await get(U[who].tok, 'backups?select=id');
    check(`client_events и backups: ${who} не читает`, r.ok && r.data.length === 0 && b.ok && b.data.length === 0, JSON.stringify([r.data, b.data]));
  }
  r = await get(null, 'client_events?select=id');
  check('client_events: аноним не читает', !r.ok || r.data.length === 0, r.status);
  r = await get(U.sys.tok, `backups?path=like.${encodeURIComponent(TAG + '*')}&select=size_bytes,status`);
  check('backups: сисадмин читает', r.ok && r.data.length === 1 && r.data[0].size_bytes === 123, JSON.stringify(r.data ?? r.msg));
  r = await get(U.sys.tok, 'ops_state?select=key');
  check('ops_state: сисадмин напрямую не читает', !r.ok, r.status);
  for (const [who, tok] of [['аноним', null], ['студент', U.st?.tok], ['сисадмин', U.sys.tok]]) {
    const a = await req(tok, 'POST', '/rest/v1/client_events', { source: 'client', kind: 'error', name: `${TAG}-forged` });
    const b = await req(tok, 'POST', '/rest/v1/backups', { kind: 'manual', status: 'ok', path: `${TAG}/forged` });
    const c = await req(tok, 'POST', '/rest/v1/ops_state', { key: `${TAG}-forged` });
    check(`запись: ${who} не вставляет в client_events, backups, ops_state`, !a.ok && !b.ok && !c.ok, JSON.stringify([a.status, b.status, c.status]));
  }
  r = await req(U.sys.tok, 'DELETE', `/rest/v1/client_events?name=like.${encodeURIComponent(TAG + '*')}`, undefined, 'return=representation');
  check('client_events: сисадмин не удаляет', !r.ok || r.data.length === 0, r.status);

  // ===== сводка и лента =====
  r = await rpc(U.sys.tok, 'ops_summary', { p_hours: 24 });
  const keys = ['availability_pct', 'pings', 'resp_p50_ms', 'resp_p95_ms', 'page_p50_ms', 'page_p95_ms', 'client_errors', 'server_errors',
    'top_errors', 'imports', 'pending_requests', 'pending_students', 'last_alert_at', 'last_digest_at', 'backup_last', 'maintenance'];
  check('ops_summary: все поля контракта', r.ok && keys.every((k) => k in r.data), JSON.stringify(r.data ?? r.msg).slice(0, 200));
  check('ops_summary: наши события учтены', r.ok && r.data.pings >= 1 && r.data.server_errors >= 1 && r.data.client_errors >= 1
    && Array.isArray(r.data.top_errors) && r.data.top_errors.length <= 5 && r.data.imports.some((x) => x.group_id === G)
    && typeof r.data.maintenance === 'boolean' && r.data.backup_last !== null, JSON.stringify(r.data ?? r.msg).slice(0, 200));
  r = await rpc(U.sys.tok, 'ops_summary', { p_hours: 721 });
  check('ops_summary: 721 ч → bad_hours', r.msg === 'bad_hours', r.msg);
  r = await rpc(U.sys.tok, 'ops_events', { p_source: 'server', p_limit: 200 });
  check('ops_events: фильтр server, наш сбой есть', r.ok && r.data.every((x) => x.source === 'server') && r.data.some((x) => x.name === `${TAG}-srv` && x.group_id === G), JSON.stringify(r.data ?? r.msg).slice(0, 200));
  r = await rpc(U.sys.tok, 'ops_events', { p_limit: 2 });
  const page2 = r.ok && r.data.length ? await rpc(U.sys.tok, 'ops_events', { p_limit: 200, p_before: r.data[r.data.length - 1].id }) : null;
  check('ops_events: лимит 2 и курсор p_before', r.ok && r.data.length === 2 && r.data[0].id > r.data[1].id && page2?.ok && page2.data.every((x) => x.id < r.data[1].id), JSON.stringify(r.data ?? r.msg).slice(0, 200));

  // ===== поиск пользователя =====
  r = await rpc(U.sys.tok, 'sysadmin_find_user', { p_email: email('tch').toUpperCase() });
  check('sysadmin_find_user: находит без учёта регистра', r.ok && r.data === U.tch.id, JSON.stringify(r.data ?? r.msg));
  r = await rpc(U.sys.tok, 'sysadmin_find_user', { p_email: `nobody-${run}@journal-test.example` });
  check('sysadmin_find_user: нет → null', r.ok && r.data === null, JSON.stringify(r.data ?? r.msg));

  // ===== преподаватели =====
  r = await rpc(U.sys.tok, 'sysadmin_group_subjects', { p_group: G });
  check('sysadmin_group_subjects: предметы расписания', r.ok && JSON.stringify(r.data) === JSON.stringify(['Аудит', 'Эконометрика']), JSON.stringify(r.data ?? r.msg));
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.tch.id, p_group: G, p_role: 'teacher_lecture', p_subjects: ['Эконометрика', 'Аудит'] });
  check('sysadmin_assign_teacher: назначен', r.ok && r.data?.ok === true, r.msg);
  r = await get(U.tch.tok, `memberships?group_id=eq.${G}&select=base_role,status,consent_at`);
  check('назначенный видит своё active-членство лектора без согласия', r.ok && r.data.length === 1 && r.data[0].base_role === 'teacher_lecture' && r.data[0].status === 'active' && r.data[0].consent_at === null, JSON.stringify(r.data));
  r = await get(U.tch.tok, `schedule_lessons?group_id=eq.${G}&select=subject`);
  check('назначенный видит расписание своих предметов', r.ok && r.data.length === 3, JSON.stringify(r.data));
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.st.id, p_group: G, p_role: 'teacher_lecture', p_subjects: ['Аудит'] });
  check('sysadmin_assign_teacher: студент группы → is_student', r.msg === 'is_student', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.tch.id, p_group: G, p_role: 'teacher_lecture', p_subjects: [] });
  check('sysadmin_assign_teacher: пустой список → bad_subjects', r.msg === 'bad_subjects', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.tch.id, p_group: G, p_role: 'teacher_lecture', p_subjects: Array.from({ length: 21 }, (_, i) => `П${i}`) });
  check('sysadmin_assign_teacher: 21 предмет → too_many_subjects', r.msg === 'too_many_subjects', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.tch.id, p_group: G, p_role: 'admin', p_subjects: ['Аудит'] });
  check('sysadmin_assign_teacher: неизвестная роль → bad_role', r.msg === 'bad_role', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_assign_teacher', { p_user: U.tch.id, p_group: '00000000-0000-4000-8000-0000000000ff', p_role: 'teacher_lecture', p_subjects: ['Аудит'] });
  check('sysadmin_assign_teacher: неизвестная группа → not_found', r.msg === 'not_found', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_teachers', { p_group: G });
  check('sysadmin_teachers: почта, роль, предметы, статус', r.ok && r.data.length === 1 && r.data[0].email === email('tch') && r.data[0].role === 'teacher_lecture'
    && JSON.stringify(r.data[0].subjects) === JSON.stringify(['Аудит', 'Эконометрика']) && r.data[0].status === 'active', JSON.stringify(r.data ?? r.msg));
  r = await rpc(U.sys.tok, 'sysadmin_remove_teacher', { p_user: U.tch.id, p_group: G });
  check('sysadmin_remove_teacher: снят', r.ok && r.data?.ok === true && r.data.assignments === 2, JSON.stringify(r.data ?? r.msg));
  r = await get(U.tch.tok, `schedule_lessons?group_id=eq.${G}&select=subject`);
  check('снятый не видит расписание группы', r.ok && r.data.length === 0, JSON.stringify(r.data));
  r = await rpc(U.sys.tok, 'sysadmin_remove_teacher', { p_user: U.st.id, p_group: G });
  check('sysadmin_remove_teacher: не преподаватель → not_teacher', r.msg === 'not_teacher', r.msg);

  // ===== статус группы =====
  r = await rpc(U.sys.tok, 'sysadmin_set_group_status', { p_group: G, p_status: 'closed' });
  check('sysadmin_set_group_status: closed', r.ok && r.data?.status === 'closed', r.msg);
  r = await req(U.hm.tok, 'POST', '/rest/v1/absences', [{ group_id: G, student_id: st[1].id, date: '2099-03-01', subject: 'Аудит', hours: 2 }]);
  check('закрытая группа: староста не вносит пропуск', !r.ok, r.status);
  r = await get(U.st.tok, `groups?id=eq.${G}&select=status`);
  check('закрытая группа: студент видит группу (только просмотр)', r.ok && r.data[0]?.status === 'closed', JSON.stringify(r.data));
  r = await rpc(U.sys.tok, 'sysadmin_set_group_status', { p_group: G, p_status: 'active' });
  check('sysadmin_set_group_status: снова active', r.ok && r.data?.status === 'active', r.msg);
  r = await req(U.hm.tok, 'POST', '/rest/v1/absences', [{ group_id: G, student_id: st[1].id, date: '2099-03-01', subject: 'Аудит', hours: 2 }], 'return=representation');
  check('открытая группа: староста снова вносит пропуск', r.ok && r.data.length === 1, r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_set_group_status', { p_group: G, p_status: 'graduated' });
  check('sysadmin_set_group_status: graduated → bad_status', r.msg === 'bad_status', r.msg);

  // ===== новая группа =====
  const NEW = `ОПС-НОВ-${run}`;
  r = await rpc(U.sys.tok, 'sysadmin_create_group', {
    p_group: { name: NEW, group_no: NEW, faculty: 'ФМк', study_form: 'Дневная', course: 1, bseu_faculty_id: '13', bseu_form_id: '10', bseu_group_id: '1' },
    p_students: [{ last_name: 'Альфа', first_name: 'А', study_form: 'budget' }, { last_name: 'Бета', first_name: 'Б', study_form: 'paid' }, { last_name: 'Гамма', first_name: 'В' }],
  });
  if (r.ok) created.push(r.data.group_id);
  const CODE = r.data?.code;
  check('sysadmin_create_group: {group_id, code}, код XXXX-XXXX', r.ok && Object.keys(r.data).sort().join() === 'code,group_id' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(CODE ?? ''), JSON.stringify(r.data ?? r.msg));
  if (r.ok) {
    const s = await svc(`/rest/v1/students?group_id=eq.${r.data.group_id}&select=last_name,study_form,sort&order=sort`);
    check('новая группа: 3 студента по порядку, формы budget/paid/null', s.map((x) => `${x.sort}:${x.last_name}:${x.study_form}`).join() === '1:Альфа:budget,2:Бета:paid,3:Гамма:null', JSON.stringify(s));
    const inv = await svc(`/rest/v1/group_invites?group_id=eq.${r.data.group_id}&select=code_hash`);
    const { createHash } = await import('node:crypto');
    check('новая группа: в базе только sha-256 кода', inv.length === 1 && inv[0].code_hash === createHash('sha256').update(CODE.replace('-', '')).digest('hex'));
    const au = await svc(`/rest/v1/audit_log?group_id=eq.${r.data.group_id}&action=eq.group_create&select=details`);
    check('новая группа: audit_log без кода', au.length === 1 && !JSON.stringify(au).includes(CODE) && !JSON.stringify(au).includes(CODE.replace('-', '')), JSON.stringify(au));
    const gi = await get(U.sys.tok, `group_invites?group_id=eq.${r.data.group_id}&select=code_hash`);
    check('новая группа: хэш кода сисадмину через REST не отдаётся', !gi.ok || gi.data.length === 0, JSON.stringify(gi.data));
  }
  r = await rpc(U.sys.tok, 'sysadmin_create_group', { p_group: { name: ` ${NEW.toLowerCase()} ` }, p_students: [{ last_name: 'А', first_name: 'Б' }] });
  check('sysadmin_create_group: то же имя → duplicate_group', r.msg === 'duplicate_group', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_create_group', { p_group: { name: `ОПС-Д-${run}` }, p_students: [{ last_name: 'Иванов', first_name: 'Иван' }, { last_name: 'иванов', first_name: 'ИВАН' }] });
  check('sysadmin_create_group: одинаковые ФИО → duplicate_student', r.msg === 'duplicate_student', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_create_group', { p_group: { name: `ОПС-Д-${run}` }, p_students: [{ last_name: 'Иванов', first_name: 'Иван', study_form: 'contract' }] });
  check('sysadmin_create_group: форма не budget/paid → bad_student', r.msg === 'bad_student', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_create_group', { p_group: { name: `ОПС-Д-${run}` }, p_students: [] });
  check('sysadmin_create_group: без студентов → no_students', r.msg === 'no_students', r.msg);

  // ===== сисадмины =====
  r = await rpc(U.sys.tok, 'sysadmin_add_sysadmin', { p_user: U.sys2.id });
  check('sysadmin_add_sysadmin: добавлен', r.ok && r.data?.added === true, JSON.stringify(r.data ?? r.msg));
  r = await rpc(U.sys2.tok, 'sysadmin_list_sysadmins');
  check('sysadmin_list_sysadmins: новый сисадмин видит список с собой', r.ok && r.data.some((x) => x.user_id === U.sys2.id && x.email === email('sys2')) && r.data.some((x) => x.user_id === U.sys.id), JSON.stringify(r.data ?? r.msg).slice(0, 200));
  r = await rpc(U.sys.tok, 'sysadmin_remove_sysadmin', { p_user: U.sys.id });
  check('sysadmin_remove_sysadmin: себя → self', r.msg === 'self', r.msg);
  r = await rpc(U.sys.tok, 'sysadmin_remove_sysadmin', { p_user: U.sys2.id });
  check('sysadmin_remove_sysadmin: второго снял', r.ok && r.data?.ok === true, r.msg);
  r = await rpc(U.sys2.tok, 'ops_summary', { p_hours: 24 });
  check('снятый сисадмин → forbidden', r.msg === 'forbidden', r.msg);

  // ===== отказы: каждый RPC закрыт студенту, старосте и аноним =====
  const calls = [
    ['ops_summary', { p_hours: 24 }], ['ops_events', {}], ['sysadmin_find_user', { p_email: email('sys') }],
    ['sysadmin_assign_teacher', { p_user: U.hm.id, p_group: G, p_role: 'teacher_lecture', p_subjects: ['Аудит'] }],
    ['sysadmin_remove_teacher', { p_user: U.tch.id, p_group: G }], ['sysadmin_teachers', { p_group: G }],
    ['sysadmin_add_sysadmin', { p_user: U.st.id }], ['sysadmin_remove_sysadmin', { p_user: U.sys.id }], ['sysadmin_list_sysadmins', {}],
    ['sysadmin_create_group', { p_group: { name: `ОПС-ВЗЛОМ-${run}` }, p_students: [{ last_name: 'А', first_name: 'Б' }] }],
    ['sysadmin_set_group_status', { p_group: G, p_status: 'closed' }], ['sysadmin_group_subjects', { p_group: G }],
  ];
  for (const [who, tok] of [['студент', U.st.tok], ['староста', U.hm.tok], ['снятый преподаватель', U.tch.tok]]) {
    const bad = [];
    for (const [fn, args] of calls) { const x = await rpc(tok, fn, args); if (x.msg !== 'forbidden') bad.push(`${fn}:${x.msg}`); }
    check(`отказ: ${who} → forbidden во всех 12 RPC`, bad.length === 0, bad.join(' '));
  }
  const badAnon = [];
  for (const [fn, args] of [...calls, ['ops_cleanup', {}]]) { const x = await rpc(null, fn, args); if (x.ok) badAnon.push(fn); }
  check('отказ: аноним не вызывает ни один RPC (и ops_cleanup)', badAnon.length === 0, badAnon.join(' '));
  r = await rpc(U.sys.tok, 'ops_cleanup');
  check('ops_cleanup: сисадмину закрыта', !r.ok, r.status);
  const g = await svc(`/rest/v1/groups?id=eq.${G}&select=status`);
  const sa = await svc(`/rest/v1/sysadmins?user_id=in.(${U.st.id},${U.hm.id})&select=user_id`);
  const hack = await svc(`/rest/v1/groups?name=eq.${encodeURIComponent(`ОПС-ВЗЛОМ-${run}`)}&select=id`);
  check('отказы ничего не изменили', g[0].status === 'active' && sa.length === 0 && hack.length === 0, JSON.stringify([g, sa, hack]));
  r = await get(U.sys.tok, 'chat_messages?select=id');
  const tl = await get(U.sys.tok, 'tg_links?select=user_id');
  check('сисадмин не читает chat_messages и tg_links', r.ok && r.data.length === 0 && (!tl.ok || tl.data.length === 0), JSON.stringify([r.status, tl.status]));
} catch (e) {
  check('сценарий дошёл до конца', false, e.message);
} finally {
  await cleanup();
  const left = await svc(`/rest/v1/client_events?name=like.${encodeURIComponent('ops-rest-*')}&select=id`).catch(() => null);
  const lg = await svc(`/rest/v1/groups?name=like.${encodeURIComponent('ОПС-*')}&select=id`).catch(() => null);
  check('уборка: временных событий и групп не осталось', left?.length === 0 && lg?.length === 0, JSON.stringify([left, lg]));
}
const bad = results.filter((x) => !x).length;
console.log(`\nops-rest: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
