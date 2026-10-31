// Общее для «Ассоциаций»: дата по Минску, доступ администратора и выдача
// значков. Лежит отдельно, потому что этим пользуются обе функции —
// word-of-day (игра) и word-admin (админ-панель).
import { admin } from './common.ts';
import { assocWords } from './assoc.ts';
import { pickWord, planDay, shiftDay, WINDOW_DAYS, type PoolRow } from './wordpick.ts';

// Сутки считаются по Минску, как и напоминания: иначе «Слово дня» менялось бы
// у студентов в разное время, а в три часа ночи наступал бы следующий день.
export function minskDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

// Кто такой администратор: тот, у кого есть токен GitHub с правом записи в
// репозиторий журнала. Это ровно тот же токен, которым админка сохраняет
// data.json, поэтому отдельного пароля не нужно. Токен нигде не хранится и
// не пишется в журнал — функция только спрашивает о нём GitHub.
const GITHUB_REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';

export async function isRepoAdmin(token: string): Promise<boolean> {
  const clean = String(token ?? '').trim();
  if (!clean || clean.length > 255) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        Authorization: `Bearer ${clean}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'journal-24dmm2',
      },
    });
    if (!res.ok) return false;
    const repo = await res.json();
    return !!repo?.permissions?.push;
  } catch (_) {
    return false;
  }
}

// Записывает значки и возвращает коды тех, что выданы впервые. Повтор не
// страшен: уникальный индекс не даст второй такой строки, 23505 означает
// «уже есть» и ошибкой не считается.
export async function grantBadges(studentId: string, codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const { data: had } = await admin
    .from('student_achievements').select('code')
    .eq('student_id', studentId).in('code', codes);
  const have = new Set((had ?? []).map((r: { code: string }) => r.code));
  const fresh = codes.filter((c) => !have.has(c));
  if (!fresh.length) return [];

  const now = new Date().toISOString();
  const { error } = await admin.from('student_achievements').insert(
    fresh.map((code) => ({
      student_id: studentId, code, period: '', semester: gameSemester(now), earned_at: now,
    })),
  );
  if (error && error.code !== '23505') return [];
  return fresh;
}

// Семестр в том же виде, что и в study-days.json: fall-2026 или spring-2026.
// Сентябрь — январь считаем осенним, остальное весенним.
export function gameSemester(iso: string): string {
  const d = new Date(iso);
  const m = d.getMonth();                 // 0 — январь
  const fall = m >= 8 || m === 0;         // сентябрь…декабрь и январь
  const year = m === 0 ? d.getFullYear() - 1 : d.getFullYear();
  return fall ? `fall-${year}` : `spring-${d.getFullYear()}`;
}

// ============================================================================
// Слово дня: пул, автовыбор, ручная установка. Чистая логика выбора — wordpick.ts.
// ============================================================================

// Слово в каталоге: если такое уже есть — берём его, иначе заводим
export async function wordId(word: string, kind: string, who: string): Promise<number | null> {
  const { data: exist } = await admin.from('word_bank')
    .select('id').eq('word', word).eq('kind', kind).maybeSingle();
  if (exist) return (exist as { id: number }).id;

  const { data: made, error } = await admin.from('word_bank')
    .insert({ kind, word, hints: [], answers: [], created_by: who })
    .select('id').maybeSingle();
  if (error || !made) return null;
  return (made as { id: number }).id;
}

// Пул: слова из индекса рейтингов. Идемпотентно (on conflict do nothing); слова, уже стоявшие в
// word_daily, получают last_used = их последний день.
export async function ensurePool(): Promise<void> {
  const words = await assocWords();
  if (!words.length) return;
  const { data: hist } = await admin.from('word_daily').select('day, word_bank (word)');
  const last = new Map<string, string>();
  for (const r of (hist ?? []) as { day: string; word_bank?: { word: string } }[]) {
    const w = r.word_bank?.word;
    if (w && (last.get(w) ?? '') < r.day) last.set(w, r.day);
  }
  await admin.from('word_pool').upsert(
    words.map((word) => ({ word, last_used: last.get(word) ?? null })),
    { onConflict: 'word', ignoreDuplicates: true },
  );
}

// Пересчитать last_used слов по истории word_daily (после ручной замены слова)
export async function touchPool(words: string[]): Promise<void> {
  for (const word of new Set(words.filter(Boolean))) {
    const { data: ids } = await admin.from('word_bank').select('id').eq('word', word);
    const { data: last } = await admin.from('word_daily').select('day')
      .in('word_id', (ids ?? []).map((r: { id: number }) => r.id))
      .order('day', { ascending: false }).limit(1);
    await admin.from('word_pool')
      .update({ last_used: (last?.[0] as { day: string } | undefined)?.day ?? null }).eq('word', word);
  }
}

export async function dailyRow(day: string): Promise<{ word: string; source: string } | null> {
  const { data } = await admin.from('word_daily')
    .select('source, word_bank (word)').eq('day', day).maybeSingle();
  const word = (data as { word_bank?: { word: string } } | null)?.word_bank?.word;
  return word ? { word, source: (data as { source: string }).source } : null;
}

// Слово на день: есть — вернуть; нет — выбрать из пула и записать (source='auto').
// Гонка двух запусков безвредна: вставка on conflict (day) do nothing, потом перечитываем строку.
// Любую ошибку (например, миграция ещё не накатана) превращаем в null: игра просто ответит has:false.
export async function ensureDailyWord(day: string, rand: () => number = Math.random):
  Promise<{ word: string; source: string; created: boolean } | null> {
  try {
    const have = await dailyRow(day);
    if (have) return { ...have, created: false };

    await ensurePool();
    const { data } = await admin.from('word_pool').select('word, status, last_used');
    const pool: PoolRow[] = ((data ?? []) as { word: string; status: string; last_used: string | null }[])
      .map((r) => ({ word: r.word, enabled: r.status === 'enabled', last_used: r.last_used }));
    const plan = planDay(null, pool, day, rand);
    if (!plan) return null;

    if (plan.resets.length) {
      await admin.from('word_pool').update({ last_used: shiftDay(day, -(WINDOW_DAYS + 1)) })
        .in('word', plan.resets);
    }
    const id = await wordId(plan.word, 'daily', 'auto');
    if (!id) return null;
    await admin.from('word_daily')
      .upsert({ day, word_id: id, created_by: 'auto', source: 'auto' }, { onConflict: 'day', ignoreDuplicates: true });

    const now = await dailyRow(day);
    if (!now) return null;
    // Проиграли гонку — слово другого запуска, свою отметку не ставим
    if (now.word === plan.word) {
      await admin.from('word_pool').update({ last_used: day }).eq('word', plan.word);
    }
    return { ...now, created: now.word === plan.word };
  } catch (_) {
    return null;
  }
}

// Ручная установка слова дня (set_daily и reroll_daily): source='manual'
export async function setDailyManual(day: string, word: string, who: string): Promise<boolean> {
  const old = await dailyRow(day);
  const id = await wordId(word, 'daily', who);
  if (!id) return false;
  const { error } = await admin.from('word_daily')
    .upsert({ day, word_id: id, created_by: who, source: 'manual' }, { onConflict: 'day' });
  if (error) return false;
  await admin.from('word_pool').upsert({ word }, { onConflict: 'word', ignoreDuplicates: true });
  await touchPool([word, old?.word ?? '']);
  return true;
}

// Случайное слово для замены текущего (не равное ему)
export async function pickReplacement(day: string, current: string): Promise<string | null> {
  const { data } = await admin.from('word_pool').select('word, status, last_used');
  const pool: PoolRow[] = ((data ?? []) as { word: string; status: string; last_used: string | null }[])
    .map((r) => ({ word: r.word, enabled: r.status === 'enabled', last_used: r.last_used }));
  return pickWord(pool, day, Math.random, current)?.word ?? null;
}

// Опции (word_settings): нет строки — выключено
export async function getFlag(key: string): Promise<boolean> {
  const { data } = await admin.from('word_settings').select('value').eq('key', key).maybeSingle();
  return (data as { value?: unknown } | null)?.value === true;
}
