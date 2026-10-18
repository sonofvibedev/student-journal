// Админ-панель «Ассоциаций»: слово на сегодня и набор для тренировки.
//
// Кто админ: тот, у кого есть токен GitHub с правом записи в репозиторий
// журнала — ровно тот же токен, которым админка сохраняет data.json. Функция
// сама спрашивает о нём GitHub и нигде его не хранит. Без этой проверки
// слово и подсказки мог бы записать кто угодно, а вместе с ними и утечь.
//
// Действия (поле action):
//   today        что задано на сегодня и сколько человек уже сыграли
//   set_daily    задать слово дня (слово, 6 подсказок, синонимы)
//   train_list   набор для тренировки
//   train_add    добавить слова в тренировку (можно списком)
//   train_remove убрать слово из тренировки
import { admin, json, cors } from '../_shared/common.ts';
import { minskDay, isRepoAdmin } from '../_shared/words.ts';

// Подсказок ровно шесть — столько же, сколько в правилах игры (ASSOC.hints).
// Здесь это просто число: тянуть ради него все правила игр в функцию незачем.
const HINTS = 6;

type Body = Record<string, unknown>;
type Item = { word: string; hints: string[]; answers: string[] };

const MAX_WORD = 48;
const MAX_HINT = 80;
const MAX_ANSWERS = 12;

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
      .select('day, created_by, word_bank (id, word, hints, answers)')
      .eq('day', day).maybeSingle();
    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    const { count: trainCount } = await admin.from('word_bank')
      .select('id', { count: 'exact', head: true }).eq('kind', 'train');
    return json({ ok: true, day, word: data ?? null, played: count ?? 0, train: trainCount ?? 0 });
  }

  if (action === 'set_daily') {
    const item = readItem(body);
    if (typeof item === 'string') return json({ error: item }, 400);

    const { data: made, error } = await admin.from('word_bank')
      .insert({ kind: 'daily', word: item.word, hints: item.hints, answers: item.answers, created_by: who })
      .select('id').maybeSingle();
    if (error || !made) return json({ error: 'server_error' }, 500);

    // Слово дня можно заменить, пока его не сыграли: upsert по дате
    const { error: linkError } = await admin.from('word_daily')
      .upsert({ day, word_id: made.id, created_by: who }, { onConflict: 'day' });
    if (linkError) return json({ error: 'server_error' }, 500);

    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    return json({ ok: true, day, played: count ?? 0 });
  }

  if (action === 'train_list') {
    const { data } = await admin.from('word_bank')
      .select('id, word, hints, answers').eq('kind', 'train')
      .order('id', { ascending: false }).limit(200);
    return json({ ok: true, items: data ?? [] });
  }

  if (action === 'train_add') {
    const raw = Array.isArray(body.items) ? body.items : [body];
    if (!raw.length || raw.length > 100) return json({ error: 'bad_items' }, 400);
    const rows: Record<string, unknown>[] = [];
    for (const one of raw) {
      const item = readItem(one as Body);
      if (typeof item === 'string') return json({ error: item, at: rows.length + 1 }, 400);
      rows.push({ kind: 'train', word: item.word, hints: item.hints, answers: item.answers, created_by: who });
    }
    const { error } = await admin.from('word_bank').insert(rows);
    if (error) return json({ error: 'server_error' }, 500);
    return json({ ok: true, added: rows.length });
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

// Проверка присланного слова. Возвращает готовую запись или код ошибки
// строкой — так понятнее, что именно не так, чем «bad_request» на всё.
function readItem(src: Body): Item | string {
  const word = String(src.word ?? '').trim();
  if (!word || word.length > MAX_WORD) return 'bad_word';

  const hints = Array.isArray(src.hints) ? src.hints.map((h) => String(h ?? '').trim()) : [];
  if (hints.length !== HINTS) return 'bad_hints_count';
  if (hints.some((h) => !h || h.length > MAX_HINT)) return 'bad_hint';

  const answers = Array.isArray(src.answers)
    ? src.answers.map((a) => String(a ?? '').trim()).filter(Boolean)
    : [];
  if (answers.length > MAX_ANSWERS) return 'bad_answers';
  if (answers.some((a) => a.length > MAX_WORD)) return 'bad_answers';

  return { word, hints, answers };
}
