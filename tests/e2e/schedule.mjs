// Импорт расписания (Edge Function schedule-import) на ТЕСТОВОМ проекте, с живым bseu.by (read-only запрос к чужому сайту).
// Запуск: node tests/e2e/schedule.mjs   (после npm run test:reset и test:deploy)
import { readFileSync } from 'node:fs';
import { assertTestTarget } from '../../tools/test/guard.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL_SB = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL_SB);
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY;
const G = '00000000-0000-4000-8000-000000000024';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const get = async (p) => (await fetch(`${URL_SB}/rest/v1/${p}`, { headers: svc })).json();
async function session(email) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: env.TEST_PASSWORD }) })).json();
  return r.access_token ? r : null;
}
const call = async (token, body) => {
  const r = await fetch(`${URL_SB}/functions/v1/schedule-import`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const clean = async () => {
  await fetch(`${URL_SB}/rest/v1/notifications?group_id=eq.${G}&kind=eq.schedule`, { method: 'DELETE', headers: svc });
  await fetch(`${URL_SB}/rest/v1/schedule_lessons?group_id=eq.${G}`, { method: 'DELETE', headers: svc });
  await fetch(`${URL_SB}/rest/v1/schedule_meta?group_id=eq.${G}`, { method: 'DELETE', headers: svc });
};

try {
  await clean();
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id`);
  const hu = await (await fetch(`${URL_SB}/auth/v1/admin/users/${heads[0].user_id}`, { headers: svc })).json();
  const hs = await session(hu.email), st = await session('student02@journal-test.example');
  check('староста и студент вошли', !!hs && !!st);

  check('без токена: 401', (await call(ANON, { group_id: G })).status === 401);
  check('обычный студент: 403', (await call(st.access_token, { group_id: G })).status === 403);
  check('плохой group_id: 400', (await call(hs.access_token, { group_id: 'x' })).status === 400);

  const r1 = await call(hs.access_token, { group_id: G });
  check('староста: импорт прошёл', r1.status === 200 && r1.data?.ok === true, JSON.stringify(r1));
  const rows = await get(`schedule_lessons?group_id=eq.${G}&select=lesson_date,pair_no,subject,kind,subgroup,starts_at&limit=2000`);
  check('занятия записаны (сотни строк по датам)', rows.length > 100 && rows.length === r1.data?.added, `${rows.length} / ${r1.data?.added}`);
  check('все добавлено, ничего не удалено и не изменено', r1.data?.removed === 0 && r1.data?.changed === 0);
  check('виды занятий и подгруппы корректны', rows.every((r) => ['lecture', 'practice', 'lab', 'other'].includes(r.kind) && [null, 1, 2].includes(r.subgroup)));
  check('даты в пределах семестра', rows.every((r) => r.lesson_date >= '2026-08-31' && r.lesson_date <= '2027-02-28'));
  const meta = (await get(`schedule_meta?group_id=eq.${G}&select=*`))[0];
  check('schedule_meta: статус ok, неделя 1 — понедельник, конец семестра', meta?.last_status === 'ok' && /^2026-08-31/.test(meta.week1_monday) && !!meta.semester_end, JSON.stringify(meta));

  const r2 = await call(hs.access_token, { group_id: G });
  check('повтор сразу: 429 «слишком часто»', r2.status === 429 && r2.data?.error === 'too_soon', JSON.stringify(r2));

  // имитируем прошедшие 10 минут и меняем данные: аудитория и лишнее занятие в будущем
  await fetch(`${URL_SB}/rest/v1/schedule_meta?group_id=eq.${G}`, { method: 'PATCH', headers: svc, body: JSON.stringify({ last_import_at: '2026-01-01T00:00:00Z' }) });
  const fut = rows.filter((r) => r.lesson_date >= '2026-11-10').sort((a, b) => a.lesson_date.localeCompare(b.lesson_date))[0];
  await fetch(`${URL_SB}/rest/v1/schedule_lessons?group_id=eq.${G}&lesson_date=eq.${fut.lesson_date}&pair_no=eq.${fut.pair_no}&subject=eq.${encodeURIComponent(fut.subject)}`, { method: 'PATCH', headers: svc, body: JSON.stringify({ room: '9/999' }) });
  await fetch(`${URL_SB}/rest/v1/schedule_lessons`, { method: 'POST', headers: svc, body: JSON.stringify({ group_id: G, lesson_date: '2026-12-01', pair_no: 2, starts_at: '09:45', ends_at: '11:05', subject: 'Лишнее занятие', kind: 'lecture' }) });
  const r3 = await call(hs.access_token, { group_id: G });
  check('повторный импорт: одна правка и одно удаление, ничего нового', r3.status === 200 && r3.data?.changed === 1 && r3.data?.removed === 1 && r3.data?.added === 0, JSON.stringify(r3));
  const ntf = await get(`notifications?group_id=eq.${G}&kind=eq.schedule&select=user_id,body,tg_status&order=created_at.desc&limit=50`);
  check('об изменении расписания уведомлены студенты (в колокольчик, с текстом про аудиторию)', r3.data?.notified > 0 && ntf.length > 0 && ntf.every((n) => /аудитория/.test(n.body) || /занятие отменено/.test(n.body)), JSON.stringify({ n: r3.data?.notified, c: ntf.length }));
  const back = (await get(`schedule_lessons?group_id=eq.${G}&lesson_date=eq.${fut.lesson_date}&pair_no=eq.${fut.pair_no}&subject=eq.${encodeURIComponent(fut.subject)}&select=room,prev_room,changed_at`))[0];
  check('при смене аудитории запомнена прежняя (prev_room) и время правки', back?.prev_room === '9/999' && !!back.changed_at, JSON.stringify(back));
  const extra = await get(`schedule_lessons?group_id=eq.${G}&subject=eq.${encodeURIComponent('Лишнее занятие')}&select=id`);
  check('лишнее будущее занятие удалено', extra.length === 0);

  const log = await get(`audit_log?group_id=eq.${G}&action=eq.schedule_import&select=details&order=at.desc&limit=3`);
  check('в журнале действий есть записи импорта', log.length >= 2 && log[0].details?.lessons > 100, JSON.stringify(log[0]));

  // подозрительная разница: имитируем «разметка поменялась» удалением из памяти нельзя, поэтому проверяем защиту отдельным запросом к чужой группе
  const bad = await call(hs.access_token, { group_id: '11111111-1111-4111-8111-111111111111' });
  check('чужая или несуществующая группа: отказ', bad.status === 403 || bad.status === 404, JSON.stringify(bad));
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
} finally {
  await clean();
}
const failed = results.filter((x) => !x).length;
console.log(`\nИтого: ${results.length - failed} из ${results.length}${failed ? `, провалов ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
