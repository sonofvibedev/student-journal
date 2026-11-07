// Новый пароль по коду сброса (без входа): { code, password } → { ok: true, login }
// Код выдаёт староста или сисадмин (password-reset-issue); пароль задаёт сам студент. Лимит: 5 неверных кодов
// с одного адреса за 15 минут (join_attempts, group_key 'reset'). Смена пароля через Auth Admin API завершает
// все сессии пользователя (refresh-токены); уже выданный access-токен живёт до своего срока (по умолчанию час).
import { admin, cors, json, sha256hex, EMAIL_DOMAIN, PASSWORD_MIN, PASSWORD_MAX, maintenanceBlocked } from '../_shared/common.ts';
import { ipHashOf, failsInWindow, logAttempt, MAX_FAILS } from '../_shared/join.ts';
import { normResetCode, RESET_CODE_RE } from '../_shared/reset.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  { const mb = await maintenanceBlocked(req); if (mb) return mb; }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  const ipHash = await ipHashOf(req, 'journal2-reset');
  if ((await failsInWindow(ipHash, 'reset')) >= MAX_FAILS) return json({ error: 'too_many_attempts', retry_after_min: 15 }, 429);

  // Пароль проверяем до кода: опечатка в пароле не тратит попытку
  const password = String(body?.password ?? '');
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return json({ error: 'bad_password' }, 400);

  const code = normResetCode(body?.code);
  const hash = RESET_CODE_RE.test(code) ? await sha256hex(code) : null;
  const { data: row } = hash
    ? await admin.from('password_resets').select('user_id, expires_at, used_at').eq('code_hash', hash).maybeSingle()
    : { data: null };
  if (!row) { await logAttempt(ipHash, 'reset', false); return json({ error: 'invalid_code' }, 404); }
  await logAttempt(ipHash, 'reset', true);
  if (row.used_at) return json({ error: 'code_used' }, 409);
  if (new Date(row.expires_at).getTime() <= Date.now()) return json({ error: 'code_expired' }, 410);

  // Сисадмину код не выпускается (password_reset_issue); здесь — на случай, если роль выдали после выпуска
  const { data: sa } = await admin.from('sysadmins').select('user_id').eq('user_id', row.user_id).maybeSingle();
  if (sa) return json({ error: 'invalid_code' }, 404);

  // Занимаем код атомарно — второй параллельный запрос с тем же кодом получит code_used
  const now = new Date().toISOString();
  const { data: claimed } = await admin.from('password_resets').update({ used_at: now })
    .eq('code_hash', hash).is('used_at', null).gt('expires_at', now).select('user_id');
  if (!claimed?.length) return json({ error: 'code_used' }, 409);
  const release = () => admin.from('password_resets').update({ used_at: null }).eq('code_hash', hash);

  const { data: upd, error } = await admin.auth.admin.updateUserById(row.user_id, { password });
  if (error || !upd?.user) {
    await release();
    return json({ error: error?.code === 'weak_password' ? 'bad_password' : 'server_error' }, error?.code === 'weak_password' ? 400 : 500);
  }
  await admin.from('audit_log').insert({ actor: row.user_id, action: 'password_reset_done', details: { user_id: row.user_id } });

  const email = upd.user.email ?? '';
  return json({ ok: true, login: email.endsWith(`@${EMAIL_DOMAIN}`) ? email.slice(0, -EMAIL_DOMAIN.length - 1) : null });
});
