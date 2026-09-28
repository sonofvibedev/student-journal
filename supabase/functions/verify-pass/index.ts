// Проверка пропуска Studak для pass.html (без входа): { token } → действителен ли токен.
// Отдаёт только то, что видно на пропуске: student_id (ФИО, роль и номер pass.html берёт из data.json),
// логин и ссылку на фото, которая живёт 5 минут. Секретный ключ — только в окружении функции.
import { admin, json, cors } from '../_shared/common.ts';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ valid: false }, 400); }
  const token = String(body.token ?? '');
  if (!TOKEN_RE.test(token)) return json({ valid: false });

  const { data, error } = await admin.rpc('verify_pass_token', { p_token: token });
  if (error) return json({ error: 'server_error' }, 500);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return json({ valid: false });

  let photo_url: string | null = null;
  const signed = await admin.storage.from('avatars').createSignedUrl(`${row.user_id}.jpg`, 300);
  if (!signed.error && signed.data?.signedUrl) photo_url = signed.data.signedUrl;

  return json({ valid: true, student_id: row.student_id, login: row.login, photo_url, expires_at: row.expires_at });
});
