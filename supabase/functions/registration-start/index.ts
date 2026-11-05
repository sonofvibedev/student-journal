// Начало регистрации нового старосты (шаг 2 «Вы»): создаёт аккаунт Auth (почта + пароль) и черновик заявки.
//   { name, email, password } → { ok: true }   затем клиент входит обычным signInWithPassword
// Без входа. Публичная регистрация в Auth выключена, аккаунты создаёт только эта функция.
// Лимит: 5 регистраций в час с одного адреса. Почта без подтверждения письмом: заявку всё равно
// одобряет системный администратор вручную, а до одобрения у аккаунта нет доступа ни к одной группе.
import { admin, cors, json, ipHashOf, failsInWindow, logAttempt, PASSWORD_MIN, PASSWORD_MAX } from '../_shared/join.ts';
import { EMAIL_DOMAIN, maintenanceBlocked } from '../_shared/common.ts';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PER_HOUR = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  { const mb = await maintenanceBlocked(req); if (mb) return mb; }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (name.length < 3 || name.length > 80) return json({ error: 'bad_name' }, 400);
  if (!EMAIL_RE.test(email) || email.endsWith(`@${EMAIL_DOMAIN}`)) return json({ error: 'bad_email' }, 400);
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return json({ error: 'bad_password' }, 400);

  // Лимит считаем по всем попыткам (ok=false у нас означает «отказ по лимиту/ошибке», регистрация фиксируется как ok=true отдельно)
  const ipHash = await ipHashOf(req, 'journal2-reg');
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await admin.from('join_attempts').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).eq('group_key', 'registration').gte('at', since);
  if ((count ?? 0) >= PER_HOUR) return json({ error: 'too_many_attempts', retry_after_min: 60 }, 429);
  await logAttempt(ipHash, 'registration', true);

  const { data: created, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }, app_metadata: { kind: 'headman_candidate' },
  });
  if (error || !created.user) {
    if (error?.code === 'email_exists') return json({ error: 'email_taken' }, 409);
    if (error?.code === 'weak_password') return json({ error: 'bad_password' }, 400);
    return json({ error: 'server_error' }, 500);
  }
  const { error: rErr } = await admin.from('registration_requests').insert({
    owner_user_id: created.user.id, status: 'draft', step: 2, payload: { owner: { name, email } },
  });
  if (rErr) { await admin.auth.admin.deleteUser(created.user.id); return json({ error: 'server_error' }, 500); }
  await admin.from('audit_log').insert({ actor: created.user.id, action: 'registration_started', details: {} });
  return json({ ok: true });
});
