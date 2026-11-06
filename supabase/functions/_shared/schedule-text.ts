// Чистая логика уведомления «Изменилось расписание»: строки, «и ещё N», подгруппа.
// Без импортов и без Deno: файл читает и сама функция, и node-тест (tests/unit/schedule-notify.mjs).
export type Change = {
  date: string; pair_no: number; subject: string;
  kind: 'room' | 'time' | 'teacher' | 'added' | 'removed';
  subgroup: 1 | 2 | null; from?: string | null; to?: string | null;
};

export const MAX_LINES = 5;   // в Telegram длинный список не читают: пять строк и «и ещё N»
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// «2026-11-12» → «12 ноября»
export const ruDate = (iso: string) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
  return m && MONTHS[Number(m[1]) - 1] ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : iso;
};

const val = (v?: string | null) => (v ? v : 'не указана');

export function changeLine(c: Change): string {
  const head = `${c.subject}, ${ruDate(c.date)}`;
  switch (c.kind) {
    case 'room': return `${head}: аудитория ${val(c.from)} → ${val(c.to)}`;
    case 'time': return `${head}: время ${c.from ?? '—'} → ${c.to ?? '—'}`;
    case 'teacher': return `${head}: преподаватель ${c.from || 'не указан'} → ${c.to || 'не указан'}`;
    case 'added': return `${head}: добавлено занятие`;
    default: return `${head}: занятие отменено`;
  }
}

// Подходит ли занятие студенту: подгруппа студента не выбрана (null/0) или занятия — подходят все
export const fitsSubgroup = (lessonSubgroup: number | null, studentSubgroup: number | string | null | undefined) => {
  const s = Number(studentSubgroup) || 0;
  return !lessonSubgroup || !s || Number(lessonSubgroup) === s;
};

export const changesFor = (changes: Change[], studentSubgroup: number | string | null | undefined) =>
  changes.filter((c) => fitsSubgroup(c.subgroup, studentSubgroup));

// Текст уведомления: по дате и паре, до MAX_LINES строк, остальное «и ещё N»
export function scheduleBody(changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => a.date.localeCompare(b.date) || a.pair_no - b.pair_no);
  const lines = sorted.slice(0, MAX_LINES).map(changeLine);
  if (sorted.length > MAX_LINES) lines.push(`и ещё ${sorted.length - MAX_LINES}`);
  return lines.join('\n');
}
