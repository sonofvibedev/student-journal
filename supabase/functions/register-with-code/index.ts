// Первый вход и восстановление доступа по одноразовому коду.
//   { action: 'check', code }                    → { student_id, has_account, login? }
//   { action: 'register', code, login, password } → { ok, login }  (создать аккаунт или задать новый пароль)
// Публичная регистрация в Supabase Auth выключена: аккаунты создаёт только эта функция.
import { admin, cors, json, sha256hex, loginToEmail, normLogin, LOGIN_RE, PASSWORD_MIN, PASSWORD_MAX } from '../_shared/common.ts';

const MAX_FAILS = 10;            // неудачных вводов кода с одного IP
const WINDOW_MIN = 15;           // за 15 минут

const normCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');

async function tooManyFails(ipHash: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
  const { count } = await admin.from('code_attempts').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).gte('at', since);
  return (count ?? 0) >= MAX_FAILS;
}

async function findCode(code: string, ipHash: string) {
  if (!/^[A-Z0-9]{10}$/.test(code)) {
    await admin.from('code_attempts').insert({ ip_hash: ipHash });
    return { error: 'invalid_code' as const };
  }
  const { data } = await admin.from('invite_codes').select('id, student_id, used_at')
    .eq('code_hash', await sha256hex(code)).maybeSingle();
  if (!data) {
    await admin.from('code_attempts').insert({ ip_hash: ipHash });
    return { error: 'invalid_code' as const };
  }
  if (data.used_at) return { error: 'code_used' as const };
  return { row: data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipHash = await sha256hex(`journal-24dmm2:${ip}`);
  if (await tooManyFails(ipHash)) return json({ error: 'too_many_attempts' }, 429);

  const found = await findCode(normCode(body.code), ipHash);
  if ('error' in found) return json({ error: found.error }, found.error === 'code_used' ? 409 : 404);
  const { id: codeId, student_id } = found.row;

  const { data: profile } = await admin.from('profiles').select('user_id, login').eq('student_id', student_id).maybeSingle();

  if (body.action === 'check') {
    return json({ student_id, has_account: !!profile, login: profile?.login ?? null });
  }
  if (body.action !== 'register') return json({ error: 'bad_request' }, 400);

  const login = normLogin(body.login);
  const password = String(body.password ?? '');
  if (!LOGIN_RE.test(login)) return json({ error: 'bad_login' }, 400);
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return json({ error: 'bad_password' }, 400);

  // Занимаем код атомарно — второй параллельный запрос с тем же кодом получит code_used
  const { data: claimed } = await admin.from('invite_codes').update({ used_at: new Date().toISOString() })
    .eq('id', codeId).is('used_at', null).select('id');
  if (!claimed?.length) return json({ error: 'code_used' }, 409);
  const release = () => admin.from('invite_codes').update({ used_at: null }).eq('id', codeId);

  const { data: taken } = await admin.from('profiles').select('user_id').eq('login', login).maybeSingle();
  if (taken && taken.user_id !== profile?.user_id) { await release(); return json({ error: 'login_taken' }, 409); }

  if (profile) {
    // Восстановление доступа: тот же аккаунт и аватарка, новый пароль (и логин, если изменён)
    const patch: Record<string, unknown> = { password };
    if (login !== profile.login) {
      patch.email = loginToEmail(login);
      patch.email_confirm = true;
      const { error } = await admin.from('profiles').update({ login, updated_at: new Date().toISOString() }).eq('user_id', profile.user_id);
      if (error) { await release(); return json({ error: error.code === '23505' ? 'login_taken' : 'server_error' }, error.code === '23505' ? 409 : 500); }
    }
    const { error } = await admin.auth.admin.updateUserById(profile.user_id, patch);
    if (error) {
      if (login !== profile.login) await admin.from('profiles').update({ login: profile.login }).eq('user_id', profile.user_id);
      await release();
      return json({ error: error.code === 'weak_password' ? 'bad_password' : 'server_error' }, error.code === 'weak_password' ? 400 : 500);
    }
    return json({ ok: true, login });
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: loginToEmail(login), password, email_confirm: true, app_metadata: { student_id },
  });
  if (createError || !created.user) {
    await release();
    if (createError?.code === 'email_exists') return json({ error: 'login_taken' }, 409);
    if (createError?.code === 'weak_password') return json({ error: 'bad_password' }, 400);
    return json({ error: 'server_error' }, 500);
  }
  const { error: profileError } = await admin.from('profiles').insert({ user_id: created.user.id, student_id, login });
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    await release();
    return json({ error: profileError.code === '23505' ? 'login_taken' : 'server_error' }, profileError.code === '23505' ? 409 : 500);
  }
  return json({ ok: true, login });
});
