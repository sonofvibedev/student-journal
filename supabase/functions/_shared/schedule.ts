// Импорт расписания группы с bseu.by и уведомления «Изменилось расписание». Общий код для schedule-import (кнопка «Обновить»)
// и schedule-nightly (ночной запуск). Даты в ответе bseu.by нет, есть номера учебных недель, поэтому неделя 1 вычисляется
// из «Текущая - N учебная неделя» и сегодняшней даты по Минску.
// Если разметка не узнана или разница с прошлой версией подозрительно большая, ничего не пишем: остаётся прошлая версия, причина в schedule_meta.last_error.
// Ограничение «не чаще раза в 10 минут» живёт только в HTTP-обёртке: ночному запуску оно не нужно.
import { admin } from './common.ts';
import { logServer } from './oplog.ts';
import { fetchSemesterHtml, parseSchedule, currentWeek, toRows, mondayOf, addDaysIso, minskToday, unknownTimes, type Row } from './bseu.ts';
import { changesFor, scheduleBody, type Change } from './schedule-text.ts';
export type { Change } from './schedule-text.ts';

const MAX_REMOVED_SHARE = 0.6;   // исчезло больше 60% будущих занятий: похоже на сбой разбора

export type ImportResult =
  | { ok: true; added: number; removed: number; changed: number; lessons: number; week1_monday: string; semester_end: string; changes: Change[] }
  | { ok: false; error: string; status: number };

type Existing = Row & { id: string; prev_room: string | null };
const keyOf = (r: { lesson_date: string; pair_no: number; subject: string; subgroup: number | null }) => `${r.lesson_date}|${r.pair_no}|${r.subject}|${r.subgroup ?? 0}`;
const hm = (t: string) => String(t).slice(0, 5);

async function loadExisting(groupId: string): Promise<Existing[]> {
  const out: Existing[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('schedule_lessons').select('id, lesson_date, pair_no, starts_at, ends_at, subject, kind, teacher, room, subgroup, prev_room, event')
      .eq('group_id', groupId).order('id').range(from, from + 999);
    if (error) throw new Error('db_read');
    out.push(...(data as Existing[]));
    if (!data || data.length < 1000) return out;
  }
}

async function fail(groupId: string, status: string, detail: string, httpStatus: number): Promise<ImportResult> {
  await admin.from('schedule_meta').upsert({ group_id: groupId, last_status: status, last_error: detail.slice(0, 300) }, { onConflict: 'group_id' });
  await admin.from('audit_log').insert({ group_id: groupId, action: 'schedule_import_failed', details: { status, detail: detail.slice(0, 300) } });
  await logServer('schedule-import', status, groupId);   // единая точка сбоев для кнопки и ночного запуска; текст ответа bseu.by не передаём
  return { ok: false, error: status, status: httpStatus };
}

export async function importGroup(groupId: string, actor: string | null): Promise<ImportResult> {
  const { data: g } = await admin.from('groups').select('id, status, course, bseu_faculty_id, bseu_form_id, bseu_group_id').eq('id', groupId).maybeSingle();
  if (!g) return { ok: false, error: 'not_found', status: 404 };
  if (g.status !== 'active') return { ok: false, error: 'group_closed', status: 409 };
  if (!g.bseu_faculty_id || !g.bseu_form_id || !g.bseu_group_id || !g.course) return { ok: false, error: 'no_bseu_ids', status: 422 };

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
  try { existing = await loadExisting(groupId); } catch (_) { await logServer('schedule-import', 'db_read', groupId); return { ok: false, error: 'server_error', status: 500 }; }
  const old = new Map(existing.map((r) => [keyOf(r), r]));
  const fresh = new Map(rows.map((r) => [keyOf(r), r]));

  const toAdd = rows.filter((r) => !old.has(keyOf(r)));
  const futureOld = existing.filter((r) => r.lesson_date >= today);
  const toRemove = futureOld.filter((r) => !fresh.has(keyOf(r)));
  const now = new Date().toISOString();
  const toChange: { id: string; patch: Record<string, unknown> }[] = [];
  // Что показать людям: только занятия сегодня и позже и только аудитория, время, преподаватель, добавлено, отменено
  const changes: Change[] = [];
  const note = (r: Row, kind: Change['kind'], from?: string | null, to?: string | null) =>
    changes.push({ date: r.lesson_date, pair_no: r.pair_no, subject: r.subject, kind, subgroup: r.subgroup as 1 | 2 | null, from, to });
  for (const r of rows) {
    const o = old.get(keyOf(r)); if (!o) continue;
    const roomChanged = (o.room ?? null) !== (r.room ?? null);
    const timeChanged = hm(o.starts_at) !== r.starts_at || hm(o.ends_at) !== r.ends_at;
    const teacherChanged = (o.teacher ?? null) !== (r.teacher ?? null);
    if (timeChanged || teacherChanged || roomChanged || o.kind !== r.kind || (o.event ?? null) !== r.event) {
      toChange.push({ id: o.id, patch: { starts_at: r.starts_at, ends_at: r.ends_at, teacher: r.teacher, room: r.room, kind: r.kind, event: r.event, updated_at: now, ...(timeChanged || teacherChanged || roomChanged || o.kind !== r.kind ? { changed_at: now } : {}), ...(roomChanged ? { prev_room: o.room } : {}) } });
      if (r.lesson_date >= today) {
        if (roomChanged) note(r, 'room', o.room, r.room);
        if (timeChanged) note(r, 'time', hm(o.starts_at) !== r.starts_at ? hm(o.starts_at) : `${hm(o.starts_at)}–${hm(o.ends_at)}`, hm(o.starts_at) !== r.starts_at ? r.starts_at : `${r.starts_at}–${r.ends_at}`);
        if (teacherChanged) note(r, 'teacher', o.teacher, r.teacher);
      }
    }
  }
  if (futureOld.length >= 20 && toRemove.length / futureOld.length > MAX_REMOVED_SHARE) {
    return fail(groupId, 'suspicious_diff', `Исчезло ${toRemove.length} из ${futureOld.length} будущих занятий; расписание не обновлено`, 409);
  }
  // Первый импорт группы (в базе пусто) — не «изменение расписания»: иначе все получили бы сотни строк «добавлено»
  if (existing.length) {
    for (const r of toAdd) if (r.lesson_date >= today) note(r, 'added');
    for (const r of toRemove) note(r, 'removed');
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
  return { ok: true, ...diff, lessons: rows.length, week1_monday: week1, semester_end: semesterEnd, changes };
}

// Одна строка notifications на получателя за импорт. Получатели: активные студенты группы (староста и зам — тоже студенты с доп. ролью),
// каждому только занятия его подгруппы. Не бросает: сбой уведомлений не должен откатывать уже записанное расписание.
// Возвращает, сколько строк создано.
export async function notifySchedule(groupId: string, changes: Change[]): Promise<number> {
  if (!changes.length) return 0;
  try {
    const [{ data: members, error: e1 }, { data: studs, error: e2 }] = await Promise.all([
      admin.from('memberships').select('user_id, student_id').eq('group_id', groupId).eq('status', 'active').eq('base_role', 'student'),
      admin.from('students').select('id, subgroup').eq('group_id', groupId),
    ]);
    if (e1 || e2) throw new Error('db_read');
    const sub = new Map((studs ?? []).map((s) => [s.id as string, s.subgroup as number | string | null]));
    const key = `schedule:${groupId}:${new Date().toISOString()}`;   // на каждый импорт свой ключ: ночной импорт после ручного обновления в тот же день тоже должен уведомить
    const rows = [];
    for (const m of members ?? []) {
      const mine = changesFor(changes, m.student_id ? sub.get(m.student_id) : null);   // без записи студента подгруппа неизвестна: подходит всё
      if (!mine.length) continue;
      rows.push({ user_id: m.user_id, group_id: groupId, kind: 'schedule', title: 'Изменилось расписание', body: scheduleBody(mine), ref: { changes: mine.length }, dedupe_key: key });
    }
    if (!rows.length) return 0;
    // Уникальный индекс (user_id, dedupe_key) частичный, onConflict у PostgREST с ним не работает: повтор за день отсекаем заранее,
    // а при гонке вставляем по одной строке и игнорируем 23505
    const { data: have } = await admin.from('notifications').select('user_id').eq('dedupe_key', key).in('user_id', rows.map((r) => r.user_id));
    const done = new Set((have ?? []).map((r) => r.user_id));
    const fresh = rows.filter((r) => !done.has(r.user_id));
    if (!fresh.length) return 0;
    const { error } = await admin.from('notifications').insert(fresh);
    if (!error) return fresh.length;
    if (error.code !== '23505') throw new Error(error.code ?? 'db_write');
    let n = 0;
    for (const r of fresh) {
      const { error: e } = await admin.from('notifications').insert(r);
      if (!e) n++; else if (e.code !== '23505') throw new Error(e.code ?? 'db_write');
    }
    return n;
  } catch (e) {
    console.error('notifySchedule', e instanceof Error ? e.message.slice(0, 40) : 'unknown');
    return 0;
  }
}
