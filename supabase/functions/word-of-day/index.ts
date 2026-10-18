// «Ассоциации»: игра на близость слов.
//
// Загадано существительное. Игрок называет любые существительные, игра
// отвечает только одним числом — местом слова в рейтинге близости к
// загаданному. №1 — само загаданное слово.
//
// Ни загаданное слово, ни рейтинг наружу не уходят, пока игра не окончена:
// рейтинг лежит в приватном бакете и читается только здесь, а в ответе
// клиенту есть лишь места названных им слов.
//
// Действия (поле action):
//   state        что сейчас: сколько попыток, подсказок, названные слова
//   guess        прислать слово, получить его место
//   hint         открыть слово ближе лучшего результата (стоит очков)
//   giveup       сдаться: показывается загаданное слово
//   train        взять слово для тренировки (в рейтинг не идёт)
//   train_guess  слово в тренировке
//   train_give   показать загаданное слово в тренировке
//
// «Слово дня» играется один раз в сутки: у word_attempts уникальный индекс на
// пару «студент + день», и вторую попытку он не пропустит.
import { admin, json, cors } from '../_shared/common.ts';
import { minskDay, grantBadges } from '../_shared/words.ts';
import { rankBadges } from '../_shared/ranks.ts';
import { assocNormalize, assocPoints, assocHint, loadRanks, type Ranks } from '../_shared/assoc.ts';

type Body = Record<string, unknown>;
type Guess = { w: string; r: number; h?: boolean };
type Attempt = {
  id: number; student_id: string; day: string;
  mode: string; tries: number; hints: number;
  solved: boolean; gave_up: boolean; finished: boolean; points: number;
  guesses: Guess[];
};

const TOP = 100;            // столько ближайших слов показываем в конце
const MAX_WORD = 32;

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
  // Слова те же, что уже были словом дня, плюс отдельный набор. Счёт не
  // ведётся, поэтому и строки в базе нет: страница сама помнит свои попытки.
  if (action === 'train') return await trainStart();
  if (action === 'train_guess') return await trainGuess(body);
  if (action === 'train_give') return await trainGive(body);

  // ===== Слово дня =====
  const day = minskDay();
  const target = await dailyWord(day);
  if (!target) return json({ ok: true, day, has: false });

  const ranks = await loadRanks(target);
  if (!ranks) return json({ error: 'no_ranks' }, 500);

  const { data: found } = await admin
    .from('word_attempts').select('*')
    .eq('student_id', studentId).eq('day', day).maybeSingle();
  let attempt = (found as Attempt | null);

  // Первая игра за день заводит строку. Если строка осталась от старого
  // режима, новую в тот же день не начинаем — день уже сыгран.
  if (!attempt) {
    const { data: made, error } = await admin.from('word_attempts')
      .insert({ student_id: studentId, day, mode: 'ranks', tries: 0, hints: 0, guesses: [] })
      .select('*').maybeSingle();
    if (error) {
      const { data: again } = await admin.from('word_attempts').select('*')
        .eq('student_id', studentId).eq('day', day).maybeSingle();
      if (!again) return json({ error: 'server_error' }, 500);
      attempt = again as Attempt;
    } else {
      attempt = made as Attempt;
    }
  }

  if (attempt.mode !== 'ranks') {
    // День уже сыгран по старым правилам: в рейтинг он идёт по-старому,
    // а переиграть его нельзя
    return json({ ok: true, day, has: true, old: true, finished: true });
  }

  if (action === 'guess' && !attempt.finished) {
    const word = assocNormalize(body.word);
    if (!word || word.length > MAX_WORD) return json({ error: 'bad_word' }, 400);

    const rank = ranks.place.get(word);
    // Нет в словаре — не попытка
    if (!rank) return json({ ...view(attempt, ranks), unknown: word });
    // Повтор — тоже не попытка, просто подсвечиваем слово в списке
    if (attempt.guesses.some((g) => g.w === word)) {
      return json({ ...view(attempt, ranks), repeat: word });
    }

    const guesses = attempt.guesses.concat([{ w: word, r: rank }]);
    const tries = attempt.tries + 1;
    const solved = rank === 1;
    attempt = await save(attempt.id, {
      guesses, tries,
      solved, finished: solved,
      points: solved ? assocPoints(tries, attempt.hints) : 0,
    });

    if (solved) {
      const badges = await grantAssocBadges(studentId, attempt, day);
      return json({ ...view(attempt, ranks), last: word, badges });
    }
    return json({ ...view(attempt, ranks), last: word });
  }

  if (action === 'hint' && !attempt.finished) {
    const used = new Set(attempt.guesses.map((g) => g.w));
    const best = attempt.guesses.reduce((min, g) => Math.min(min, g.r), ranks.words.length);
    const hint = assocHint(ranks, best, used);
    if (!hint) return json({ ...view(attempt, ranks), no_hint: true });

    attempt = await save(attempt.id, {
      guesses: attempt.guesses.concat([{ w: hint.word, r: hint.rank, h: true }]),
      hints: attempt.hints + 1,
    });
    return json({ ...view(attempt, ranks), last: hint.word });
  }

  if (action === 'giveup' && !attempt.finished) {
    attempt = await save(attempt.id, { finished: true, gave_up: true, solved: false, points: 0 });
    return json(view(attempt, ranks));
  }

  return json(view(attempt, ranks));
});

// Что видит страница. Загаданное слово и список ближайших — только после
// конца игры; до этого наружу уходят лишь места названных слов.
function view(attempt: Attempt, ranks: Ranks) {
  const done = attempt.finished;
  return {
    ok: true,
    day: attempt.day,
    has: true,
    mode: 'ranks',
    tries: attempt.tries,
    hints: attempt.hints,
    guesses: attempt.guesses,
    solved: attempt.solved,
    gaveUp: attempt.gave_up,
    finished: done,
    points: attempt.points,
    total: ranks.words.length,
    word: done ? ranks.word : null,
    near: done ? ranks.words.slice(0, TOP) : null,
  };
}

async function save(id: number, patch: Record<string, unknown>): Promise<Attempt> {
  const { data } = await admin.from('word_attempts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select('*').maybeSingle();
  return data as Attempt;
}

async function dailyWord(day: string): Promise<string | null> {
  const { data } = await admin
    .from('word_daily').select('word_bank (word)')
    .eq('day', day).maybeSingle();
  const w = (data as { word_bank?: { word: string } } | null)?.word_bank?.word;
  return w ? assocNormalize(w) : null;
}

// Значки «Ассоциаций». «С полуслова» теперь даётся за догадку не больше чем
// с десятой попытки и без подсказок.
async function grantAssocBadges(studentId: string, attempt: Attempt, day: string): Promise<string[]> {
  const codes: string[] = ['game_assoc_first'];
  if (attempt.tries <= 10 && attempt.hints === 0) codes.push('game_assoc_flash');
  if (await solvedStreak(studentId, day) >= 7) codes.push('game_assoc_week');
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
// Слово выбирается случайно из уже сыгранных слов дня и отдельного набора.
// Чтобы страница не знала ответа, сервер отдаёт только ключ слова (его id),
// а места присылает по одному, как и в игре дня.
async function trainWords(): Promise<{ id: number; word: string }[]> {
  const today = minskDay();
  const { data: past } = await admin
    .from('word_daily').select('day, word_id, word_bank (id, word)')
    .lt('day', today);
  const { data: extra } = await admin
    .from('word_bank').select('id, word').eq('kind', 'train');

  const out: { id: number; word: string }[] = [];
  for (const row of (past ?? []) as { word_bank?: { id: number; word: string } }[]) {
    if (row.word_bank) out.push(row.word_bank);
  }
  for (const row of (extra ?? []) as { id: number; word: string }[]) out.push(row);
  return out;
}

async function trainStart(): Promise<Response> {
  const words = await trainWords();
  if (!words.length) return json({ ok: true, has: false });
  const pick = words[Math.floor(Math.random() * words.length)];
  const ranks = await loadRanks(pick.word);
  if (!ranks) return json({ ok: true, has: false });
  return json({ ok: true, has: true, id: pick.id, total: ranks.words.length });
}

async function trainRanks(id: unknown): Promise<Ranks | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { data } = await admin.from('word_bank').select('word').eq('id', n).maybeSingle();
  const word = (data as { word: string } | null)?.word;
  return word ? await loadRanks(word) : null;
}

async function trainGuess(body: Body): Promise<Response> {
  const ranks = await trainRanks(body.id);
  if (!ranks) return json({ error: 'not_found' }, 404);
  const word = assocNormalize(body.word);
  if (!word || word.length > MAX_WORD) return json({ error: 'bad_word' }, 400);
  const rank = ranks.place.get(word);
  if (!rank) return json({ ok: true, unknown: word });
  return json({
    ok: true, word, rank, total: ranks.words.length,
    solved: rank === 1,
    near: rank === 1 ? ranks.words.slice(0, TOP) : null,
  });
}

async function trainGive(body: Body): Promise<Response> {
  const ranks = await trainRanks(body.id);
  if (!ranks) return json({ error: 'not_found' }, 404);
  return json({ ok: true, word: ranks.word, near: ranks.words.slice(0, TOP) });
}
