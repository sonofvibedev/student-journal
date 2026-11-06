// Состояние Telegram-бота для сисадмина (JWT): { webhook_url, pending_update_count, last_error, bot_username }.
//   { action: 'reinstall' } заново ставит вебхук так же, как tg-webhook-setup (там вызов по cron-секрету для выкладки, здесь кнопка в интерфейсе).
// Токен бота и секрет вебхука наружу не уходят. Ошибки fetch содержат адрес с токеном, поэтому в логи и ответ идёт только фиксированный код.
import { admin, cors, json } from '../_shared/common.ts';
import { logServer } from '../_shared/oplog.ts';
import { sysadminId } from '../_shared/opsauth.ts';
import { cleanField } from '../_shared/ops-text.ts';

let nameCache: { name: string; at: number } | null = null;   // getMe меняется редко: час в памяти экземпляра
const NAME_TTL_MS = 3_600_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let actor: string | null;
  try { actor = await sysadminId(req); } catch (_) { return json({ error: 'server_error' }, 500); }
  if (!actor) return req.headers.get('Authorization') ? json({ error: 'forbidden' }, 403) : json({ error: 'unauthorized' }, 401);

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return json({ error: 'not_configured' }, 500);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const api = (m: string, payload?: unknown) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());

  try {
    let setOk: boolean | undefined;
    if (body?.action === 'reinstall') {
      const secret = Deno.env.get('TG_WEBHOOK_SECRET');
      if (!secret) return json({ error: 'not_configured' }, 500);
      const set = await api('setWebhook', { url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/tg-bot`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      setOk = set.ok === true;
      await admin.from('audit_log').insert({ actor, action: 'tg_webhook_reinstall', details: { ok: setOk } });
    }
    const info = await api('getWebhookInfo');
    if (!nameCache || Date.now() - nameCache.at > NAME_TTL_MS) {
      const me = await api('getMe').catch(() => null);
      if (me?.result?.username) nameCache = { name: String(me.result.username), at: Date.now() };
    }
    return json({
      ...(setOk === undefined ? {} : { ok: setOk }),
      webhook_url: info.result?.url || null,
      pending_update_count: info.result?.pending_update_count ?? null,
      last_error: info.result?.last_error_message ? cleanField(info.result.last_error_message, 200) : null,
      bot_username: nameCache?.name ?? null,
    });
  } catch (_) {
    await logServer('tg-status', 'telegram_unavailable');
    return json({ error: 'telegram_unavailable' }, 502);
  }
});
