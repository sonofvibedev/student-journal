// Кто вызвал функцию утилиты сисадмина: расписание (x-cron-secret = CRON_SECRET) или вошедший сисадмин (JWT + таблица sysadmins).
import { admin } from './common.ts';

export function cronOk(req: Request): boolean {
  const s = Deno.env.get('CRON_SECRET');
  return !!s && req.headers.get('x-cron-secret') === s;
}

// user_id сисадмина или null (нет токена, токен чужой или не сисадмин)
export async function sysadminId(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return null;
  const { data: sa } = await admin.from('sysadmins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
  return sa ? auth.user.id : null;
}
