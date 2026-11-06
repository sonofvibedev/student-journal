// Рассылка «Журнал обновился» после сброса привязок Telegram (кнопка сисадмина: сначала RPC tg_reset_all, потом эта функция).
// Берёт строки tg_rebind без broadcast_at и со старым telegram_id, шлёт короткое сообщение, у успешных ставит broadcast_at.
// Неудачные остаются без отметки: повторный запуск попробует снова. Вход: JWT сисадмина.
import { admin, cors, json } from '../_shared/common.ts';
import { sendTelegram } from '../_shared/notify.ts';

const TEXT = 'Журнал обновился. Войдите заново: отправьте код из кабинета.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);
  const { data: sa } = await admin.from('sysadmins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
  if (!sa) return json({ error: 'forbidden' }, 403);
  if (!Deno.env.get('TELEGRAM_BOT_TOKEN')) return json({ error: 'not_configured' }, 500);

  const { data: rows, error } = await admin.from('tg_rebind').select('user_id, old_telegram_id').is('broadcast_at', null).not('old_telegram_id', 'is', null);
  if (error) return json({ error: 'server_error' }, 500);

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    const res = await sendTelegram(r.old_telegram_id, TEXT);
    if (res.ok) {
      await admin.from('tg_rebind').update({ broadcast_at: new Date().toISOString() }).eq('user_id', r.user_id);
      sent++;
    } else failed++;
    await sleep(40);   // не больше ~25 сообщений в секунду
  }
  await admin.from('audit_log').insert({ actor: auth.user.id, action: 'tg_rebind_broadcast', details: { sent, failed } });
  return json({ sent, failed });
});
