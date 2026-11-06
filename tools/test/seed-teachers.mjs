// Тестовые преподаватели 24ДММ-2 (этап 4, docs/stage4-contract.md «Роли и тестовые аккаунты»). Только тест.
// Вызывается из seed-test.mjs (npm run test:reset) после импорта 24ДММ-2. Идемпотентно: существующий аккаунт
// переиспользуется (пароль приводится к TEST_PASSWORD), членство и назначения дописываются upsert-ом.
// Отдельный запуск (только эта часть, прод не читается): node tools/test/seed-teachers.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertTestTarget } from './guard.mjs';

const G24 = '00000000-0000-4000-8000-000000000024';
const SUBJECTS = ['Эконометрика', 'Маркетинг услуг'];
export const TEACHERS = [
  { email: 'teacher-lecture@journal-test.example', base_role: 'teacher_lecture', kind: 'lecture' },
  { email: 'teacher-practice@journal-test.example', base_role: 'teacher_practice', kind: 'practice' },
];

export async function seedTeachers({ ref, serviceKey, password }) {
  const url = `https://${assertTestTarget(ref)}.supabase.co`;
  assertTestTarget(ref, url);
  const H = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const api = async (path, init = {}) => {
    const r = await fetch(url + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const users = (await api('/auth/v1/admin/users?per_page=1000')).users ?? [];
  const out = [];
  for (const t of TEACHERS) {
    let u = users.find((x) => x.email === t.email);
    if (u) await api(`/auth/v1/admin/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ password, email_confirm: true }) });
    else u = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: t.email, password, email_confirm: true }) });
    await api('/rest/v1/memberships?on_conflict=user_id,group_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: u.id, group_id: G24, student_id: null, base_role: t.base_role, extra_role: null,
        status: 'active', consent_at: new Date().toISOString(), consent_version: 'test' }]) });
    await api('/rest/v1/teacher_assignments?on_conflict=user_id,group_id,subject,lesson_kind', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(SUBJECTS.map((subject) => ({ user_id: u.id, group_id: G24, subject, lesson_kind: t.kind }))) });
    out.push({ email: t.email, user_id: u.id });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (!env.TEST_SERVICE_KEY || !env.TEST_PASSWORD) { console.error('Нет TEST_SERVICE_KEY/TEST_PASSWORD в .env.test'); process.exit(2); }
  const res = await seedTeachers({ ref: env.TEST_PROJECT_REF, serviceKey: env.TEST_SERVICE_KEY, password: env.TEST_PASSWORD });
  console.log('Преподаватели:', res.map((r) => r.email).join(', '));
}
