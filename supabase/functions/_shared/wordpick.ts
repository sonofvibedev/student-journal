// Чистая логика автоматического «Слова дня»: выбор слова из пула и даты.
// Без сети, базы и импортов — поэтому её проверяет tools/test-word-auto.js под обычным node
// (только «стираемые» типы TypeScript). Работа с таблицами — в _shared/words.ts.

export const WINDOW_DAYS = 60;          // столько суток слово не повторяется
const DAY_MS = 86_400_000;

export type PoolRow = { word: string; enabled: boolean; last_used: string | null };

// 'YYYY-MM-DD' ± n суток (календарная арифметика в UTC, без часовых поясов)
export function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

const byAge = (a: PoolRow, b: PoolRow) =>
  (a.last_used ?? '').localeCompare(b.last_used ?? '') || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0);

// Выбор слова на день.
// Подходят включённые слова, которых не было последние WINDOW_DAYS суток (или не было никогда).
// Если таких нет — «окно» исчерпано: берём 1/3 самых давних включённых слов (минимум одно;
// никогда не использованные считаются самыми давними), помечаем их к сбросу и выбираем среди них.
// Вызывающий записывает last_used = shiftDay(day, -(WINDOW_DAYS + 1)) для слов из resets.
// rand — генератор [0, 1); на фиксированном генераторе результат детерминирован.
// exclude — слово, которое выбирать нельзя (замена текущего слова).
export function pickWord(
  pool: PoolRow[], day: string, rand: () => number, exclude?: string,
): { word: string; resets: string[] } | null {
  const enabled = pool.filter((p) => p.enabled && p.word !== exclude).sort(byAge);
  if (!enabled.length) return null;

  let candidates = enabled.filter((p) => !p.last_used || daysBetween(p.last_used, day) >= WINDOW_DAYS);
  let resets: string[] = [];
  if (!candidates.length) {
    candidates = enabled.slice(0, Math.max(1, Math.ceil(enabled.length / 3)));
    resets = candidates.map((p) => p.word);
  }
  const words = candidates.map((p) => p.word).sort();     // порядок не зависит от выдачи базы
  const i = Math.min(words.length - 1, Math.floor(rand() * words.length));
  return { word: words[i], resets };
}

// Идемпотентность: если на день слово уже есть — оно и остаётся, ничего не выбирается и не сбрасывается.
export function planDay(
  existing: string | null, pool: PoolRow[], day: string, rand: () => number,
): { word: string; created: boolean; resets: string[] } | null {
  if (existing) return { word: existing, created: false, resets: [] };
  const pick = pickWord(pool, day, rand);
  return pick ? { word: pick.word, created: true, resets: pick.resets } : null;
}

// «Ответом» игрока считается строка с названным словом, подсказкой или сдачей. Пустая строка
// (её заводит любое обращение, даже просмотр состояния) ответом не является.
export function isAnswered(a: { guesses?: unknown; tries?: number; hints?: number; gave_up?: boolean }): boolean {
  return (Array.isArray(a.guesses) && a.guesses.length > 0)
    || (a.tries ?? 0) > 0 || (a.hints ?? 0) > 0 || !!a.gave_up;
}
