// Сохранение личной части журнала: список студентов и пропуски.
// { students, absences } + Authorization: Bearer <access_token> → { ok, updated_at }
//
// Кто может: вошедший студент с isAdmin в списке группы (см. _shared/admin.ts).
// Читают эти данные вошедшие студенты напрямую из таблицы (RLS), см. миграцию journal_private.
import { admin, json, cors } from '../_shared/common.ts';
import { isAdminReq } from '../_shared/admin.ts';

const MAX_BYTES = 2_000_000;

const isObjArray = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max &&
  v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof (x as { id?: unknown }).id === 'string');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: 'too_large' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await isAdminReq(req, body)) return json({ error: 'not_admin' }, 403);
  if (!isObjArray(body.students, 500) || !isObjArray(body.absences, 50_000)) return json({ error: 'bad_request' }, 400);
  // Без единого админа в списке войти в админку было бы нечем
  if (!(body.students as { isAdmin?: boolean }[]).some((x) => x.isAdmin === true)) return json({ error: 'no_admin_left' }, 400);

  const updated_at = new Date().toISOString();
  const { error } = await admin.from('journal_private')
    .update({ students: body.students, absences: body.absences, updated_at })
    .eq('id', 'main');
  if (error) return json({ error: 'server_error' }, 500);
  return json({ ok: true, updated_at });
});
