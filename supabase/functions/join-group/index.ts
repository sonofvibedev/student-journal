// Вход студента в группу по коду группы (экраны: код → «выберите себя» → согласие → логин и пароль → ожидание).
//   { action: 'lookup', code }                                    → { group: {id, name}, students: [{id, name}] }  (только свободные)
//   { action: 'claim', code, student_id, login, password,
//     consent: { accepted: true, version, text_hash } }           → { ok: true, login }
//   { action: 'release' } + Authorization: Bearer <access_token>   → { ok: true }   «Это не я»: пока студент в ожидании, запись освобождается,
//                                                                    аккаунт удаляется (терять нечего), вход начинается заново
// Без входа. Лимит: 5 неверных кодов с одного адреса за 15 минут, потом блок на 15 минут.
// Аккаунт создаётся здесь (публичная регистрация в Auth выключена); доступ к данным группы
// студент получит только после подтверждения старостой (membership.status = 'active', RLS).
import { admin, cors, json, sha256hex, normLogin, loginToEmail, checkLoginPassword, normGroupCode, GROUP_CODE_RE, ipHashOf, failsInWindow, logAttempt, MAX_FAILS, displayName } from '../_shared/join.ts';
import { maintenanceBlocked } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  { const mb = await maintenanceBlocked(req); if (mb) return mb; }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  if (body.action !== 'lookup' && body.action !== 'claim' && body.action !== 'release') return json({ error: 'bad_request' }, 400);

  if (body.action === 'release') {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    const uid = auth.user.id;
    // Только пока студент ждёт подтверждения или старый ответ «Не он»: активного студента отпускает только староста (student_reset_binding)
    const { data: mem } = await admin.from('memberships').select('group_id, student_id, status').eq('user_id', uid).in('status', ['pending', 'rejected']).maybeSingle();
    if (!mem) return json({ error: 'not_pending' }, 409);
    if (mem.student_id) {
      await admin.from('students').update({ claim_status: 'free', claimed_by: null, claimed_at: null }).eq('id', mem.student_id).eq('claimed_by', uid);
    }
    await admin.from('audit_log').insert({ actor: uid, group_id: mem.group_id, action: 'join_release', details: { student_id: mem.student_id } });
    await admin.auth.admin.deleteUser(uid);
    return json({ ok: true });
  }

  const ipHash = await ipHashOf(req, 'journal2-join');
  if ((await failsInWindow(ipHash, 'join')) >= MAX_FAILS) return json({ error: 'too_many_attempts', retry_after_min: 15 }, 429);

  const code = normGroupCode(body.code);
  let invite: { group_id: string } | null = null;
  if (GROUP_CODE_RE.test(code)) {
    const { data } = await admin.from('group_invites').select('group_id').eq('code_hash', await sha256hex(code)).maybeSingle();
    invite = data;
  }
  if (!invite) { await logAttempt(ipHash, 'join', false); return json({ error: 'invalid_code' }, 404); }
  await logAttempt(ipHash, 'join', true);

  const { data: group } = await admin.from('groups').select('id, name, status').eq('id', invite.group_id).maybeSingle();
  if (!group) return json({ error: 'invalid_code' }, 404);

  if (body.action === 'lookup') {
    const { data: free } = await admin.from('students').select('id, last_name, first_name, sort')
      .eq('group_id', group.id).eq('claim_status', 'free').order('last_name').order('first_name');
    return json({ group: { id: group.id, name: group.name }, students: (free ?? []).map((s) => ({ id: s.id, name: displayName(s) })) });
  }

  // ---- claim
  const studentId = String(body.student_id ?? '');
  const login = normLogin(body.login);
  const password = String(body.password ?? '');
  const consent = (body.consent ?? {}) as Record<string, unknown>;
  const bad = checkLoginPassword(login, password);
  if (bad) return bad;
  if (consent.accepted !== true || typeof consent.version !== 'string' || !consent.version) return json({ error: 'consent_required' }, 400);

  const { data: student } = await admin.from('students').select('id, claim_status').eq('id', studentId).eq('group_id', group.id).maybeSingle();
  if (!student) return json({ error: 'no_student' }, 404);
  if (student.claim_status !== 'free') return json({ error: 'student_taken' }, 409);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: loginToEmail(login), password, email_confirm: true, app_metadata: { student_id: studentId, group_id: group.id },
  });
  if (createError || !created.user) {
    if (createError?.code === 'email_exists') return json({ error: 'login_taken' }, 409);
    if (createError?.code === 'weak_password') return json({ error: 'bad_password' }, 400);
    return json({ error: 'server_error' }, 500);
  }
  const userId = created.user.id;
  const undo = async () => { await admin.auth.admin.deleteUser(userId); };

  // Занимаем запись атомарно: два человека одновременно не выберут одну фамилию
  const { data: claimed } = await admin.from('students')
    .update({ claim_status: 'pending', claimed_by: userId, claimed_at: new Date().toISOString() })
    .eq('id', studentId).eq('group_id', group.id).eq('claim_status', 'free').select('id');
  if (!claimed?.length) { await undo(); return json({ error: 'student_taken' }, 409); }

  const now = new Date().toISOString();
  const { error: mErr } = await admin.from('memberships').insert({
    user_id: userId, group_id: group.id, student_id: studentId, base_role: 'student', status: 'pending',
    consent_at: now, consent_version: consent.version,
  });
  if (mErr) {
    await admin.from('students').update({ claim_status: 'free', claimed_by: null, claimed_at: null }).eq('id', studentId);
    await undo();
    return json({ error: 'server_error' }, 500);
  }
  await admin.from('consents').insert({ user_id: userId, group_id: group.id, version: consent.version, text_hash: String(consent.text_hash ?? '') || null });
  await admin.from('audit_log').insert({ actor: userId, group_id: group.id, action: 'join_request', details: { student_id: studentId } });
  return json({ ok: true, login });
});
