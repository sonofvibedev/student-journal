// Журнал 2.1, п.13: как старые «справки в пропусках» (absences.cert_type / cert_submitted / cert_due_date) сливаются
// в справки public.certificates. Чистая функция без сети и базы: её использует tests/unit/certs-merge.mjs.
// Тот же алгоритм написан на SQL в supabase/migrations/20261122100000_journal21_certificates.sql (раздел «Перенос данных»);
// tests/unit/certs-merge.mjs сверяет оба на копии данных (PGlite), если он установлен.
//
// Правила:
//  - справка нужна уважительному пропуску с датой и причиной (cert_type); без причины — справки нет (так их и показывал 2.0:
//    «уважительная, документ не ждём»), неуважительным справка не нужна;
//  - вид: «Больничный» → sick, «Освобождение» → exemption, «Заявление» → statement, любая другая причина → other;
//  - больничные одного студента сливаются в одну справку, если между соседними датами нет ни одного учебного дня
//    (учебный день = дата из расписания группы schedule_lessons; выходные и праздники разрывом не считаются);
//    исключение владельца — JOIN: день, который у этого студента разрывом не считается;
//  - освобождение, заявление и прочее — одна справка на студента, вид и день (все пары этого дня);
//  - «Сдана» — только если сданы все слитые пропуски; если часть сдана — «Не сдана», а в note перечислены даты обеих частей;
//  - срок сдачи — самый поздний из слитых; id справки детерминированный: 'ce-m13-' + md5(студент|вид|начало) — как в SQL
//    (префикс ce-m13- — метка переноса: откат удаляет только такие и созданные триггером ce-a-).
import { createHash } from 'node:crypto';

export const certKind = (t) => {
  const s = String(t ?? '').trim();
  return !s ? null : s === 'Больничный' ? 'sick' : s === 'Освобождение' ? 'exemption' : s === 'Заявление' ? 'statement' : 'other';
};
export const KIND_RU = { sick: 'Больничный', exemption: 'Освобождение', statement: 'Заявление', other: 'Справка' };
// Решение владельца (2026-11-14): Ракитская и Щигло — один больничный 19.10–24.10, хотя 21.10 у группы были пары
// (пропусков в тот день не внесено). Общее правило не меняется; то же в миграции (v_join).
export const JOIN = [{ student_id: 'st-1758300000013', day: '2026-10-21' }, { student_id: 'st-1758300000024', day: '2026-10-21' }];
export const certId = (studentId, kind, from) => 'ce-m13-' + createHash('md5').update(`${studentId}|${kind}|${from}`).digest('hex');
const ddmm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const uniq = (a) => [...new Set(a)];

// Записка о смешанной сдаче: одна строка, как в SQL (даты по возрастанию, без повторов)
export const mixedNote = (rows) => {
  const yes = uniq(rows.filter((a) => a.cert_submitted).map((a) => a.date)).sort().map(ddmm);
  const no = uniq(rows.filter((a) => !a.cert_submitted).map((a) => a.date)).sort().map(ddmm);
  return `Объединено из пропусков: сдано за ${yes.join(', ')}; не сдано за ${no.join(', ')}`;
};

// absences — строки public.absences; studyDays — Map(group_id → массив дат 'YYYY-MM-DD') учебных дней группы.
// Возвращает { certs, skipped, gaps }:
//   certs   — будущие справки с частями (parts — слитые старые записи-пропуски);
//   skipped — пропуски, которым справка не нужна или уже есть: why = 'already' | 'no_type' | 'no_date';
//   gaps    — соседние больничные одного студента, которые НЕ слились: между ними учебные дни (between).
export function mergeCerts(absences, studyDays, join = JOIN) {
  const skipped = [], src = [];
  for (const a of absences) {
    if (!a.is_excused) continue;
    if (a.certificate_id) { skipped.push({ a, why: 'already' }); continue; }
    const kind = certKind(a.cert_type);
    if (!kind) { skipped.push({ a, why: 'no_type' }); continue; }
    if (!a.date) { skipped.push({ a, why: 'no_date' }); continue; }
    src.push({ ...a, kind });
  }
  const groups = new Map();                                   // студент + вид → пропуски
  for (const a of src) {
    const k = `${a.group_id}|${a.student_id}|${a.kind}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const certs = [], gaps = [];
  for (const rows of groups.values()) {
    const { group_id, student_id, kind } = rows[0];
    const days = (studyDays.get(group_id) || []).slice().sort();
    const skip = new Set(join.filter((j) => j.student_id === student_id).map((j) => j.day));
    const between = (x, y) => days.filter((d) => d > x && d < y && !skip.has(d));
    const dates = uniq(rows.map((a) => a.date)).sort();
    const islands = [];
    dates.forEach((d, i) => {
      const prev = dates[i - 1];
      const gap = prev ? between(prev, d) : [];
      if (kind !== 'sick' || !prev || gap.length) {
        if (kind === 'sick' && prev) gaps.push({ group_id, student_id, kind, prev, next: d, between: gap });
        islands.push([d]);
      } else islands[islands.length - 1].push(d);
    });
    for (const isl of islands) {
      const parts = rows.filter((a) => isl.includes(a.date)).sort((x, y) => x.date.localeCompare(y.date) || String(x.id).localeCompare(String(y.id)));
      const from = isl[0], to = isl[isl.length - 1];
      const all = parts.every((a) => a.cert_submitted), any = parts.some((a) => a.cert_submitted);
      const dues = uniq(parts.map((a) => a.cert_due_date).filter(Boolean)).sort();
      certs.push({
        id: certId(student_id, kind, from), group_id, student_id, kind, date_from: from, date_to: to, open: false,
        status: all ? 'received' : 'waiting', due_date: dues.length ? dues[dues.length - 1] : null,
        note: any && !all ? mixedNote(parts) : null,
        absence_ids: parts.map((a) => a.id), hours: parts.reduce((n, a) => n + (Number(a.hours) || 0), 0),
        subjects: uniq(parts.map((a) => String(a.subject || '').trim() || 'Без предмета')).sort((x, y) => x.localeCompare(y, 'ru')),
        mixedSubmitted: any && !all, mixedDue: dues.length > 1, dues, parts,
      });
    }
  }
  certs.sort((x, y) => x.student_id.localeCompare(y.student_id) || x.date_from.localeCompare(y.date_from) || x.kind.localeCompare(y.kind));
  return { certs, skipped, gaps };
}
