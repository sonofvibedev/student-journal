// Импорт расписания группы с bseu.by в schedule_lessons (кнопка «Обновить» у старосты и сисадмина; ночной запуск по расписанию — этап 3).
//   { group_id }  → { ok, added, removed, changed, lessons, week1_monday, semester_end }
// Кто может: сисадмин, староста или заместитель этой группы, либо вызов секретным ключом (задача по расписанию).
// Даты в ответе bseu.by нет, есть номера учебных недель, поэтому неделя 1 вычисляется из «Текущая - N учебная неделя» и сегодняшней даты по Минску.
// Если разметка не узнана или разница с прошлой версией подозрительно большая, ничего не пишем: остаётся прошлая версия, причина в schedule_meta.last_error.
import { admin, cors, json, secretKey } from '../_shared/common.ts';
import { fetchSemesterHtml, parseSchedule, currentWeek, toRows, mondayOf, addDaysIso, minskToday, unknownTimes, type Row } from '../_shared/bseu.ts';

const MIN_GAP_MIN = 10;          // чаще раза в 10 минут руками не обновляем (нагрузка на bseu.by)
const MAX_REMOVED_SHARE = 0.6;   // исчезло больше 60% будущих занятий: похоже на сбой разбора

type Existing = Row & { id: string; prev_room: string | null };
const keyOf = (r: { lesson_date: string; pair_no: number; subject: string; subgroup: number | null }) => `${r.lesson_date}|${r.pair_no}|${r.subject}|${r.subgroup ?? 0}`;
const hm = (t: string) => String(t).slice(0, 5);

async function loadExisting(groupId: string): Promise<Existing[]> {
  const out: Existing[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('schedule_lessons').select('id, lesson_date, pair_no, starts_at, ends_at, subject, kind, teacher, room, subgroup, prev_room')
      .eq('group_id', groupId).order('id').range(from, from + 999);
    if (error) throw new Error('db_read');
    out.push(...(data as Existing[]));
    if (!data || data.length < 1000) return out;
  }
}

async function fail(groupId: string, status: string, detail: string, httpStatus: number) {
  await admin.from('schedule_meta').upsert({ group_id: groupId, last_status: status, last_error: detail.slice(0, 300) }, { onConflict: 'group_id' });
  await admin.from('audit_log').insert({ group_id: groupId, action: 'schedule_import_failed', details: { status, detail: detail.slice(0, 300) } });
  return json({ error: status }, httpStatus);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const groupId = String(body.group_id ?? '');
  if (!/^[0-9a-f-]{36}$/.test(groupId)) return json({ error: 'bad_request' }, 400);

  // Кто звонит
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const isService = !!token && token === secretKey();
  let actor: string | null = null;
  if (!isService) {
    const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    actor = auth.user.id;
    const [{ data: sa }, { data: m }] = await Promise.all([
      admin.from('sysadmins').select('user_id').eq('user_id', actor).maybeSingle(),
      admin.from('memberships').select('extra_role').eq('user_id', actor).eq('group_id', groupId).eq('status', 'active').maybeSingle(),
    ]);
    if (!sa && !(m && (m.extra_role === 'headman' || m.extra_role === 'deputy'))) return json({ error: 'forbidden' }, 403);
  }

  const { data: g } = await admin.from('groups').select('id, status, course, bseu_faculty_id, bseu_form_id, bseu_group_id').eq('id', groupId).maybeSingle();
  if (!g) return json({ error: 'not_found' }, 404);
  if (g.status !== 'active') return json({ error: 'group_closed' }, 409);
  if (!g.bseu_faculty_id || !g.bseu_form_id || !g.bseu_group_id || !g.course) return json({ error: 'no_bseu_ids' }, 422);

  const { data: meta } = await admin.from('schedule_meta').select('last_import_at').eq('group_id', groupId).maybeSingle();
  if (!isService && meta?.last_import_at && Date.now() - new Date(meta.last_import_at).getTime() < MIN_GAP_MIN * 60_000) return json({ error: 'too_soon' }, 429);

  let html: string;
  try { html = await fetchSemesterHtml({ faculty: g.bseu_faculty_id, form: g.bseu_form_id, course: String(g.course), group: g.bseu_group_id }); }
  catch (e) { return fail(groupId, 'bseu_unavailable', String((e as Error).message ?? e), 502); }

  const { lessons } = parseSchedule(html);
  if (!lessons.length) return fail(groupId, 'format_unrecognized', 'В ответе bseu.by не найдено ни одного занятия', 502);
  const cw = currentWeek(html);
  if (!cw) return fail(groupId, 'week_unknown', 'Не найден номер текущей учебной недели', 502);

  const today = minskToday();
  const week1 = addDaysIso(mondayOf(today), -(cw - 1) * 7);
  const rows = toRows(lessons, week1);
  if (!rows.length) return fail(groupId, 'format_unrecognized', 'Не удалось получить даты занятий', 502);

  let existing: Existing[];
  try { existing = await loadExisting(groupId); } catch (_) { return json({ error: 'server_error' }, 500); }
  const old = new Map(existing.map((r) => [keyOf(r), r]));
  const fresh = new Map(rows.map((r) => [keyOf(r), r]));

  const toAdd = rows.filter((r) => !old.has(keyOf(r)));
  const futureOld = existing.filter((r) => r.lesson_date >= today);
  const toRemove = futureOld.filter((r) => !fresh.has(keyOf(r)));
  const now = new Date().toISOString();
  const toChange: { id: string; patch: Record<string, unknown> }[] = [];
  for (const r of rows) {
    const o = old.get(keyOf(r)); if (!o) continue;
    const roomChanged = (o.room ?? null) !== (r.room ?? null);
    if (hm(o.starts_at) !== r.starts_at || hm(o.ends_at) !== r.ends_at || (o.teacher ?? null) !== (r.teacher ?? null) || roomChanged || o.kind !== r.kind) {
      toChange.push({ id: o.id, patch: { starts_at: r.starts_at, ends_at: r.ends_at, teacher: r.teacher, room: r.room, kind: r.kind, changed_at: now, updated_at: now, ...(roomChanged ? { prev_room: o.room } : {}) } });
    }
  }
  if (futureOld.length >= 20 && toRemove.length / futureOld.length > MAX_REMOVED_SHARE) {
    return fail(groupId, 'suspicious_diff', `Исчезло ${toRemove.length} из ${futureOld.length} будущих занятий; расписание не обновлено`, 409);
  }

  // Запись: сначала добавление и правки, удаление последним (при сбое остаётся прошлая версия плюс новое)
  for (let i = 0; i < toAdd.length; i += 500) {
    const { error } = await admin.from('schedule_lessons').insert(toAdd.slice(i, i + 500).map((r) => ({ ...r, group_id: groupId })));
    if (error) return fail(groupId, 'db_write', error.message, 500);
  }
  for (const c of toChange) {
    const { error } = await admin.from('schedule_lessons').update(c.patch).eq('id', c.id);
    if (error) return fail(groupId, 'db_write', error.message, 500);
  }
  for (let i = 0; i < toRemove.length; i += 200) {
    const { error } = await admin.from('schedule_lessons').delete().in('id', toRemove.slice(i, i + 200).map((r) => r.id));
    if (error) return fail(groupId, 'db_write', error.message, 500);
  }

  const semesterEnd = rows.reduce((m, r) => (r.lesson_date > m ? r.lesson_date : m), week1);
  await admin.from('schedule_meta').upsert({ group_id: groupId, week1_monday: week1, semester_start: week1, semester_end: semesterEnd, last_import_at: now, last_status: 'ok', last_error: null, lessons_count: rows.length }, { onConflict: 'group_id' });
  await admin.from('groups').update({ semester_end: semesterEnd, schedule_status: 'found' }).eq('id', groupId);
  const diff = { added: toAdd.length, removed: toRemove.length, changed: toChange.length };
  const odd = unknownTimes(html);   // звонки поменялись: расписание записано, но сисадмин увидит пометку в логе
  await admin.from('audit_log').insert({ actor, group_id: groupId, action: 'schedule_import', details: { ...diff, lessons: rows.length, ...(odd.length ? { unknown_times: odd } : {}) } });
  return json({ ok: true, ...diff, lessons: rows.length, week1_monday: week1, semester_end: semesterEnd });
});
