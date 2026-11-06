// Регистрация вебхука Telegram-бота: Telegram → функция tg-bot. Токен и секрет берутся из секретов функции, наружу не уходят.
//   POST {} с заголовком x-cron-secret → { ok, url, pending_update_count, last_error }
// Нужна, когда бота нельзя настроить с компьютера (api.telegram.org недоступен) и для выкладки в прод.
import { cors, json } from '../_shared/common.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const cron = Deno.env.get('CRON_SECRET');
  if (!cron || req.headers.get('x-cron-secret') !== cron) return json({ error: 'forbidden' }, 403);
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN'), secret = Deno.env.get('TG_WEBHOOK_SECRET');
  if (!token || !secret) return json({ error: 'not_configured' }, 500);
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/tg-bot`;
  const api = (m: string, body?: unknown) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());
  try {
    const set = await api('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    const info = await api('getWebhookInfo');
    return json({ ok: set.ok === true, url: info.result?.url ?? null, pending_update_count: info.result?.pending_update_count ?? null, last_error: info.result?.last_error_message ?? null });
  } catch (_) { return json({ error: 'telegram_unavailable' }, 502); }
});
