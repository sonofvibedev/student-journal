﻿// Админ-панель «Ассоциаций»: слово на сегодня и набор для тренировки.
//
// Кто админ: вошедший студент с isAdmin в списке группы (_shared/admin.ts).
// Без этой проверки слово мог бы задать кто угодно, а вместе с ним и утечь.
//
// Задать можно только слово, для которого уже посчитан рейтинг: файлы лежат
// в приватном бакете assoc-ranks, их кладёт туда tools/assoc/upload.py.
//
// Действия (поле action):
//   today        что задано на сегодня (и откуда: auto/manual), сколько человек уже сыграли;
//                если слова на сегодня ещё нет — оно выбирается автоматически
//   available    слова, для которых есть рейтинг
//   set_daily    задать слово дня
//   train_list   набор для тренировки
//   train_add    добавить слова в тренировку (списком)
//   train_remove убрать слово из тренировки
//   pool_list    пул автовыбора: слово, статус, когда использовано
//   pool_toggle  {word, enabled} включить/выключить слово в автовыборе
//   set_setting  {key, value} опции: notify_admin_telegram, allow_reroll
//   reroll_daily заменить слово сегодняшнего дня до первого ответа игроков (нужна опция allow_reroll)
import { admin, json, cors, maintenanceBlocked } from '../_shared/common.ts';
import {
  minskDay, wordId, ensurePool, ensureDailyWord, dailyRow, setDailyManual,
  pickReplacement, getFlag,
} from '../_shared/words.ts';
import { jwtAdmin } from '../_shared/admin.ts';
import { isAnswered } from '../_shared/wordpick.ts';
import { assocNormalize, assocWords } from '../_shared/assoc.ts';

const SETTINGS = ['notify_admin_telegram', 'allow_reroll'];

type Body = Record<string, unknown>;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  { const mb = await maintenanceBlocked(req); if (mb) return mb; }

  // Вход в журнал тоже нужен: по нему видно, кто задал слово
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);
  const { data: profile } = await admin
    .from('profiles').select('student_id').eq('user_id', auth.user.id).maybeSingle();
  if (!profile?.student_id) return json({ error: 'no_profile' }, 403);

  let body: Body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await jwtAdmin(req)) return json({ error: 'not_admin' }, 403);
  const who: string = profile.student_id;
  const action = String(body.action ?? 'today');
  const day = minskDay();

  if (action === 'today') {
    // Нет слова на сегодня (запуск в полночь пропущен) — выбираем сейчас тем же общим кодом
    await ensureDailyWord(day);
    const { data } = await admin.from('word_daily')
      .select('day, created_by, source, word_bank (id, word)')
      .eq('day', day).maybeSingle();
    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    const { count: trainCount } = await admin.from('word_bank')
      .select('id', { count: 'exact', head: true }).eq('kind', 'train');
    const { data: used } = await admin.from('word_daily')
      .select('day, source, word_bank (word)').order('day', { ascending: false }).limit(60);
    return json({
      ok: true, day, word: data ?? null, source: (data as { source?: string } | null)?.source ?? null,
      played: count ?? 0, train: trainCount ?? 0,
      settings: {
        notify_admin_telegram: await getFlag('notify_admin_telegram'),
        allow_reroll: await getFlag('allow_reroll'),
      },
      history: (used ?? []).map((r: { day: string; source: string; word_bank?: { word: string } }) =>
        ({ day: r.day, word: r.word_bank?.word ?? '', source: r.source })),
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

    if (!await setDailyManual(day, word, who)) return json({ error: 'server_error' }, 500);

    const { count } = await admin.from('word_attempts')
      .select('id', { count: 'exact', head: true }).eq('day', day);
    return json({ ok: true, day, word, played: count ?? 0 });
  }

  if (action === 'pool_list') {
    await ensurePool();
    const { data } = await admin.from('word_pool')
      .select('word, status, last_used').order('word');
    const today = await dailyRow(day);
    return json({
      ok: true, day, today,
      items: (data ?? []).map((r: { word: string; status: string; last_used: string | null }) => ({
        word: r.word, enabled: r.status === 'enabled', last_used: r.last_used, today: r.word === today?.word,
      })),
    });
  }

  if (action === 'pool_toggle') {
    const word = assocNormalize(body.word);
    if (!word || typeof body.enabled !== 'boolean') return json({ error: 'bad_request' }, 400);
    const { data, error } = await admin.from('word_pool')
      .update({ status: body.enabled ? 'enabled' : 'disabled' }).eq('word', word).select('word');
    if (error) return json({ error: 'server_error' }, 500);
    if (!data?.length) return json({ error: 'no_word' }, 404);
    return json({ ok: true, word, enabled: body.enabled });
  }

  if (action === 'set_setting') {
    const key = String(body.key ?? '');
    if (!SETTINGS.includes(key) || typeof body.value !== 'boolean') return json({ error: 'bad_request' }, 400);
    const { error } = await admin.from('word_settings').upsert({ key, value: body.value }, { onConflict: 'key' });
    if (error) return json({ error: 'server_error' }, 500);
    return json({ ok: true, key, value: body.value });
  }

  if (action === 'reroll_daily') {
    if (!await getFlag('allow_reroll')) return json({ error: 'reroll_off' }, 403);
    // «Ответ» — строка с названным словом, подсказкой или сдачей; пустые строки от просмотра не в счёт
    const { data: rows } = await admin.from('word_attempts')
      .select('guesses, tries, hints, gave_up').eq('day', day);
    if ((rows ?? []).some(isAnswered)) return json({ error: 'already_played' }, 409);

    const current = await ensureDailyWord(day);
    let word = assocNormalize(body.word);
    if (word) {
      if (!(await assocWords()).includes(word)) return json({ error: 'no_ranks' }, 400);
    } else {
      word = (current ? await pickReplacement(day, current.word) : null) ?? '';
    }
    if (!word) return json({ error: 'no_candidates' }, 409);
    if (!await setDailyManual(day, word, who)) return json({ error: 'server_error' }, 500);
    return json({ ok: true, day, word, source: 'manual' });
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
