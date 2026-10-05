// Пересчёт достижений и рейтинга.
//
// Запускается по расписанию (pg_cron, раз в час) и по кнопке «Обновить» у админа.
// Берёт пропуски из опубликованного data.json, учебные дни из study-days.json
// и события студентов из таблицы app_events, считает достижения и записывает
// результат в student_achievements и leaderboard.
//
// Почему считает сервер, а не браузер: всё, что считает клиент, клиент может
// и подделать. Значки и баллы пишутся только отсюда, под секретным ключом.
//
// Доступ: заголовок x-cron-secret (запуск по расписанию) либо JWT студента,
// у которого в data.json стоит isAdmin.
//
// Все даты — строки «ГГГГ-ММ-ДД». Их сравнение лексикографическое и совпадает
// с хронологическим, поэтому часовые пояса в расчёт не вмешиваются.

import { admin, cors, json } from '../_shared/common.ts';

const BASE_URL = (Deno.env.get('JOURNAL_BASE_URL') ?? 'https://sonofvibedev.github.io/student-journal').replace(/\/+$/, '');
const POINTS_PER_UNEXCUSED_HOUR = 5;

type Absence = {
  id?: string;
  studentId?: string;
  date?: string;
  totalHours?: number | string;
  isExcused?: boolean;
  certDueDate?: string | null;
  certSubmittedAt?: string | null;
};
type Homework = { id?: string; subject?: string; type?: string; dueDate?: string };
type Student = { id?: string; isAdmin?: boolean };
type Journal = { students?: Student[]; absences?: Absence[]; homework?: Homework[]; lastUpdated?: string };
type StudyDays = { semester?: string; days?: string[]; semesterStart?: string; semesterEnd?: string };
type CatalogRow = {
  code: string; category: string; points: number;
  group_code: string | null; threshold: number | null; is_anti: boolean; is_repeatable: boolean;
};

const monthOf = (date: string) => date.slice(0, 7);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/${path}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return await res.json() as T;
}

// Запуск разрешён cron по секрету или админу журнала по его JWT
async function authorize(req: Request, journal: Journal): Promise<string | null> {
  const secret = Deno.env.get('CRON_SECRET');
  if (secret && req.headers.get('x-cron-secret') === secret) return null;

  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return 'Нужен заголовок x-cron-secret или вход администратора';

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return 'Сессия не подошла';

  const { data: profile } = await admin.from('profiles').select('student_id').eq('user_id', data.user.id).maybeSingle();
  if (!profile) return 'У пользователя нет профиля';

  const student = (journal.students ?? []).find((s) => s.id === profile.student_id);
  if (!student?.isAdmin) return 'Пересчёт доступен только администратору журнала';
  return null;
}

// Зеркала data.json: по домашке проверяется отметка «Сделано», по пропускам идёт счёт
async function syncJournal(journal: Journal, from: string, to: string) {
  const homework = (journal.homework ?? [])
    .filter((h) => h.id)
    .map((h) => ({ id: String(h.id), subject: h.subject ?? null, type: h.type ?? null, due_date: h.dueDate ?? null }));
  if (homework.length) await admin.from('journal_homework').upsert(homework, { onConflict: 'id' });

  const absences = (journal.absences ?? [])
    .filter((a) => a.id && a.studentId && a.date && a.date >= from && a.date <= to)
    .map((a) => ({
      source_id: String(a.id),
      student_id: String(a.studentId),
      date: a.date,
      hours: num(a.totalHours),
      is_excused: !!a.isExcused,
      cert_due_date: a.certDueDate || null,
      cert_submitted_at: a.certSubmittedAt || null,
    }));
  if (absences.length) await admin.from('journal_absences').upsert(absences, { onConflict: 'source_id' });
}

// Самая длинная серия учебных дней подряд без неуважительного пропуска.
// Уважительный пропуск серию не прерывает, день без пар в счёт не идёт.
function longestStreak(studyDays: string[], badDays: Set<string>): number {
  let best = 0;
  let run = 0;
  for (const day of studyDays) {
    if (badDays.has(day)) run = 0;
    else best = Math.max(best, ++run);
  }
  return best;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const [journal, study] = await Promise.all([
      fetchJson<Journal>('data.json'),
      fetchJson<StudyDays>('study-days.json'),
    ]);

    const denied = await authorize(req, journal);
    if (denied) return json({ error: denied }, 403);

    const semester = study.semester ?? 'unknown';
    const allStudyDays = (study.days ?? []).slice().sort();
    const from = allStudyDays[0] ?? '0000-01-01';
    const to = allStudyDays[allStudyDays.length - 1] ?? '9999-12-31';

    // Считаем по данным, которые староста уже внёс: «Пропуски актуальны на»
    const asOf = (journal.lastUpdated ?? '').slice(0, 10) || to;
    const studyDays = allStudyDays.filter((d) => d <= asOf);
    const studyDaysByMonth = new Map<string, string[]>();
    for (const day of allStudyDays) {
      const m = monthOf(day);
      if (!studyDaysByMonth.has(m)) studyDaysByMonth.set(m, []);
      studyDaysByMonth.get(m)!.push(day);
    }
    // Месяц закрыт, когда все его учебные дни уже прошли по данным журнала
    const closedMonths = [...studyDaysByMonth.entries()]
      .filter(([, days]) => days[days.length - 1] <= asOf)
      .map(([m]) => m)
      .sort();

    await syncJournal(journal, from, to);

    const { data: catalogRows, error: catalogError } = await admin
      .from('achievement_catalog').select('code, category, points, group_code, threshold, is_anti, is_repeatable');
    if (catalogError) throw catalogError;
    const catalog = (catalogRows ?? []) as CatalogRow[];
    const byCode = new Map(catalog.map((c) => [c.code, c]));
    const ladder = (group: string) =>
      catalog.filter((c) => c.group_code === group).sort((a, b) => (a.threshold ?? 0) - (b.threshold ?? 0));

    // Уже выданные значки: второй раз то же самое не выдаём
    const { data: earnedRows } = await admin.from('student_achievements').select('student_id, code, period, semester');
    const earned = new Set((earnedRows ?? []).map((r) => `${r.student_id}|${r.code}|${r.period}`));
    const earnedNonAntiByStudent = new Map<string, number>();
    for (const row of earnedRows ?? []) {
      if (byCode.get(row.code)?.is_anti) continue;
      earnedNonAntiByStudent.set(row.student_id, (earnedNonAntiByStudent.get(row.student_id) ?? 0) + 1);
    }

    // События приложения и отметки «Сделано» — только у зарегистрированных студентов
    const { data: eventRows } = await admin.from('app_events').select('student_id, kind, ref');
    const eventsByStudent = new Map<string, { kinds: Set<string>; homework: Set<string> }>();
    for (const e of eventRows ?? []) {
      if (!eventsByStudent.has(e.student_id)) eventsByStudent.set(e.student_id, { kinds: new Set(), homework: new Set() });
      const bucket = eventsByStudent.get(e.student_id)!;
      if (e.kind === 'homework_done') bucket.homework.add(e.ref);
      else bucket.kinds.add(e.kind);
    }

    // Пропуски по студентам в границах семестра
    const absencesByStudent = new Map<string, Absence[]>();
    for (const a of journal.absences ?? []) {
      if (!a.studentId || !a.date || a.date < from || a.date > to) continue;
      if (!absencesByStudent.has(a.studentId)) absencesByStudent.set(a.studentId, []);
      absencesByStudent.get(a.studentId)!.push(a);
    }

    const fresh: { student_id: string; code: string; period: string; semester: string; points: number }[] = [];
    const scores: { student_id: string; points: number; badges: number; hours: number }[] = [];

    for (const student of journal.students ?? []) {
      const id = student.id;
      if (!id) continue;

      const mine = absencesByStudent.get(id) ?? [];
      const unexcusedHours = mine.filter((a) => !a.isExcused).reduce((sum, a) => sum + num(a.totalHours), 0);
      const badDays = new Set(mine.filter((a) => !a.isExcused && a.date).map((a) => a.date!));
      const events = eventsByStudent.get(id);

      const award = (code: string, period = '') => {
        const row = byCode.get(code);
        if (!row) return;
        if (earned.has(`${id}|${code}|${period}`)) return;
        earned.add(`${id}|${code}|${period}`);
        if (!row.is_anti) earnedNonAntiByStudent.set(id, (earnedNonAntiByStudent.get(id) ?? 0) + 1);
        fresh.push({ student_id: id, code, period, semester, points: row.points });
      };

      // --- Посещаемость ---
      const streak = longestStreak(studyDays, badDays);
      for (const step of ladder('streak')) if (streak >= (step.threshold ?? 0)) award(step.code);

      // Чистый лист — за каждый закрытый месяц без неуважительных часов
      for (const month of closedMonths) {
        const hasBad = mine.some((a) => !a.isExcused && a.date && monthOf(a.date) === month);
        if (!hasBad) award('clean_sheet', month);
      }

      // Исправился — месяц без неуважительных сразу после месяца с ними
      for (let i = 1; i < closedMonths.length; i++) {
        const prev = closedMonths[i - 1];
        const month = closedMonths[i];
        const prevBad = mine.some((a) => !a.isExcused && a.date && monthOf(a.date) === prev);
        const nowBad = mine.some((a) => !a.isExcused && a.date && monthOf(a.date) === month);
        if (prevBad && !nowBad) award('recovered', month);
      }

      // Чистый семестр — только когда семестр отучен целиком
      if (asOf >= to && unexcusedHours === 0) award('clean_term');

      // Справка вовремя — сдана не позже своего срока
      const certsOnTime = mine.filter((a) =>
        a.isExcused && a.certSubmittedAt && a.certDueDate && a.certSubmittedAt <= a.certDueDate).length;
      for (const step of ladder('cert')) if (certsOnTime >= (step.threshold ?? 0)) award(step.code);

      // --- Приложение и домашка: только у тех, кто завёл аккаунт ---
      if (events) {
        if (events.kinds.has('first_login')) award('welcome');
        if (events.kinds.has('avatar_set') && events.kinds.has('pass_opened')) award('first_steps');
        if (events.kinds.has('whats_new_read')) award('tech');
        if (events.kinds.has('notifications_on')) award('notify_on');
        for (const step of ladder('homework')) if (events.homework.size >= (step.threshold ?? 0)) award(step.code);
      }

      // Коллекционер — после всего остального: считает уже собранные значки
      const collector = byCode.get('collector');
      if (collector && (earnedNonAntiByStudent.get(id) ?? 0) >= (collector.threshold ?? 10)) award('collector');

      // --- Антидостижения: баллов не дают и не снимают ---
      for (const step of ladder('anti')) if (unexcusedHours >= (step.threshold ?? 0)) award(step.code);

      scores.push({ student_id: id, points: 0, badges: 0, hours: unexcusedHours });
    }

    if (fresh.length) {
      await admin.from('student_achievements').upsert(fresh, { onConflict: 'student_id,code,period', ignoreDuplicates: true });
    }

    // --- Рейтинг семестра: баллы достижений минус 5 за каждый неуважительный час ---
    const { data: semesterRows } = await admin
      .from('student_achievements').select('student_id, code, points').eq('semester', semester);
    const pointsByStudent = new Map<string, number>();
    const badgesByStudent = new Map<string, number>();
    for (const row of semesterRows ?? []) {
      pointsByStudent.set(row.student_id, (pointsByStudent.get(row.student_id) ?? 0) + (row.points ?? 0));
      if (!byCode.get(row.code)?.is_anti) {
        badgesByStudent.set(row.student_id, (badgesByStudent.get(row.student_id) ?? 0) + 1);
      }
    }

    for (const s of scores) {
      s.points = (pointsByStudent.get(s.student_id) ?? 0) - Math.round(s.hours * POINTS_PER_UNEXCUSED_HOUR);
      s.badges = badgesByStudent.get(s.student_id) ?? 0;
    }
    // При равных баллах выше тот, у кого меньше неуважительных часов
    scores.sort((a, b) => b.points - a.points || a.hours - b.hours || a.student_id.localeCompare(b.student_id));

    const board = scores.map((s, i) => ({
      semester,
      student_id: s.student_id,
      points: s.points,
      badges_count: s.badges,
      unexcused_hours: s.hours,
      place: i + 1,
      updated_at: new Date().toISOString(),
    }));
    if (board.length) await admin.from('leaderboard').upsert(board, { onConflict: 'semester,student_id' });

    return json({
      ok: true,
      semester,
      as_of: asOf,
      students: board.length,
      study_days_counted: studyDays.length,
      closed_months: closedMonths,
      new_achievements: fresh.length,
    });
  } catch (e) {
    console.error('recalc-achievements:', e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
