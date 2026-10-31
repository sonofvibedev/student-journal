// Чистая логика Telegram-бота для задач (tg-bot): разбор даты, лимиты, срок кода,
// проверка секретного заголовка, сборка записи, разбор расписания.
// Без обращений к сети и базе и без импортов — поэтому её проверяет tools/test-tgbot.js
// под обычным node (только «стираемые» типы TypeScript: никаких enum и т. п.).

export const DAY_MS = 86_400_000;
export const LINK_CODE_TTL_MS = 10 * 60_000;
export const DIALOG_TTL_MS = 30 * 60_000;
export const RATE_MAX = 20;                 // записей в час на пользователя
export const RATE_WINDOW_MS = 3_600_000;
export const TEXT_MAX = 500;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // как в reset_student_access

// ---------- Секретный заголовок вебхука ----------
// Сравнение за постоянное время; пустой секрет в окружении = всё запрещено.
export function checkSecret(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !header || header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

// ---------- Код привязки ----------
const LOOKALIKE: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
};

// 'abcd-efgh' и 'АВСD EFGH' (кириллица с русской раскладки) → 'ABCDEFGH'
export function normalizeCode(s: string): string {
  return String(s ?? '').toUpperCase().replace(/[^A-ZА-Я0-9]/g, '')
    .replace(/[А-Я]/g, (c) => LOOKALIKE[c] ?? c);
}

export function looksLikeCode(s: string): boolean {
  const c = normalizeCode(s);
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

export type LinkCodeState = 'ok' | 'none' | 'used' | 'expired';
export function linkCodeState(
  row: { expires_at: string; used_at: string | null } | null | undefined,
  nowMs: number,
): LinkCodeState {
  if (!row) return 'none';
  if (row.used_at) return 'used';
  if (Date.parse(row.expires_at) <= nowMs) return 'expired';
  return 'ok';
}

// ---------- Лимиты и срок диалога ----------
export function rateAllowed(createdAts: string[], nowMs: number, max = RATE_MAX, windowMs = RATE_WINDOW_MS): boolean {
  return createdAts.filter((t) => nowMs - Date.parse(t) < windowMs).length < max;
}

export function dialogFresh(updatedAt: string | null | undefined, nowMs: number, ttlMs = DIALOG_TTL_MS): boolean {
  const t = Date.parse(String(updatedAt ?? ''));
  return Number.isFinite(t) && nowMs - t < ttlMs;
}

// ---------- Даты (строки ГГГГ-ММ-ДД, арифметика в UTC) ----------
const ymdMs = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDaysYmd = (s: string, n: number) => new Date(ymdMs(s) + n * DAY_MS).toISOString().slice(0, 10);
export const isValidYmd = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(ymdMs(s)).toISOString().slice(0, 10) === s;
export const fmtDm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
export const fmtDmy = (s: string) => `${fmtDm(s)}.${s.slice(0, 4)}`;
const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const dowShort = (s: string) => DOW[new Date(ymdMs(s)).getUTCDay()];

// Дата в Минске (UTC+3 круглый год), как в send-reminders
export const minskYmd = (nowMs: number) => new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10);

export type DateParse = { ok: true; date: string } | { ok: false; reason: 'format' | 'past' | 'far' };

// «ДД.ММ», «ДД.ММ.ГГ», «ДД.ММ.ГГГГ» (разделители . / -). Без года берём ближайший
// подходящий: если дата в этом году ушла больше чем на 30 дней назад — следующий год.
// Прошедшие даты не принимаем (домашку «на вчера» не задают), дальше чем на 400 дней — тоже.
export function parseDmy(text: string, todayYmd: string): DateParse {
  const m = /^\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?\s*$/.exec(String(text ?? ''));
  if (!m) return { ok: false, reason: 'format' };
  const pad = (n: string) => n.padStart(2, '0');
  let year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(todayYmd.slice(0, 4));
  let date = `${year}-${pad(m[2])}-${pad(m[1])}`;
  if (!isValidYmd(date)) return { ok: false, reason: 'format' };
  if (!m[3] && date < addDaysYmd(todayYmd, -30)) {
    year += 1;
    date = `${year}-${pad(m[2])}-${pad(m[1])}`;
    if (!isValidYmd(date)) return { ok: false, reason: 'format' };   // 29.02 в невисокосный
  }
  if (date < todayYmd) return { ok: false, reason: 'past' };
  if (date > addDaysYmd(todayYmd, 400)) return { ok: false, reason: 'far' };
  return { ok: true, date };
}

// Если расписание недоступно: сегодня / завтра / через неделю
export const fallbackDates = (todayYmd: string) => [0, 1, 7].map((n) => addDaysYmd(todayYmd, n));

// ---------- Расписание ----------
// schedule.js — клиентский файл, на сервере его только читаем как текст (не исполняем!)
// и вытаскиваем нужные строки регулярными выражениями.
export type Lesson = { day: number; weeks: number[]; subject: string; kind: string };
export type Schedule = { start: string; weeksCount: number; lessons: Lesson[] };

function parseWeekList(text: string): number[] {
  const out: number[] = [];
  for (const part of String(text).split(',')) {
    const [from, to] = part.split('-').map((n) => parseInt(n, 10));
    if (!Number.isFinite(from)) continue;
    if (Number.isFinite(to)) { for (let w = from; w <= to; w++) out.push(w); } else out.push(from);
  }
  return out;
}

function parseMap(src: string, name: string): Record<string, string> {
  const block = new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(src)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

export function parseSchedule(src: string): Schedule | null {
  const start = /SEMESTER_START\s*=\s*'(\d{4}-\d{2}-\d{2})'/.exec(src)?.[1];
  const weeksCount = Number(/SEMESTER_WEEKS\s*=\s*(\d+)/.exec(src)?.[1]);
  if (!start || !isValidYmd(start) || !weeksCount) return null;
  const subjects = parseMap(src, 'SCHEDULE_SUBJECTS');
  const kinds = parseMap(src, 'LESSON_KINDS');
  const lessons: Lesson[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*\[\s*(\d)\s*,\s*\d+\s*,\s*'([^']*)'\s*,\s*'(\w+)'\s*,\s*'(\w+)'/.exec(line);
    if (!m) continue;
    const kind = kinds[m[4]] ?? m[4];
    if (kind === 'ЗЧ') continue;   // зачёт — не повод для домашки
    lessons.push({ day: Number(m[1]), weeks: parseWeekList(m[2]), subject: subjects[m[3]] ?? m[3], kind });
  }
  return lessons.length ? { start, weeksCount, lessons } : null;
}

// Ближайшие даты (не раньше fromYmd), когда у группы есть занятие по предмету
export function nextLessonDates(s: Schedule, subject: string, fromYmd: string, count = 4): string[] {
  const dow = new Date(ymdMs(s.start)).getUTCDay();             // 0 — воскресенье
  const monday = addDaysYmd(s.start, -((dow + 6) % 7));
  const out: string[] = [];
  for (let i = 0; i < s.weeksCount * 7 && out.length < count; i++) {
    const date = addDaysYmd(monday, i);
    if (date < fromYmd) continue;
    const week = Math.floor(i / 7) + 1, day = (i % 7) + 1;
    if (s.lessons.some((l) => l.subject === subject && l.day === day && l.weeks.includes(week))) out.push(date);
  }
  return out;
}

// ---------- Запись ----------
export type Kind = 'homework' | 'deadline';
export type Fields = { subject: string; type: string; text: string; dueDate: string };
export type TaskRecord = Record<string, unknown> & { id: string; author?: string; source?: string; createdAt?: string };

// Текст от пользователя: без управляющих символов, обрезан до TEXT_MAX
export function cleanText(s: string, max = TEXT_MAX): string {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

// Поля записи — как у админки (index.html: saveHomework / saveDeadline) + author, source
export const recordIdFor = (kind: Kind, ms: number) => (kind === 'homework' ? 'hw-' : 'dl-') + ms;

export function buildRecord(
  kind: Kind, f: Fields, author: string, nowMs: number, taken: Set<string> = new Set(), fixedId?: string,
): TaskRecord {
  let ms = nowMs;
  while (!fixedId && taken.has(recordIdFor(kind, ms))) ms++;
  const id = fixedId ?? recordIdFor(kind, ms);
  const createdAt = new Date(nowMs).toISOString();
  return kind === 'homework'
    ? { id, subject: f.subject, type: f.type, text: f.text, dueDate: f.dueDate, subgroup: 0, createdAt, author, source: 'bot' }
    : { id, type: 'deadline', subject: f.subject, text: f.text, dueDate: f.dueDate, createdAt, author, source: 'bot' };
}

// После внедрения заявок правит и удаляет готовые записи только админ.
// Автору остаётся «Отозвать» у заявки, пока она не решена.
export function canModify(rec: TaskRecord | null | undefined, who: { studentId?: string; isAdmin: boolean }, _nowMs?: number): boolean {
  return !!rec && who.isAdmin === true;
}

export function commitMessage(action: string, kind: Kind, subject: string, dueDate: string): string {
  const noun = kind === 'homework' ? 'домашка' : 'дедлайн';
  return `Бот: ${noun} ${String(subject).replace(/\s+/g, ' ').slice(0, 80)} — ${fmtDm(dueDate)} (${action})`;
}

// ---------- Заявки на проверку админом ----------
export const PENDING_MAX = 5;                    // не больше 5 неразобранных заявок от одного автора
export const REQUEST_TTL_MS = 7 * DAY_MS;        // без решения 7 суток — закрывается как «истекла»
export const APPROVING_STALE_MS = 2 * 60_000;    // «вносится» дольше двух минут — считаем, что внесение оборвалось

export type ReqStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
export const STATUS_RU: Record<ReqStatus, string> = {
  pending: 'на проверке', approving: 'вносится', approved: 'одобрено',
  rejected: 'отклонено', withdrawn: 'отозвана', expired: 'истекла',
};

export const pendingAllowed = (pendingCount: number, max = PENDING_MAX) => pendingCount < max;
export const requestExpired = (createdAt: string, nowMs: number, ttlMs = REQUEST_TTL_MS) =>
  nowMs - Date.parse(createdAt) >= ttlMs;

// Единственные допустимые переходы статуса. Тот же список использует БД-слой:
// каждый переход — один условный UPDATE ... WHERE status = from RETURNING, поэтому
// повторное нажатие или гонка двух админов решённую заявку не меняют.
//   claim    pending   → approving   админ нажал «Одобрить»: заявка занята, идёт внесение
//   commit   approving → approved    запись в data.json внесена
//   rollback approving → pending     внести не вышло: заявка снова ждёт решения
//   reject   pending   → rejected
//   withdraw pending   → withdrawn   автор отозвал
//   expire   pending   → expired     7 суток без решения
export const TRANSITIONS = {
  claim: { from: 'pending', to: 'approving' },
  commit: { from: 'approving', to: 'approved' },
  rollback: { from: 'approving', to: 'pending' },
  reject: { from: 'pending', to: 'rejected' },
  withdraw: { from: 'pending', to: 'withdrawn' },
  expire: { from: 'pending', to: 'expired' },
} as const;
export type ReqEvent = keyof typeof TRANSITIONS;

export function transition(status: ReqStatus, event: ReqEvent): ReqStatus | null {
  const t = TRANSITIONS[event];
  return t && t.from === status ? t.to : null;
}

// Повторное «Одобрить» по зависшей заявке (approving) разрешаем, только если прошло больше двух минут:
// иначе мы мешали бы внесению, которое ещё идёт.
export const approvingStale = (decidedAt: string | null | undefined, nowMs: number, ms = APPROVING_STALE_MS) =>
  !decidedAt || nowMs - Date.parse(decidedAt) >= ms;

// Решать заявки может только telegram_id из TG_ADMIN_IDS (проверяется по from.id нажавшего, не по чату)
export const canDecide = (telegramId: number | string | null | undefined, adminIds: Set<string>) =>
  telegramId != null && adminIds.has(String(telegramId));

// ---------- Поиск дубля ----------
export function normText(s: string): string {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

export function jaccard(a: string, b: string): number {
  const A = new Set(normText(a).split(' ').filter(Boolean)), B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Похоже: совпали после нормализации, одно содержит другое или слова пересекаются на 60 % и больше
export function similarText(a: string, b: string): boolean {
  const x = normText(a), y = normText(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return jaccard(x, y) >= 0.6;
}

export type Candidate = { subject: string; dueDate: string; text: string };
// Тот же предмет, та же дата и похожий текст среди уже внесённых записей и других заявок.
// Возвращает первое совпадение с пометкой, где оно найдено.
export function findDuplicate(
  c: Candidate,
  records: Array<{ subject?: unknown; dueDate?: unknown; text?: unknown }>,
  pending: Array<{ subject?: unknown; due_date?: unknown; text?: unknown }>,
): 'record' | 'request' | null {
  const same = (subj: unknown, date: unknown, text: unknown) =>
    subj === c.subject && String(date) === c.dueDate && similarText(c.text, String(text ?? ''));
  if (records.some((r) => r && same(r.subject, r.dueDate, r.text))) return 'record';
  if (pending.some((r) => r && same(r.subject, r.due_date, r.text))) return 'request';
  return null;
}

// Текст заявки для админа (и для /мои)
export function requestSummary(
  r: { kind: string; subtype?: string | null; subject: string; due_date: string; text: string },
  authorName: string,
): string {
  const what = r.kind === 'homework' ? `домашку${r.subtype ? ` (${r.subtype})` : ''}` : 'дедлайн';
  return `${authorName || 'Студент'} хочет внести ${what}
Предмет: ${r.subject}
`
    + `Срок: ${dowShort(r.due_date)} ${fmtDmy(r.due_date)}
Текст: ${r.text}`;
}
