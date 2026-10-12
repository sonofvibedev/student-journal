// Запись рекорда игры: клиент присылает не результат, а доказательство партии,
// функция переигрывает её по зерну и сверяет итог.
//
//   судоку      { game: 'sudoku', difficulty, seed, seconds, solution: number[81] }
//   сапёр       { game: 'minesweeper', difficulty, seed, seconds, moves: [{t,i}] }
//               difficulty у сапёра может быть телефонным (easy_s, medium_s,
//               hard_s): поле меньше, доля мин та же, рекорды отдельные
//   flappy      { game: 'flappy', seed, flaps: number[] , score }
//
// Заголовок Authorization: Bearer <access_token> обязателен — рекорд пишется
// тому, кто вошёл, и никому другому. Таблица game_records закрыта RLS: прямой
// записи у студента нет, поэтому обойти проверку нельзя.
//
// Правила игр берутся из того же файла, что и на странице (_shared/games-core.js),
// его кладёт туда tools/sync-games-core.js. Две реализации разойтись не могут.
import { admin, json, cors } from '../_shared/common.ts';
import {
  SUDOKU_LEVELS, sudokuVerify,
  MINES_LEVELS, minesReplay,
  flappySimulate,
} from '../_shared/games-core.js';

type Body = Record<string, unknown>;

const GAMES = new Set(['sudoku', 'minesweeper', 'flappy']);
// Сколько секунд партия не может длиться дольше: защита от «времени в минус»
// и от мусора в поле времени.
const MAX_SECONDS = 6 * 60 * 60;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

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

  const game = String(body.game ?? '');
  if (!GAMES.has(game)) return json({ error: 'bad_game' }, 400);
  const seed = num(body.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) return json({ error: 'bad_seed' }, 400);

  let difficulty = 'none';
  let score = NaN;        // секунды у судоку и сапёра, трубы у flappy
  let proof: Record<string, unknown> = {};

  if (game === 'sudoku') {
    difficulty = String(body.difficulty ?? '');
    const level = SUDOKU_LEVELS[difficulty as keyof typeof SUDOKU_LEVELS];
    if (!level) return json({ error: 'bad_difficulty' }, 400);

    const seconds = num(body.seconds);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SECONDS) return json({ error: 'bad_time' }, 400);
    // Решить судоку быстрее разумного минимума нельзя: столько клеток
    // просто не успеть нажать
    if (seconds < level.minSeconds) return json({ error: 'too_fast' }, 400);

    const solution = Array.isArray(body.solution) ? (body.solution as number[]).map((v) => num(v)) : null;
    if (!solution || !sudokuVerify(seed, difficulty, solution)) return json({ error: 'bad_proof' }, 400);

    score = seconds;
    proof = { seed, difficulty, seconds };

  } else if (game === 'minesweeper') {
    difficulty = String(body.difficulty ?? '');
    const level = MINES_LEVELS[difficulty as keyof typeof MINES_LEVELS];
    if (!level) return json({ error: 'bad_difficulty' }, 400);

    const seconds = num(body.seconds);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_SECONDS) return json({ error: 'bad_time' }, 400);
    if (seconds < level.minSeconds) return json({ error: 'too_fast' }, 400);

    const moves = Array.isArray(body.moves) ? body.moves : null;
    if (!moves || moves.length > level.cols * level.rows * 4) return json({ error: 'bad_proof' }, 400);
    const replay = minesReplay(seed, difficulty, moves);
    if (!replay.won) return json({ error: 'bad_proof' }, 400);

    score = seconds;
    proof = { seed, difficulty, seconds, moves: moves.length };

  } else {
    // flappy: сложности нет, рекорд — число пройденных труб
    const claimed = num(body.score);
    if (!Number.isInteger(claimed) || claimed < 0 || claimed > 100000) return json({ error: 'bad_score' }, 400);

    const flaps = Array.isArray(body.flaps) ? (body.flaps as number[]).map((v) => num(v)) : null;
    if (!flaps || flaps.length > 100000 || flaps.some((v) => !Number.isInteger(v) || v < 0)) {
      return json({ error: 'bad_proof' }, 400);
    }
    const res = flappySimulate(seed, flaps);
    if (res.score !== claimed) return json({ error: 'bad_proof' }, 400);

    score = claimed;
    proof = { seed, flaps: flaps.length, steps: res.steps };
  }

  // Лучший результат: у судоку и сапёра меньше — лучше, у flappy больше — лучше
  const betterIsLess = game !== 'flappy';
  const { data: prev } = await admin
    .from('game_records').select('id, score')
    .eq('student_id', studentId).eq('game', game).eq('difficulty', difficulty)
    .maybeSingle();

  if (prev && (betterIsLess ? prev.score <= score : prev.score >= score)) {
    return json({ ok: true, record: prev.score, improved: false });
  }

  const row = {
    student_id: studentId, game, difficulty, score, proof,
    played_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const { error } = prev
    ? await admin.from('game_records').update(row).eq('id', prev.id)
    : await admin.from('game_records').insert(row);
  if (error) return json({ error: 'server_error' }, 500);

  return json({ ok: true, record: score, improved: true });
});
