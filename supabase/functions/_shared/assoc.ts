// Общее для «Ассоциаций»: нормализация слова, очки и работа с рейтингом.
//
// Рейтинг — это порядок всех слов словаря по близости к загаданному. Он лежит
// в приватном бакете assoc-ranks, по файлу на слово, и читается только этой
// функцией под service_role. В память изолята кладётся разобранный файл:
// пока изолят живёт, повторные запросы того же дня не скачивают ничего.
import { admin } from './common.ts';

export const BUCKET = 'assoc-ranks';

// Очки за угаданное слово дня. Чем меньше попыток и подсказок, тем больше,
// но меньше десяти не бывает. Сдался — ноль, это считает вызывающий код.
export function assocPoints(tries: number, hints: number): number {
  const t = Number.isFinite(tries) && tries > 0 ? Math.floor(tries) : 1;
  const h = Number.isFinite(hints) && hints > 0 ? Math.floor(hints) : 0;
  return Math.max(10, 100 - 2 * (t - 1) - 10 * h);
}

// Ввод приводим к виду словаря: регистр, ё, края и лишние пробелы внутри
// не должны решать, знает игра слово или нет.
export function assocNormalize(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

// Подсказка: слово ближе лучшего результата игрока, примерно на половине пути
// до первого места. Уже названные слова пропускаем, идя ещё ближе к цели.
// Само загаданное слово подсказкой не выдаём — иначе это не подсказка, а ответ.
export function assocHint(ranks: Ranks, best: number, used: Set<string>): { word: string; rank: number } | null {
  const from = Number.isFinite(best) && best > 1 ? Math.floor(best) : ranks.words.length;
  let rank = Math.max(2, Math.floor(from / 2));
  while (rank < from && used.has(ranks.words[rank - 1])) rank++;
  if (rank >= from) {
    // Между лучшим результатом и целью всё уже названо — берём ближайшее
    // свободное место сверху
    for (let r = 2; r < from; r++) {
      if (!used.has(ranks.words[r - 1])) { rank = r; break; }
    }
  }
  const word = ranks.words[rank - 1];
  if (!word || used.has(word) || rank >= from) return null;
  return { word, rank };
}
