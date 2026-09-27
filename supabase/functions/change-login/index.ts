// Смена логина вошедшим студентом: { login } + Authorization: Bearer <access_token>.
// Логин хранится в двух местах (profiles.login и технический email в Auth) — меняем оба.
import { admin, json, cors, loginToEmail, normLogin, LOGIN_RE } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  const user = auth?.user;
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const login = normLogin(body.login);
  if (!LOGIN_RE.test(login)) return json({ error: 'bad_login' }, 400);

  const { data: profile } = await admin.from('profiles').select('login').eq('user_id', user.id).maybeSingle();
  if (!profile) return json({ error: 'no_profile' }, 404);
  if (profile.login === login) return json({ ok: true, login });

  const { error: dbError } = await admin.from('profiles').update({ login, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  if (dbError) return json({ error: dbError.code === '23505' ? 'login_taken' : 'server_error' }, dbError.code === '23505' ? 409 : 500);

  const { error: authError } = await admin.auth.admin.updateUserById(user.id, { email: loginToEmail(login), email_confirm: true });
  if (authError) {
    await admin.from('profiles').update({ login: profile.login }).eq('user_id', user.id);
    return json({ error: authError.code === 'email_exists' ? 'login_taken' : 'server_error' }, authError.code === 'email_exists' ? 409 : 500);
  }
  return json({ ok: true, login });
});
