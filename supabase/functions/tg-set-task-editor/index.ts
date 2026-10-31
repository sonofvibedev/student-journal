// Кому можно вносить задачи через Telegram-бота: выдать или снять флаг profiles.can_post_tasks.
//   { ghToken, action: 'list' }                            → { editors: [{ student_id, login, linked }] }
//   { ghToken, action: 'set', studentId, value: boolean }  → { ok }
//
// Кто может: тот, у кого токен GitHub с правом записи в репозиторий журнала (isRepoAdmin) —
// ровно тот же токен, которым админка сохраняет data.json. Сам студент флаг не меняет:
// у него нет права записи в profiles, а эта функция — единственный путь.
import { admin, json, cors } from '../_shared/common.ts';
import { isRepoAdmin } from '../_shared/words.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await isRepoAdmin(String(body.ghToken ?? ''))) return json({ error: 'not_admin' }, 403);

  const action = String(body.action ?? 'list');

  if (action === 'list') {
    const { data: rows, error } = await admin.from('profiles')
      .select('user_id, student_id, login').eq('can_post_tasks', true);
    if (error) return json({ error: 'server_error' }, 500);
    const ids = (rows ?? []).map((r) => r.user_id);
    const { data: links } = ids.length
      ? await admin.from('tg_links').select('user_id').in('user_id', ids)
      : { data: [] };
    const linked = new Set((links ?? []).map((l) => l.user_id));
    return json({
      ok: true,
      editors: (rows ?? []).map((r) => ({ student_id: r.student_id, login: r.login, linked: linked.has(r.user_id) })),
    });
  }

  if (action === 'set') {
    const studentId = String(body.studentId ?? '').trim();
    if (!studentId || studentId.length > 64 || typeof body.value !== 'boolean') return json({ error: 'bad_request' }, 400);
    const { data, error } = await admin.from('profiles')
      .update({ can_post_tasks: body.value, updated_at: new Date().toISOString() })
      .eq('student_id', studentId).select('user_id');
    if (error) return json({ error: 'server_error' }, 500);
    // Нет профиля — студент ещё не зарегистрировался в журнале
    if (!data?.length) return json({ error: 'no_profile' }, 404);
    // Снятое право действует сразу: бот проверяет флаг на каждое действие
    return json({ ok: true });
  }

  return json({ error: 'bad_request' }, 400);
});
