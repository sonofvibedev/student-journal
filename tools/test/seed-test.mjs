// Пересоздаёт данные ТЕСТОВОГО проекта: маскированная копия прода + тестовые аккаунты.
//   node tools/test/seed-test.mjs
// Прод только читается (select в read-only транзакции), цель записи — только TEST_PROJECT_REF из .env.test.
// В отчёт и в вывод попадают только числа; ключи и пароли не печатаются.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestTarget, PROD_REF } from './guard.mjs';
import { seedTeachers } from './seed-teachers.mjs';

const ENV = '.env.test';
const env = Object.fromEntries(readFileSync(ENV, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL);

const sb = (args) => {
  try {
    return execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'supabase@latest', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) {   // без дампа справки CLI в вывод
    const out = String(e.stdout ?? '').slice(0, 400);
    throw new Error(`supabase ${args.slice(0, 2).join(' ')} упал: ${out || String(e.stderr ?? '').slice(0, 400)}`);
  }
};
const parseJson = (s) => JSON.parse(s.slice(s.indexOf('{')));

// --- ключи и пароль тестовых аккаунтов (в .env.test, в git не попадают)
function ensureEnv(key, make) {
  if (!env[key]) { env[key] = make(); appendFileSync(ENV, `${key}=${env[key]}\n`); }
}
ensureEnv('TEST_PASSWORD', () => 'T' + randomBytes(9).toString('base64url') + '9a');
ensureEnv('TEST_SERVICE_KEY', () => {
  const keys = JSON.parse(sb(['projects', 'api-keys', '--project-ref', TEST, '-o', 'json']));
  const k = keys.find((x) => x.name === 'service_role' || x.id === 'service_role') ?? keys.find((x) => /secret/i.test(x.name ?? ''));
  if (!k?.api_key) throw new Error('не нашёл service-ключ тестового проекта');
  return k.api_key;
});

// --- чтение прода: только select, read-only
const tmpSql = (sql, label) => { const f = join(tmpdir(), `seed-${label}-${Date.now()}-${randomBytes(3).toString('hex')}.sql`); writeFileSync(f, sql); return f; };
const prod = (sql) => {
  if (!/^\s*select[\s(*]/i.test(sql)) throw new Error('к проду допускается только select');
  return parseJson(sb(['db', 'query', `--remote=${PROD_REF}`, '--read-only', '--output-format', 'json', '--file', tmpSql(sql, 'prod')])).rows;
};
// --- запись в тест: всегда с явным ref
const testSql = (sql, label) => sb(['db', 'query', `--remote=${TEST}`, '--yes', '--file', tmpSql(sql, label)]);
const testRows = (sql) => parseJson(sb(['db', 'query', `--remote=${TEST}`, '--yes', '--output-format', 'json', '--file', tmpSql(sql, 'rows')])).rows;

const src = {
  journal: prod("select students, absences from public.journal_private where id = 'main'")[0],
  profiles: prod('select student_id, can_post_tasks from public.profiles'),
  events: prod('select student_id, kind, ref, created_at from public.app_events order by id'),
  ach: prod('select student_id, code, period, semester, earned_at from public.student_achievements order by id'),
  games: prod('select student_id, game, difficulty, score, proof, played_at, updated_at from public.game_records order by id'),
  days: prod('select day, semester from public.study_days order by day'),
  tasks: prod('select id, kind, rec, updated_at from public.tasks order by seq'),
};
const before = {
  students: src.journal.students.length, absences: src.journal.absences.length, profiles: src.profiles.length,
  events: src.events.length, achievements: src.ach.length, game_records: src.games.length, study_days: src.days.length, tasks: src.tasks.length,
};

// --- маскирование: «Студент 01…», без Telegram, без комментариев к пропускам
const ordered = [...src.journal.students].sort((a, b) =>
  `${a.lastName ?? ''} ${a.firstName ?? ''}`.localeCompare(`${b.lastName ?? ''} ${b.firstName ?? ''}`, 'ru'));
const num = new Map(ordered.map((s, i) => [s.id, String(i + 1).padStart(2, '0')]));
const students = ordered.map((s) => ({ id: s.id, lastName: 'Студент', firstName: num.get(s.id), role: s.role, status: s.status, isAdmin: s.isAdmin === true }));
const absences = src.journal.absences.map((a) => ({ ...a, comment: '' }));

// --- аккаунты Auth: пересоздаём
const H = { apikey: env.TEST_SERVICE_KEY, Authorization: `Bearer ${env.TEST_SERVICE_KEY}`, 'Content-Type': 'application/json' };
async function api(path, init = {}) {
  const r = await fetch(URL + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const existing = (await api('/auth/v1/admin/users?per_page=1000')).users ?? [];
for (const u of existing) await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
const uid = new Map();
for (const s of students) {
  const n = num.get(s.id);
  const u = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({
    email: `student${n}@journal-test.example`, password: env.TEST_PASSWORD, email_confirm: true, app_metadata: { student_id: s.id } }) });
  uid.set(s.id, u.id);
}

// --- SQL для теста
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => `$seedjson$${JSON.stringify(v)}$seedjson$::jsonb`;
const rows = (list, f) => list.map(f).join(',\n');
// Копия прода — это группа 24ДММ-2: group_id передаём явно (триггеры на время копирования выключены, default снят в 20261106100000)
const G24 = "'00000000-0000-4000-8000-000000000024'";
const sqlStmts = [
  'begin;',
  'truncate public.app_events, public.student_achievements, public.game_records, public.study_days, public.tasks, public.profiles restart identity cascade;',
  ...['app_events', 'student_achievements', 'game_records', 'tasks', 'profiles'].map((t) => `alter table public.${t} disable trigger user;`),
  `update public.journal_private set students = ${j(students)}, absences = ${j(absences)}, updated_at = now() where id = 'main';`,
  `insert into public.profiles (user_id, student_id, login, can_post_tasks) values\n${rows(src.profiles.filter((p) => uid.has(p.student_id)), (p) => `('${uid.get(p.student_id)}', ${q(p.student_id)}, ${q('student' + num.get(p.student_id))}, ${p.can_post_tasks === true})`)};`,
  `insert into public.app_events (user_id, student_id, kind, ref, created_at, group_id) values\n${rows(src.events.filter((e) => uid.has(e.student_id)), (e) => `('${uid.get(e.student_id)}', ${q(e.student_id)}, ${q(e.kind)}, ${q(e.ref)}, ${q(e.created_at)}, ${G24})`)};`,
  `insert into public.student_achievements (student_id, code, period, semester, earned_at, group_id) values\n${rows(src.ach, (a) => `(${q(a.student_id)}, ${q(a.code)}, ${q(a.period)}, ${q(a.semester)}, ${q(a.earned_at)}, ${G24})`)};`,
  `insert into public.game_records (student_id, game, difficulty, score, proof, played_at, updated_at, group_id) values\n${rows(src.games, (g) => `(${q(g.student_id)}, ${q(g.game)}, ${q(g.difficulty)}, ${Number(g.score)}, ${j(g.proof ?? {})}, ${q(g.played_at)}, ${q(g.updated_at)}, ${G24})`)};`,
  `insert into public.study_days (day, semester, group_id) values\n${rows(src.days, (d) => `(${q(d.day)}, ${q(d.semester)}, ${G24})`)};`,
  `insert into public.tasks (id, kind, rec, updated_at, group_id) values\n${rows(src.tasks, (t) => `(${q(t.id)}, ${q(t.kind)}, ${j(t.rec)}, ${q(t.updated_at)}, ${G24})`)};`,
  ...['app_events', 'student_achievements', 'game_records', 'tasks', 'profiles'].map((t) => `alter table public.${t} enable trigger user;`),
  'commit;',
];
testSql(sqlStmts.join('\n'), 'copy');

// Перенос в схему 2.0 (группа 24ДММ-2, студенты, пропуски, членства): тот же вызов, что делает миграция на проде.
// Под сервисной ролью, потому что функция закрыта для клиентов.
const imp = await api('/rest/v1/rpc/journal2_import_legacy', { method: 'POST', body: '{}' });
console.log('journal2_import_legacy:', JSON.stringify(imp).slice(0, 200));

// Тестовые преподаватели 24ДММ-2 (этап 4): лекций и ПЗ, «Эконометрика» и «Маркетинг услуг»
const teachers = await seedTeachers({ ref: TEST, serviceKey: env.TEST_SERVICE_KEY, password: env.TEST_PASSWORD });
console.log('Преподаватели:', teachers.map((t) => t.email).join(', '));

const a = testRows(`select
  (select jsonb_array_length(students) from public.journal_private where id='main') students,
  (select jsonb_array_length(absences) from public.journal_private where id='main') absences,
  (select count(*) from public.profiles) profiles,
  (select count(*) from public.app_events) events,
  (select count(*) from public.student_achievements) achievements,
  (select count(*) from public.game_records) game_records,
  (select count(*) from public.study_days) study_days,
  (select count(*) from public.tasks) tasks,
  (select count(*) from auth.users) auth_users`)[0];
const after = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Number(v)]));

mkdirSync('docs/reports', { recursive: true });
const keys = Object.keys(before);
const ok = keys.every((k) => before[k] === after[k]);
const md = `# Сверка тестовой копии\n\nПрод читался только на чтение. Имена заменены на «Студент NN», Telegram-данные и комментарии к пропускам не копировались, логины и пароли прода не копировались. Оценок в текущей схеме нет (появятся в 2.0), поле «форма обучения» в текущих данных отсутствует.\n\n| Что | Прод | Тест | |\n|---|---|---|---|\n${keys.map((k) => `| ${k} | ${before[k]} | ${after[k]} | ${before[k] === after[k] ? 'совпало' : 'РАСХОЖДЕНИЕ'} |`).join('\n')}\n| auth.users (тестовые) | — | ${after.auth_users} | |\n\nИтог: ${ok ? 'все числа совпали' : 'есть расхождения'}.\n`;
writeFileSync('docs/reports/test-copy.md', md);
console.log(md);
if (!ok) process.exit(1);
