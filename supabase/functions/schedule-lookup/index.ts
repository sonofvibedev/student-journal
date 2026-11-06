// Поиск расписания группы на bseu.by (шаги 1 и 4 регистрации старосты). Списки открыты (с лимитом), «find» требует вход.
//   { action: 'faculties' }                                   → [{ value, text }]
//   { action: 'forms',   faculty }                            → [{ value, text }]
//   { action: 'courses', faculty, form }                      → [{ value, text }]
//   { action: 'groups',  faculty, form, course }              → [{ value, text }]
//   { action: 'find', faculty, form, course, group, request_id? } → { found, semester, weeks, subjects, teachers, lessons }
// Источник: POST https://bseu.by/schedule/ без cookie. Разведка: docs/research/bseu-schedule.md.
// Ответ расписания в cp1251; занятия лежат в HTML-комментариях `<!--week: …, Discipline: …, Teacher: …-->`
// (структурнее и устойчивее таблицы), поэтому разбираем их. Если формат не узнан, ничего не пишем
// и не выдаём за найденное. Нагрузка: запросов не больше 30 за 10 минут с адреса.
import { admin, cors, json, ipHashOf, logAttempt } from '../_shared/join.ts';
import { post, options, ACT, parseSchedule, fetchSemesterHtml } from '../_shared/bseu.ts';

const FACULTIES = [
  ['450', 'Аспирантура'], ['18', 'ВШУБ'], ['530', 'Деканат по работе с иностранными учащимися'], ['531', 'ИПК и ПЭК (в)'],
  ['497', 'ИПК и ПЭК (о)'], ['129', 'Магистратура'], ['535', 'СБ'], ['432', 'СЭФ'], ['12', 'УЭФ'], ['14', 'ФКТИ'],
  ['263', 'ФМБК'], ['13', 'ФМк'], ['7', 'ФМЭО'], ['2', 'ФП'], ['8', 'ФФБД'], ['534', 'ФЦЭ'], ['11', 'ФЭМ'],
].map(([value, text]) => ({ value, text }));

const digits = (v: unknown) => /^\d{1,6}$/.test(String(v ?? '')) ? String(v) : null;

function summarize(html: string) {
  const { lessons, semester } = parseSchedule(html);
  if (!lessons.length) return { found: false as const, reason: 'format_unrecognized' };
  const subjects = new Map<string, Set<string>>();
  const teachers = new Set<string>();
  let maxWeek = 0;
  for (const l of lessons) {
    if (!subjects.has(l.subject)) subjects.set(l.subject, new Set());
    subjects.get(l.subject)!.add(l.kind);
    if (l.teacher && l.teacher !== 'null') teachers.add(l.teacher);
    for (const n of l.week.match(/\d+/g) ?? []) if (Number(n) > maxWeek) maxWeek = Number(n);   // «(12-14,16)»: берём наибольший номер
  }
  const caption = html.match(/<caption>([^<]*)/)?.[1]?.trim() ?? null;
  return {
    found: true as const,
    caption,
    semester,
    weeks: maxWeek || null,
    lessons: lessons.length,
    subjects: [...subjects].map(([name, kinds]) => ({ name, kinds: [...kinds] })),
    teachers: [...teachers],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  // Списки (факультеты, формы, курсы, группы) нужны на шаге 1, до создания аккаунта: открыты, но с лимитом по адресу.
  // «find» пишет в черновик заявки и требует вход.
  let userId: string | null = null;
  if (body.action === 'find') {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    userId = auth.user.id;
  }

  const ipHash = await ipHashOf(req, 'journal2-sched');
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await admin.from('join_attempts').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).eq('group_key', 'schedule').gte('at', since);
  if ((count ?? 0) >= 30) return json({ error: 'too_many_requests' }, 429);

  const faculty = digits(body.faculty), form = digits(body.form), course = digits(body.course), group = digits(body.group);
  try {
    if (body.action === 'faculties') return json(FACULTIES);
    await logAttempt(ipHash, 'schedule', true);
    if (body.action === 'forms' && faculty) return json(await options({ __act: ACT.forms, faculty }));
    if (body.action === 'courses' && faculty && form) return json(await options({ __act: ACT.courses, form, faculty }));
    if (body.action === 'groups' && faculty && form && course) return json(await options({ __act: ACT.groups, course, form, faculty }));
    if (body.action === 'find' && faculty && form && course && group) {
      const html = await fetchSemesterHtml({ faculty, form, course, group });
      const sum = summarize(html);
      const schedule_status = sum.found ? 'found' : 'not_found';
      // Результат кладём в черновик заявки владельца, чтобы сисадмин видел то, что нашла функция, а не то, что прислал клиент
      const rid = typeof body.request_id === 'string' ? body.request_id : null;
      if (rid) {
        const { data: reqRow } = await admin.from('registration_requests').select('id, payload, status, owner_user_id').eq('id', rid).maybeSingle();
        if (reqRow && reqRow.owner_user_id === userId && reqRow.status === 'draft') {
          const payload = { ...(reqRow.payload ?? {}), schedule: sum.found ? { ...sum, bseu: { faculty, form, course, group }, checked_at: new Date().toISOString() } : null };
          await admin.from('registration_requests').update({ payload, schedule_status, updated_at: new Date().toISOString() }).eq('id', rid);
        }
      }
      return json(sum);
    }
    return json({ error: 'bad_request' }, 400);
  } catch (e) {
    return json({ error: 'bseu_unavailable', detail: String((e as Error).message ?? e).slice(0, 80) }, 502);
  }
});
