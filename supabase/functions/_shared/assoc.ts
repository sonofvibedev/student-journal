// Общее для «Ассоциаций»: нормализация слова, очки и работа с рейтингом.
//
// Рейтинг — это порядок всех слов словаря по близости к загаданному. Он лежит
// в приватном бакете assoc-ranks, по файлу на слово, и читается только этой
// функцией под service_role. В память изолята кладётся разобранный файл:
// пока изолят живёт, повторные запросы того же дня не скачивают ничего.
import { admin } from './common.ts';
// Правила игры — те же, что у страницы: нормализация ввода, очки и выбор
// подсказки живут в games-core.js, чтобы сервер и клиент не разошлись.
import { assocNormalize, assocPoints, assocHintRank } from './games-core.js';

export { assocNormalize, assocPoints };

export const BUCKET = 'assoc-ranks';

export type Ranks = {
  word: string;
  words: string[];               // по местам: words[0] — само загаданное слово
  place: Map<string, number>;    // слово → место, начиная с 1
};

const cache = new Map<string, Ranks>();

// Рейтинг загаданного слова. Файл скачивается один раз на изолят.
export async function loadRanks(word: string): Promise<Ranks | null> {
  const key = assocNormalize(word);
  const cached = cache.get(key);
  if (cached) return cached;

  const { data, error } = await admin.storage.from(BUCKET).download(key + '.json.gz');
  if (error || !data) return null;

  const unzipped = data.stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(unzipped).text();
  const parsed = JSON.parse(text) as { word: string; words: string[] };
  if (!parsed?.words?.length) return null;

  const place = new Map<string, number>();
  parsed.words.forEach((w, i) => place.set(w, i + 1));
  const ranks: Ranks = { word: assocNormalize(parsed.word), words: parsed.words, place };

  // Больше трёх слов в памяти держать незачем: в ходу слово дня и, может,
  // пара тренировочных
  if (cache.size >= 3) cache.delete(cache.keys().next().value as string);
  cache.set(key, ranks);
  return ranks;
}

// Подсказка: слово ближе лучшего результата игрока. Правило общее с клиентом,
// здесь только подставляем рейтинг.
export function assocHint(ranks: Ranks, best: number, used: Set<string>) {
  return assocHintRank(ranks.words, best, used);
}
