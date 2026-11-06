// Ночной импорт расписания всех активных групп (pg_cron в 03:00 по Минску, заголовок x-cron-secret).
// Группы по очереди с паузой 2 с: bseu.by чужой сайт, не нагружаем. Изменения превращаются в уведомления `schedule`.
// Сбой группы: сразу алерт сисадминам (только код ошибки и название группы, без ответа bseu.by).
// Сводка за ночь сисадминам: при любом сбое или если расписание менялось; тихая ночь без изменений сообщений не даёт.
import { admin, cors, json } from '../_shared/common.ts';
import { importGroup, notifySchedule } from '../_shared/schedule.ts';
import { alertSysadmins } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';

const PAUSE_MS = 2000;
const BUDGET_MS = 140_000;   // лимит времени Edge Function ~150 с: что не успели, объявляем сбоем, а не теряем молча
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'forbidden' }, 403);

  const { data: groups, error } = await admin.from('groups').select('id, name')
    .eq('status', 'active').not('bseu_faculty_id', 'is', null).not('bseu_form_id', 'is', null).not('bseu_group_id', 'is', null).not('course', 'is', null).order('name');
  if (error) { await logServer('schedule-nightly', 'groups_read_failed', error.code ?? 'error'); await alertSysadmins('Журнал: сбой импорта расписания', 'Не удалось прочитать список групп'); return json({ error: 'server_error' }, 500); }

  const started = Date.now();
  const failures: string[] = [];
  let ok = 0, lessons = 0, changes = 0, notified = 0;
  for (const [i, g] of (groups ?? []).entries()) {
    if (Date.now() - started > BUDGET_MS) {
      const left = (groups ?? []).slice(i).map((x) => x.name).join(', ');
      failures.push(`не хватило времени: ${left}`);
      await logServer('schedule-nightly', 'budget_exceeded', left);
      await alertSysadmins('Журнал: сбой импорта расписания', `Не хватило времени, не обработаны группы: ${left}`);
      break;
    }
    if (i) await sleep(PAUSE_MS);
    let r;
    try { r = await importGroup(g.id, null); } catch (e) { await logServer('schedule-nightly', 'exception', `${g.name}: ${e instanceof Error ? e.name : 'unknown'}`); r = { ok: false as const, error: 'exception', status: 500 }; }
    if (!r.ok) {
      failures.push(`${g.name}: ${r.error}`);
      await alertSysadmins('Журнал: сбой импорта расписания', `Группа ${g.name}: ${r.error}`);
      continue;
    }
    ok++; lessons += r.lessons; changes += r.changes.length;
    notified += await notifySchedule(g.id, r.changes);
  }

  const total = (groups ?? []).length;
  if (failures.length || changes > 0) {
    await alertSysadmins('Журнал: итоги ночного импорта расписания',
      `Групп: ${total}, успешно: ${ok}, занятий: ${lessons}, изменений: ${changes}.` + (failures.length ? `\nСбои:\n${failures.join('\n')}` : ''));
  }
  await admin.from('audit_log').insert({ action: 'schedule_nightly', details: { groups: total, ok, failed: failures.length, lessons, changes, notified } });
  return json({ ok: true, groups: total, imported: ok, failed: failures.length, lessons, changes, notified });
});
