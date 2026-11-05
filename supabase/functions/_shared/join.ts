// Общее для функций «Журнала 2.0»: вход в группу по коду и регистрация старосты.
import { admin, cors, json, sha256hex, normLogin, LOGIN_RE, PASSWORD_MIN, PASSWORD_MAX, loginToEmail } from './common.ts';

export { admin, cors, json, sha256hex, normLogin, LOGIN_RE, PASSWORD_MIN, PASSWORD_MAX, loginToEmail };

export const MAX_FAILS = 5;          // неверных кодов группы
export const WINDOW_MIN = 15;        // за 15 минут с одного адреса, после этого блок на те же 15 минут

// Код группы: 8 символов без 0/O/1/I/L; пробелы и дефисы игнорируются
export const normGroupCode = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
export const GROUP_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

export async function ipHashOf(req: Request, salt: string): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  return sha256hex(`${salt}:${ip}`);
}

// Сколько неудачных попыток этого типа было за окно
export async function failsInWindow(ipHash: string, groupKey: string, windowMin = WINDOW_MIN): Promise<number> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const { count } = await admin.from('join_attempts').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).eq('group_key', groupKey).eq('ok', false).gte('at', since);
  return count ?? 0;
}

export const logAttempt = (ipHash: string, groupKey: string, ok: boolean) =>
  admin.from('join_attempts').insert({ ip_hash: ipHash, group_key: groupKey, ok });

export const displayName = (s: { last_name?: string | null; first_name?: string | null }) =>
  `${s.last_name ?? ''} ${s.first_name ?? ''}`.trim();

export function checkLoginPassword(login: string, password: string): Response | null {
  if (!LOGIN_RE.test(login)) return json({ error: 'bad_login' }, 400);
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return json({ error: 'bad_password' }, 400);
  return null;
}
