// Сквозной тест регистрации и входа на ТЕСТОВОМ проекте (без браузера, по HTTP-контракту страниц):
//   староста регистрируется → заявка → сисадмин одобряет → код группы → студент входит по коду →
//   ожидание (данных нет) → «Это он» (данные открылись) / «Не он» / «Это не я» → блок после 5 неверных кодов.
// Запуск: node tests/e2e/flow.mjs   (цель — только TEST_PROJECT_REF из .env.test)
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertTestTarget } from '../../tools/test/guard.mjs';

const ENV = '.env.test';
const env = Object.fromEntries(readFileSync(ENV, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL);

function ensureKey(name, pick) {
  if (env[name]) return;
  const keys = JSON.parse(execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'supabase@latest', 'projects', 'api-keys', '--project-ref', TEST, '-o', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }));
  const k = pick(keys);
  if (!k?.api_key) throw new Error(`нет ключа ${name}`);
  env[name] = k.api_key; appendFileSync(ENV, `${name}=${k.api_key}\n`);
}
ensureKey('TEST_ANON_KEY', (ks) => ks.find((x) => x.name === 'anon' || x.id === 'anon') ?? ks.find((x) => /publishable/i.test(x.name ?? '')));
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY;
if (!SERVICE) { console.error('Сначала: npm run test:reset (он сохраняет сервисный ключ тестового проекта)'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };

async function http(path, { method = 'GET', body, token = ANON, key = ANON, headers = {} } = {}) {
  const r = await fetch(URL + path, { method, headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch (_) { data = t; }
  return { status: r.status, data };
}
const fn = (name, body, token) => http(`/functions/v1/${name}`, { method: 'POST', body, token });
const rpc = (name, body, token) => http(`/rest/v1/rpc/${name}`, { method: 'POST', body, token });
const svc = (path, o = {}) => http(path, { ...o, token: SERVICE, key: SERVICE });
async function signIn(email, password) {
  const r = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  return r.data?.access_token ?? null;
}

const run = Date.now().toString(36);
const PW = 'T' + run + 'x9Qz!aa';
const headEmail = `head-${run}@journal-test.example`;
const sysEmail = `sysadmin-${run}@journal-test.example`;

// чистим счётчик попыток (только тест), чтобы прошлые прогоны не блокировали
await svc('/rest/v1/join_attempts?id=gt.0', { method: 'DELETE' });

// --- сисадмин
const su = await svc('/auth/v1/admin/users', { method: 'POST', body: { email: sysEmail, password: PW, email_confirm: true } });
const sysId = su.data?.id;
check('создан тестовый сисадмин', !!sysId, JSON.stringify(su.data).slice(0, 120));
const boot = await svc('/rest/v1/rpc/sysadmin_bootstrap', { method: 'POST', body: { p_user: sysId } });
check('sysadmin_bootstrap (service_role)', boot.status < 300, JSON.stringify(boot.data).slice(0, 120));
const sysTok = await signIn(sysEmail, PW);
check('сисадмин вошёл', !!sysTok);

// --- 1. староста регистрируется
const reg = await fn('registration-start', { name: 'Козлова Анна', email: headEmail, password: PW });
check('registration-start создал аккаунт', reg.status === 200 && reg.data?.ok === true, JSON.stringify(reg.data));
const reg2 = await fn('registration-start', { name: 'Козлова Анна', email: headEmail, password: PW });
check('повторная почта отклонена (email_taken)', reg2.status === 409 && reg2.data?.error === 'email_taken', JSON.stringify(reg2.data));
const headTok = await signIn(headEmail, PW);
check('староста вошёл', !!headTok);
const drafts = await http('/rest/v1/registration_requests?status=eq.draft&select=id', { token: headTok });
const rid = drafts.data?.[0]?.id;
check('староста видит свой черновик', !!rid, JSON.stringify(drafts.data));
const stud = ['Иванова Мария', 'Петров Дмитрий', 'Сидоренко Ольга', 'Волкова Наталья', 'Смирнов Артём'].map((n) => ({ last_name: n.split(' ')[0], first_name: n.split(' ')[1], study_form: 'budget' }));
const patch = await http(`/rest/v1/registration_requests?id=eq.${rid}`, { method: 'PATCH', token: headTok, body: {
  step: 4, payload: { group: { name: `E2E-${run}`, group_no: `E2E-${run}`, faculty: 'ФМк', study_form: 'Дневная', course: 2, bseu_faculty_id: '13', bseu_form_id: '10' },
    owner: { name: 'Козлова Анна', email: headEmail, studentIndex: 0 }, students: stud } } });
check('черновик сохранён', patch.status < 300, JSON.stringify(patch.data).slice(0, 150));
const sub = await rpc('registration_submit', { p_request: rid }, headTok);
check('заявка отправлена (draft → submitted)', sub.status < 300, JSON.stringify(sub.data).slice(0, 150));
const ntf = await fn('notify-registration', { kind: 'submitted', request_id: rid }, headTok);
check('notify-registration отвечает ok (каналы без секретов пропущены)', ntf.status === 200 && ntf.data?.ok === true, JSON.stringify(ntf.data));
const foreign = await http(`/rest/v1/registration_requests?id=eq.${rid}&select=id`, { token: await signIn('student01@journal-test.example', env.TEST_PASSWORD) });
check('чужая заявка недоступна другому пользователю', Array.isArray(foreign.data) && foreign.data.length === 0, JSON.stringify(foreign.data));

// --- 2. сисадмин одобряет
const appr = await rpc('sysadmin_approve_registration', { p_request: rid }, sysTok);
const code = appr.data?.code, gid = appr.data?.group_id;
check('сисадмин одобрил заявку, получил код и группу', appr.status < 300 && !!code && !!gid, JSON.stringify(appr.data).slice(0, 150));
const appr2 = await rpc('sysadmin_approve_registration', { p_request: rid }, sysTok);
check('повторное одобрение запрещено (already_approved)', appr2.status >= 400, JSON.stringify(appr2.data).slice(0, 150));
const notHeadApprove = await rpc('sysadmin_approve_registration', { p_request: rid }, headTok);
check('староста сам заявку не одобряет', notHeadApprove.status >= 400);

// --- 3. студент входит по коду
const look = await fn('join-group', { action: 'lookup', code });
const free = look.data?.students ?? [];
check('lookup по коду: группа и свободные студенты (без старосты)', look.status === 200 && look.data?.group?.name === `E2E-${run}` && free.length === 4, JSON.stringify(look.data).slice(0, 200));
check('в списке только id и имя', free.every((s) => Object.keys(s).sort().join() === 'id,name'));
const s1 = free[0], s2 = free[1], s3 = free[2];
const consent = { accepted: true, version: '2026-11-05', text_hash: 'a'.repeat(64) };
const noConsent = await fn('join-group', { action: 'claim', code, student_id: s1.id, login: `st1_${run}`, password: PW, consent: { accepted: false } });
check('без согласия вход невозможен', noConsent.status === 400 && noConsent.data?.error === 'consent_required', JSON.stringify(noConsent.data));
const claim1 = await fn('join-group', { action: 'claim', code, student_id: s1.id, login: `st1_${run}`, password: PW, consent });
check('студент выбрал себя и задал логин', claim1.status === 200 && claim1.data?.ok === true, JSON.stringify(claim1.data));
const claimDup = await fn('join-group', { action: 'claim', code, student_id: s1.id, login: `st1b_${run}`, password: PW, consent });
check('одну запись нельзя занять дважды (student_taken)', claimDup.status === 409 && claimDup.data?.error === 'student_taken', JSON.stringify(claimDup.data));
const loginDup = await fn('join-group', { action: 'claim', code, student_id: s2.id, login: `st1_${run}`, password: PW, consent });
check('занятый логин отклонён (login_taken), запись s2 осталась свободной', loginDup.status === 409 && loginDup.data?.error === 'login_taken', JSON.stringify(loginDup.data));
const emailOf = (login) => `${login}@students.journal-24dmm2.app`;
const st1 = await signIn(emailOf(`st1_${run}`), PW);
check('студент вошёл (ожидание)', !!st1);
const pendStud = await http('/rest/v1/students?select=id', { token: st1 });
check('ожидающий видит в students только себя', pendStud.data?.length === 1, JSON.stringify(pendStud.data));
const pendAbs = await http('/rest/v1/absences?select=id', { token: st1 });
const pendTasks = await http('/rest/v1/tasks?select=id', { token: st1 });
const pendJournal = await http('/rest/v1/journal_private?select=id', { token: st1 });
check('ожидающий не читает пропуски, задания и журнал', [pendAbs, pendTasks, pendJournal].every((r) => Array.isArray(r.data) && r.data.length === 0), JSON.stringify([pendAbs.data, pendTasks.data, pendJournal.data]).slice(0, 150));
const rem = await rpc('remind_headman', {}, st1);
check('«Напомнить старосте»', rem.status < 300, JSON.stringify(rem.data).slice(0, 150));
const rem2 = await rpc('remind_headman', {}, st1);
check('повторное напоминание в тот же час отклонено или отложено', rem2.status >= 400 || rem2.data?.ok === false || !!rem2.data?.next_at, JSON.stringify(rem2.data).slice(0, 150));

// староста подтверждает
const headStuds = await http(`/rest/v1/students?group_id=eq.${gid}&claim_status=eq.pending&select=id`, { token: headTok });
check('староста видит заявку студента (pending)', headStuds.data?.length === 1, JSON.stringify(headStuds.data));
const stFail = await rpc('membership_approve', { p_student_id: s1.id }, st1);
check('студент не подтверждает сам себя', stFail.status >= 400);
const ok = await rpc('membership_approve', { p_student_id: s1.id }, headTok);
check('«Это он»: староста подтвердил', ok.status < 300, JSON.stringify(ok.data).slice(0, 150));
const activeStuds = await http('/rest/v1/students?select=id', { token: st1 });
check('после подтверждения студент видит список группы', activeStuds.data?.length >= 5, JSON.stringify(activeStuds.data)?.slice(0, 100));
const absWrite = await http('/rest/v1/absences', { method: 'POST', token: st1, body: { id: `x-${run}`, group_id: gid, student_id: s1.id, date: '2026-11-05', subject: 'Тест', hours: 2 } });
check('студент не вносит пропуск', absWrite.status >= 400, String(absWrite.status));
const headAbs = await http('/rest/v1/absences', { method: 'POST', token: headTok, body: { id: `y-${run}`, group_id: gid, student_id: s1.id, date: '2026-11-05', subject: 'Тест', hours: 2, lesson_kind: 'lecture', created_by: undefined } });
check('староста вносит пропуск своей группы', headAbs.status < 300, JSON.stringify(headAbs.data).slice(0, 150));
const stSeesAbs = await http('/rest/v1/absences?select=id', { token: st1 });
check('студент видит пропуск, внесённый старостой', stSeesAbs.data?.length >= 1);

// «Не он»
const claim3 = await fn('join-group', { action: 'claim', code, student_id: s3.id, login: `st3_${run}`, password: PW, consent });
const st3 = await signIn(emailOf(`st3_${run}`), PW);
check('второй студент в ожидании', claim3.status === 200 && !!st3);
const rej = await rpc('membership_reject', { p_student_id: s3.id }, headTok);
check('«Не он»: староста отклонил', rej.status < 300, JSON.stringify(rej.data).slice(0, 150));
const lookAfter = await fn('join-group', { action: 'lookup', code });
check('после «Не он» запись снова свободна', (lookAfter.data?.students ?? []).some((s) => s.id === s3.id));
const rel3 = await fn('join-group', { action: 'release' }, st3);
check('отклонённый нажимает «выбрать другую фамилию» (release)', rel3.status === 200 && rel3.data?.ok === true, JSON.stringify(rel3.data));
check('после release вход старым логином невозможен', (await signIn(emailOf(`st3_${run}`), PW)) === null);

// «Это не я» в ожидании
const claim2 = await fn('join-group', { action: 'claim', code, student_id: s2.id, login: `st2_${run}`, password: PW, consent });
const st2 = await signIn(emailOf(`st2_${run}`), PW);
check('третий студент в ожидании', claim2.status === 200 && !!st2);
const rel2 = await fn('join-group', { action: 'release' }, st2);
check('«Это не я»: запись освобождена, аккаунт удалён', rel2.status === 200 && (await signIn(emailOf(`st2_${run}`), PW)) === null, JSON.stringify(rel2.data));
const relActive = await fn('join-group', { action: 'release' }, st1);
check('активного студента release не отпускает (not_pending)', relActive.status === 409 && relActive.data?.error === 'not_pending', JSON.stringify(relActive.data));

// --- 4. блок после 5 неверных кодов
await svc('/rest/v1/join_attempts?id=gt.0', { method: 'DELETE' });
const bad = [];
for (let i = 0; i < 5; i++) bad.push((await fn('join-group', { action: 'lookup', code: 'ZZZZZZZZ' })).status);
check('5 неверных кодов: ответы 404', bad.every((s) => s === 404), JSON.stringify(bad));
const blocked = await fn('join-group', { action: 'lookup', code });
check('6-я попытка (даже верным кодом) блокируется на 15 минут (429)', blocked.status === 429, `${blocked.status} ${JSON.stringify(blocked.data)}`);
await svc('/rest/v1/join_attempts?id=gt.0', { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
