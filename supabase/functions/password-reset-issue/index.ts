// Код сброса пароля для студента (староста/заместитель его группы или сисадмин):
//   { student_id } + Authorization: Bearer <access_token> → { code: 'ABCDE-23456', expires_at }
// Код показывается ОДИН раз: в базе только его sha-256, повторно не получить (можно выпустить новый, старый погаснет).
// Права и запреты (себе, сисадмину, старосте без сисадмина, …) проверяет SQL-функция password_reset_issue.
import { admin, cors, json, sha256hex, maintenanceBlocked } from '../_shared/common.ts';
import { newResetCode } from '../_shared/reset.ts';

const ERRORS: Record<string, number> = { forbidden: 403, forbidden_target: 403, no_student: 404, no_account: 404, self: 409, bad_request: 400 };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  { const mb = await maintenanceBlocked(req); if (mb) return mb; }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const studentId = String(body?.student_id ?? '');
  if (!studentId || studentId.length > 100) return json({ error: 'bad_request' }, 400);

  const { raw, shown } = newResetCode();
  const { data, error } = await admin.rpc('password_reset_issue', {
    p_actor: auth.user.id, p_student_id: studentId, p_code_hash: await sha256hex(raw),
  });
  if (error) {
    const status = ERRORS[error.message];
    return status ? json({ error: error.message }, status) : json({ error: 'server_error' }, 500);
  }
  return json({ code: shown, expires_at: data?.expires_at ?? null });
});
