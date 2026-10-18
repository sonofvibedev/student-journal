// «Ассоциации»: подсказки по одной и проверка ответа.
//
// Загаданное слово, его подсказки и список допустимых ответов лежат только в
// базе. Страница их не знает: она спрашивает очередную подсказку у этой
// функции и присылает сюда ответ. Правильное слово уходит наружу ровно один
// раз — когда попытка окончена.
//
// Действия (поле action):
//   state        что сейчас: открыта ли попытка, сколько подсказок, сколько очков
//   start        начать попытку дня и получить первую подсказку
//   hint         открыть следующую подсказку
//   letter       открыть первую букву (с третьей подсказки, стоит очко)
//   guess        прислать ответ
//   train        взять слово из тренировочного набора (в рейтинг не идёт)
//   train_hint   следующая подсказка тренировочного слова
//   train_guess  ответ на тренировочное слово
//
// «Слово дня» играется один раз в сутки: у word_attempts уникальный индекс на
// пару «студент + день», и вторую попытку он не пропустит.
import { admin, json, cors } from '../_shared/common.ts';
import { minskDay, grantBadges } from '../_shared/words.ts';
import { rankBadges } from '../_shared/ranks.ts';
import { ASSOC, assocMatch, assocPoints } from '../_shared/games-core.js';

type Body = Record<string, unknown>;
type Word = { id: number; word: string; hints: string[]; answers: string[] };
type Attempt = {
  id: number; student_id: string; day: string;
  hint: number; letter: boolean; solved: boolean; finished: boolean; points: number;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);

  const { data: profile } = await admin
    .from('profiles').select('student_id').eq('user_id', auth.user.id).maybeSingle();
  if (!profile?.student_id) return json({ error: 'no_profile' }, 403);
  const studentId: string = profile.student_id;

  let body: Body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const action = String(body.action ?? 'state');

  // ===== Тренировка =====
  // Набор не секретный, но ответы всё равно проверяет сервер: так в коде
  // страницы нет ни слов, ни подсказок, и набор можно менять из админки.
  if (action === 'train') return await trainStart();
  if (action === 'train_hint') return await trainHint(body);
  if (action === 'train_guess') return await trainGuess(body);

  // ===== Слово дня =====
  const day = minskDay();
  const word = await dailyWord(day);
  if (!word) return json({ ok: true, day, has: false });

  const { data: found } = await admin
    .from('word_attempts').select('*')
    .eq('student_id', studentId).eq('day', day).maybeSingle();
  let attempt = found as Attempt | null;

  if (action === 'start') {
    if (attempt) return json(view(attempt, word));
    const { data: made, error } = await admin.from('word_attempts')
      .insert({ student_id: studentId, day, hint: 1 })
      .select('*').maybeSingle();
    // Две вкладки разом: вторая вставка упирается в уникальный индекс —
    // берём ту попытку, что уже есть
    if (error) {
      const { data: again } = await admin.from('word_attempts').select('*')
        .eq('student_id', studentId).eq('day', day).maybeSingle();
      if (!again) return json({ error: 'server_error' }, 500);
      return json(view(again as Attempt, word));
    }
    return json(view(made as Attempt, word));
  }

  if (!attempt) return json({ ok: true, day, has: true, started: false });
  if (attempt.finished && action !== 'state') return json(view(attempt, word));

  if (action === 'hint') {
    if (attempt.hint >= ASSOC.hints) return json(view(attempt, word));
    attempt = await save(attempt.id, { hint: attempt.hint + 1 });
    return json(view(attempt, word));
  }

  if (action === 'letter') {
    // Букву дают не раньше третьей подсказки и только один раз
    if (attempt.hint < ASSOC.letterFromHint) return json({ error: 'too_early' }, 400);
    if (!attempt.letter) attempt = await save(attempt.id, { letter: true });
    return json(view(attempt, word));
  }

  if (action === 'guess') {
    const answer = String(body.answer ?? '');
    if (answer.length > 64) return json({ error: 'bad_answer' }, 400);
    const ok = assocMatch(answer, [word.word, ...(word.answers ?? [])]);

    if (ok) {
      const points = assocPoints(attempt.hint, attempt.letter);
      attempt = await save(attempt.id, { solved: true, finished: true, points });
      const badges = await grantAssocBadges(studentId, attempt, day);
      return json({ ...view(attempt, word), right: true, badges });
    }

    // Не угадал с шестой подсказки — попытка окончена, очков нет
    if (attempt.hint >= ASSOC.hints) {
      attempt = await save(attempt.id, { finished: true, points: 0 });
      return json({ ...view(attempt, word), right: false });
    }
    return json({ ...view(attempt, word), right: false });
  }

  return json(view(attempt, word));
});

// Что видит страница. Подсказки — только открытые, слово — только после
// конца попытки. Ни ответа, ни подсказок вперёд наружу не уходит.
function view(attempt: Attempt, word: Word) {
  const opened = Math.min(attempt.hint, ASSOC.hints);
  return {
    ok: true,
    day: attempt.day,
    has: true,
    started: true,
    hints: word.hints.slice(0, opened),
    hint: opened,
    total: ASSOC.hints,
    letter: attempt.letter ? firstLetter(word.word) : null,
    canLetter: !attempt.letter && opened >= ASSOC.letterFromHint,
    solved: attempt.solved,
    finished: attempt.finished,
    points: attempt.points,
    willGet: attempt.finished ? attempt.points : assocPoints(opened, attempt.letter),
    word: attempt.finished ? word.word : null,
  };
}

const firstLetter = (w: string) => String(w || '').trim().slice(0, 1).toUpperCase();

async function save(id: number, patch: Record<string, unknown>): Promise<Attempt> {
  const { data } = await admin.from('word_attempts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select('*').maybeSingle();
  return data as Attempt;
}

async function dailyWord(day: string): Promise<Word | null> {
  const { data } = await admin
    .from('word_daily').select('word_id, word_bank (id, word, hints, answers)')
    .eq('day', day).maybeSingle();
  const w = (data as { word_bank?: Word } | null)?.word_bank;
  return w ?? null;
}

// Значки «Ассоциаций», которые видно прямо по этой попытке. Значки за топ-5
// выдаются отдельно, когда считается рейтинг.
async function grantAssocBadges(studentId: string, attempt: Attempt, day: string): Promise<string[]> {
  const codes: string[] = ['game_assoc_first'];
  if (attempt.hint === 1 && !attempt.letter) codes.push('game_assoc_flash');
  if (await solvedStreak(studentId, day) >= 7) codes.push('game_assoc_week');
  // Очки за слово могли внести студента в месячную пятёрку «Ассоциаций»
  const ranks = await rankBadges(studentId);
  return await grantBadges(studentId, codes.concat(ranks));
}

// Сколько дней подряд, считая сегодняшний, слово угадано
async function solvedStreak(studentId: string, day: string): Promise<number> {
  const since = new Date(day + 'T00:00:00Z');
  since.setUTCDate(since.getUTCDate() - 30);
  const { data } = await admin.from('word_attempts')
    .select('day, solved')
    .eq('student_id', studentId).eq('solved', true)
    .gte('day', since.toISOString().slice(0, 10))
    .order('day', { ascending: false });

  const days = new Set((data ?? []).map((r: { day: string }) => r.day));
  let streak = 0;
  const cursor = new Date(day + 'T00:00:00Z');
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// ===== Тренировка =====
// Слово берётся случайное из набора; очки за него не начисляются и в рейтинг
// оно не идёт. Страница помнит только id слова и номер подсказки.
async function trainStart(): Promise<Response> {
  const { count } = await admin.from('word_bank')
    .select('id', { count: 'exact', head: true }).eq('kind', 'train');
  if (!count) return json({ ok: true, has: false });
  const offset = Math.floor(Math.random() * count);
  const { data } = await admin.from('word_bank')
    .select('id, word, hints, answers').eq('kind', 'train')
    .order('id').range(offset, offset).maybeSingle();
  const w = data as Word | null;
  if (!w) return json({ ok: true, has: false });
  return json({ ok: true, has: true, id: w.id, hint: 1, total: ASSOC.hints, hints: w.hints.slice(0, 1) });
}

async function trainHint(body: Body): Promise<Response> {
  const w = await trainWord(body.id);
  const n = Number(body.hint);
  if (!w) return json({ error: 'not_found' }, 404);
  if (!Number.isInteger(n) || n < 1 || n > ASSOC.hints) return json({ error: 'bad_hint' }, 400);
  return json({ ok: true, id: w.id, hint: n, total: ASSOC.hints, hints: w.hints.slice(0, n) });
}

async function trainGuess(body: Body): Promise<Response> {
  const w = await trainWord(body.id);
  if (!w) return json({ error: 'not_found' }, 404);
  const answer = String(body.answer ?? '');
  if (answer.length > 64) return json({ error: 'bad_answer' }, 400);
  const right = assocMatch(answer, [w.word, ...(w.answers ?? [])]);
  const give = right || body.give === true;
  return json({ ok: true, right, word: give ? w.word : null });
}

async function trainWord(id: unknown): Promise<Word | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { data } = await admin.from('word_bank')
    .select('id, word, hints, answers').eq('id', n).eq('kind', 'train').maybeSingle();
  return (data as Word | null) ?? null;
}
