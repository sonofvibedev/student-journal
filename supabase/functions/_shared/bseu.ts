// Общее для функций, которые ходят на bseu.by/schedule: запрос, справочники и разбор расписания.
// Разведка запросов: docs/research/bseu-schedule.md. Ответ расписания в cp1251; занятия лежат в HTML-комментариях
// `<!--week: …, Discipline: …, Teacher: …-->` (устойчивее таблицы). Все комментарии идут до таблицы, времени в них нет:
// время берём по номеру пары из PAIR_TIMES.
export const URL_BSEU = 'https://bseu.by/schedule/';
export const ACT = {
  forms: '__id.22.main.inpFldsA.GetForms',
  courses: '__id.23.main.inpFldsA.GetCourse',
  groups: '__id.23.main.inpFldsA.GetGroups',
  schedule: '__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main',
};

export async function post(fields: Record<string, string>): Promise<Uint8Array> {
  const r = await fetch(URL_BSEU, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'journal-schedule/1.0' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`bseu_${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function options(fields: Record<string, string>) {
  const text = new TextDecoder('utf-8').decode(await post(fields));
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('format');
  return list.filter((x) => x && typeof x.value === 'string' && typeof x.text === 'string').map((x) => ({ value: x.value, text: x.text }));
}

// Расписание группы за семестр (period=3), уже в виде текста
export async function fetchSemesterHtml(f: { faculty: string; form: string; course: string; group: string }): Promise<string> {
  return new TextDecoder('windows-1251').decode(await post({ ...f, period: '3', __act: ACT.schedule }));
}

export type Lesson = { week: string; day: string; pair: string; subject: string; kind: string; teacher: string; room: string; subgroup: string };

// Звонки БГЭУ по номеру пары. Первая пара в данных группы не встречалась (8:15 выведено из перерывов); сверка с таблицей страницы — unknownTimes().
export const PAIR_TIMES: Record<number, string> = {
  1: '8:15-9:35', 2: '9:45-11:05', 3: '11:15-12:35', 4: '13:05-14:25', 5: '14:35-15:55', 6: '16:05-17:25', 7: '17:45-19:05', 8: '19:15-20:35',
};
// Времена из таблицы страницы, которых нет в PAIR_TIMES: сигнал, что звонки поменялись
export function unknownTimes(html: string): string[] {
  const known = new Set(Object.values(PAIR_TIMES));
  return [...new Set([...html.matchAll(/<td[^>]*>\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s*<\/td>/g)].map((m) => m[1]))].filter((t) => !known.has(t));
}

export function parseSchedule(html: string) {
  const re = /<!--week:\s*(\([^)]*\)|[^,]*),\s*DayNumber:\s*([^,]*),\s*PairNumber:\s*([^,]*),\s*Discipline:\s*(.*?),\s*ClassType:\s*(.*?),\s*EngClassType:\s*(.*?),\s*Teacher:\s*(.*?),\s*campus:\s*(.*?),\s*numbaudit:\s*(.*?),\s*text:\s*(.*?),\s*semester:\s*(.*?),\s*numbsub:\s*(.*?)-->/g;
  const lessons: Lesson[] = [];
  let semester: string | null = null;
  for (const m of html.matchAll(re)) {
    if (m[5].trim() === 'null') continue;   // служебная строка с названием группы
    semester ??= m[11].trim() || null;
    lessons.push({ week: m[1].trim(), day: m[2].trim(), pair: m[3].trim(), subject: m[4].trim(), kind: m[5].trim(), teacher: m[7].trim(), room: `${m[8].trim()}/${m[9].trim()}`, subgroup: m[12].trim() });
  }
  return { lessons, semester };
}

// «(12-14,16)» → [12,13,14,16]
export function expandWeeks(w: string): number[] {
  const out: number[] = [];
  for (const part of w.replace(/[()\s]/g, '').split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.push(n);
  }
  return out;
}

export const kindOf = (t: string): 'lecture' | 'practice' | 'lab' | 'other' => {
  const s = t.toLowerCase();
  return s.startsWith('лекц') ? 'lecture' : s.startsWith('практ') ? 'practice' : s.startsWith('лаб') ? 'lab' : 'other';
};

// Номер текущей учебной недели со страницы: «Текущая - <strong>10</strong> учебная неделя»
export function currentWeek(html: string): number | null {
  const m = html.match(/Текущая\s*-\s*<strong>\s*(\d+)\s*<\/strong>\s*учебная/);
  return m ? Number(m[1]) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const minskToday = () => isoDate(new Date(Date.now() + 3 * 3600e3));
export const addDaysIso = (iso: string, n: number) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return isoDate(t); };
// Понедельник недели, в которой лежит дата (журнал живёт по Минску)
export const mondayOf = (iso: string) => addDaysIso(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));

export type Row = { lesson_date: string; pair_no: number; starts_at: string; ends_at: string; subject: string; kind: string; teacher: string | null; room: string | null; subgroup: number | null };

// Занятия по датам. week1Monday — понедельник первой недели семестра (из «Текущая - N неделя» и сегодняшней даты)
export function toRows(lessons: Lesson[], week1Monday: string): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const l of lessons) {
    const day = Number(l.day), pair = Number(l.pair);
    const t = PAIR_TIMES[pair]?.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!(day >= 1 && day <= 7) || !t) continue;
    const sub = Number(l.subgroup);
    for (const w of expandWeeks(l.week)) {
      const row: Row = {
        lesson_date: addDaysIso(week1Monday, (w - 1) * 7 + (day - 1)), pair_no: pair,
        starts_at: `${pad(Number(t[1]))}:${t[2]}`, ends_at: `${pad(Number(t[3]))}:${t[4]}`,
        subject: l.subject, kind: kindOf(l.kind), teacher: l.teacher && l.teacher !== 'null' ? l.teacher : null,
        room: l.room && !/null/.test(l.room) && l.room.replace(/[\/\s0]/g, '') ? l.room : null, subgroup: sub === 1 || sub === 2 ? sub : null,
      };
      const key = `${row.lesson_date}|${row.pair_no}|${row.subject}|${row.subgroup ?? 0}`;
      if (seen.has(key)) continue;       // то же занятие дважды в разборе: берём первое
      seen.add(key); rows.push(row);
    }
  }
  return rows;
}
