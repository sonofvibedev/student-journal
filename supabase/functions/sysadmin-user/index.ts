// Учётная запись по почте для сисадмина (JWT): нужна, чтобы назначить преподавателя или сисадмина, которого ещё нет в Auth.
//   { email } → есть такой пользователь: { user_id, created: false }
//             → нет: создаём (почта подтверждена) со случайным паролем и возвращаем { user_id, created: true, password } ОДИН раз.
// Пароль нигде не сохраняется и не пишется в журналы (audit_log и client_events получают только факт создания).
// Адреса домена студентов нельзя: это синтетические логины студентов, настоящая почта там не бывает.
import { admin, cors, EMAIL_DOMAIN, json } from '../_shared/common.ts';
import { logServer } from '../_shared/oplog.ts';
import { sysadminId } from '../_shared/opsauth.ts';
import { genPassword, validEmail } from '../_shared/ops-text.ts';

// ponytail: у Auth нет поиска по почте в админском API, листаем страницами по 1000. Потолок — десятки тысяч пользователей;
// дальше нужна SQL-функция поиска по auth.users под секретным ключом.
async function findByEmail(email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error('list_users');
    const u = data.users.find((x) => (x.email ?? '').toLowerCase() === email);
    if (u) return u.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const actor = await sysadminId(req);
    if (!actor) return req.headers.get('Authorization') ? json({ error: 'forbidden' }, 403) : json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!validEmail(email)) return json({ error: 'bad_email' }, 400);
    if (email.endsWith(`@${EMAIL_DOMAIN}`)) return json({ error: 'student_domain' }, 400);

    const found = await findByEmail(email);
    if (found) return json({ user_id: found, created: false });

    const password = genPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data?.user) {
      // Гонка двух сисадминов: пользователя только что создали, отдаём его без пароля
      const again = await findByEmail(email);
      if (again) return json({ user_id: again, created: false });
      await logServer('sysadmin-user', 'create_failed', String(error?.status ?? 'unknown'));
      return json({ error: 'create_failed' }, 500);
    }
    await admin.from('audit_log').insert({ actor, action: 'sysadmin_user_create', details: { user_id: data.user.id, email } });
    return json({ user_id: data.user.id, created: true, password });
  } catch (e) {
    await logServer('sysadmin-user', 'exception', e instanceof Error ? e.name : 'unknown');
    return json({ error: 'server_error' }, 500);
  }
});
