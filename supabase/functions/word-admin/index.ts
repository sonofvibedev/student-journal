// Админ-панель «Ассоциаций»: слово на сегодня и набор для тренировки.
//
// Кто админ: тот, у кого есть токен GitHub с правом записи в репозиторий
// журнала — ровно тот же токен, которым админка сохраняет data.json. Функция
// сама спрашивает о нём GitHub и нигде его не хранит. Без этой проверки
// слово мог бы задать кто угодно, а вместе с ним и утечь.
//
// Задать можно только слово, для которого уже посчитан рейтинг: файлы лежат
// в приватном бакете assoc-ranks, их кладёт туда tools/assoc/upload.py.
//
// Действия (поле action):
//   today        что задано на сегодня и сколько человек уже сыграли
//   available    слова, для которых есть рейтинг
//   set_daily    задать слово дня
//   train_list   набор для тренировки
//   train_add    добавить слова в тренировку (списком)
//   train_remove убрать слово из тренировки
import { admin, json, cors } from '../_shared/common.ts';
import { minskDay, isRepoAdmin } from '../_shared/words.ts';
import { assocNormalize, assocWords } from '../_shared/assoc.ts';

type Body = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Вход в журнал тоже нужен: по нему видно, кто задал слово
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);
  const { data: profile } = await admin
    .from('profiles').select('student_id').eq('user_id', auth.user.id).maybeSingle();
  if (!profile?.student_id) return json({ error: 'no_profile' }, 403);

  let body: Body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await isRepoAdmin(String(body.ghToken ?? ''))) return json({ error: 'not_admin' }, 403);
  const who: string = profile.student_id;
  const action = String(body.action ?? 'today');
  const day = minskDay();

  if (action === 'today') {
    const { data } = await admin.from('word_daily')
      .select('day, created_by, word_bank (id, word)')
      .eq('day', day).maybeSingle();
    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    const { count: trainCount } = await admin.from('word_bank')
      .select('id', { count: 'exact', head: true }).eq('kind', 'train');
    const { data: used } = await admin.from('word_daily')
      .select('day, word_bank (word)').order('day', { ascending: false }).limit(60);
    return json({
      ok: true, day, word: data ?? null, played: count ?? 0, train: trainCount ?? 0,
      history: (used ?? []).map((r: { day: string; word_bank?: { word: string } }) =>
        ({ day: r.day, word: r.word_bank?.word ?? '' })),
    });
  }

  if (action === 'available') {
    const words = await assocWords();
    return json({ ok: true, words });
  }

  if (action === 'set_daily') {
    const word = assocNormalize(body.word);
    if (!word) return json({ error: 'bad_word' }, 400);
    const words = await assocWords();
    // Без рейтинга игра не заработает, поэтому такое слово не принимаем
    if (!words.includes(word)) return json({ error: 'no_ranks' }, 400);

    const id = await wordId(word, 'daily', who);
    if (!id) return json({ error: 'server_error' }, 500);

    const { error: linkError } = await admin.from('word_daily')
      .upsert({ day, word_id: id, created_by: who }, { onConflict: 'day' });
    if (linkError) return json({ error: 'server_error' }, 500);

    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    return json({ ok: true, day, word, played: count ?? 0 });
  }

  if (action === 'train_list') {
    const { data } = await admin.from('word_bank')
      .select('id, word').eq('kind', 'train')
      .order('id', { ascending: false }).limit(300);
    return json({ ok: true, items: data ?? [] });
  }

  if (action === 'train_add') {
    const raw = Array.isArray(body.words) ? body.words : [body.word];
    const words = raw.map((w) => assocNormalize(w)).filter(Boolean);
    if (!words.length || words.length > 200) return json({ error: 'bad_items' }, 400);

    const have = await assocWords();
    const missing = words.filter((w) => !have.includes(w));
    if (missing.length) return json({ error: 'no_ranks', words: missing }, 400);

    let added = 0;
    for (const word of words) {
      if (await wordId(word, 'train', who)) added++;
    }
    return json({ ok: true, added });
  }

  if (action === 'train_remove') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad_id' }, 400);
    const { error } = await admin.from('word_bank').delete().eq('id', id).eq('kind', 'train');
    if (error) return json({ error: 'server_error' }, 500);
    return json({ ok: true });
  }

  return json({ error: 'bad_action' }, 400);
});

// Слово в каталоге: если такое уже есть — берём его, иначе заводим
async function wordId(word: string, kind: string, who: string): Promise<number | null> {
  const { data: exist } = await admin.from('word_bank')
    .select('id').eq('word', word).eq('kind', kind).maybeSingle();
  if (exist) return (exist as { id: number }).id;

  const { data: made, error } = await admin.from('word_bank')
    .insert({ kind, word, hints: [], answers: [], created_by: who })
    .select('id').maybeSingle();
  if (error || !made) return null;
  return (made as { id: number }).id;
}
