// Значки, которые по одной партии не видны: место в рейтинге и число
// сыгранных игр. Считает их только сервер и только после того, как результат
// уже проверен, — выдать их себе из консоли нельзя.
//
// Пятёрка игр: судоку, сапёр, Flappy, змейка и «Ассоциации». У судоку и
// сапёра несколько сложностей, и топ-5 на любой из них засчитывается: таблица
// лидеров тоже показывает их по сложностям.
import { admin } from './common.ts';

const TIME_GAMES = new Set(['sudoku', 'minesweeper']);
const RECORD_GAMES = ['sudoku', 'minesweeper', 'flappy', 'snake'];
const TOP = 5;

type Row = { student_id: string; difficulty: string; score: number };

// В пятёрке ли студент хоть на одной сложности этой игры
async function inTopFive(studentId: string, game: string): Promise<boolean> {
  const { data } = await admin
    .from('game_records').select('student_id, difficulty, score').eq('game', game);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return false;

  const byDiff = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byDiff.get(r.difficulty) ?? [];
    list.push(r);
    byDiff.set(r.difficulty, list);
  }

  const better = TIME_GAMES.has(game)
    ? (a: Row, b: Row) => a.score - b.score      // время: меньше лучше
    : (a: Row, b: Row) => b.score - a.score;     // трубы и длина: больше лучше

  for (const list of byDiff.values()) {
    const top = list.sort(better).slice(0, TOP);
    if (top.some((r) => r.student_id === studentId)) return true;
  }
  return false;
}

// «Ассоциации»: топ-5 месячного рейтинга считает та же функция, что и
// таблица лидеров, — иначе значок и таблица могли бы разойтись
async function assocTopFive(studentId: string): Promise<boolean> {
  const { data } = await admin.rpc('rpc_assoc_board');
  const rows = (data ?? []) as { student_id: string }[];
  return rows.slice(0, TOP).some((r) => r.student_id === studentId);
}

// Коды значков, которые студент заслужил прямо сейчас. Что из них у него уже
// есть, разбирается grantBadges.
export async function rankBadges(studentId: string): Promise<string[]> {
  const { data: mine } = await admin
    .from('game_records').select('game').eq('student_id', studentId);
  const played = new Set((mine ?? []).map((r: { game: string }) => r.game));

  const { count: assocPlayed } = await admin
    .from('word_attempts').select('id', { count: 'exact', head: true })
    .eq('student_id', studentId);
  if (assocPlayed) played.add('assoc');

  const codes: string[] = [];
  if (played.size) codes.push('game_player');
  if (RECORD_GAMES.every((g) => played.has(g)) && played.has('assoc')) codes.push('game_all_five');

  const tops: string[] = [];
  for (const game of RECORD_GAMES) {
    if (played.has(game) && await inTopFive(studentId, game)) tops.push(game);
  }
  if (played.has('assoc') && await assocTopFive(studentId)) tops.push('assoc');

  if (tops.includes('snake')) codes.push('game_snake_top5');
  if (tops.includes('assoc')) codes.push('game_assoc_top5');
  if (tops.length >= 3) codes.push('game_three_top5');
  if (tops.length >= 5) codes.push('game_five_top5');

  return codes;
}
