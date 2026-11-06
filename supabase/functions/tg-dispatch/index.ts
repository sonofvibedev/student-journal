// Отправка очереди уведомлений в Telegram (pg_cron раз в минуту, заголовок x-cron-secret).
// tg_claim_notifications отдаёт pending-строки с привязкой и включённым типом (и сама пропускает остальные),
// после отправки результат фиксирует tg_notification_done: ошибка возвращает строку в очередь, после 3 попыток — failed.
// Тексты уведомлений и токен в логи не пишем; в базу уходит только короткий код ошибки (tg_403, tg_429, ...).
import { admin, cors, json } from '../_shared/common.ts';
import { sendTelegram, dispatchText, buttonUrl, buttonText, siteUrl } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';

const BUDGET_MS = 50_000;   // pg_cron зовёт раз в минуту: к следующему запуску функция должна закончить
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'forbidden' }, 403);
  // Без токена ничего не берём из очереди: иначе строки сгорели бы за три попытки
  if (!Deno.env.get('TELEGRAM_BOT_TOKEN')) return json({ error: 'not_configured' }, 500);

  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const site = siteUrl();
  let sent = 0, failed = 0, skipped = 0;

  for (let round = 0; round < ROUNDS && left() > 0; round++) {
    const { data: rows, error } = await admin.rpc('tg_claim_notifications', { p_limit: 100 });
    if (error) { console.error('tg-dispatch claim', error.code ?? 'error'); await logServer('tg-dispatch', 'claim_failed', error.code ?? 'error'); return json({ error: 'claim_failed', sent, failed, skipped }, sent || failed ? 200 : 500); }
    if (!rows?.length) break;

    for (const n of rows as { id: string; kind: string; title: string; body: string | null; telegram_id: number | null }[]) {
      const done = (ok: boolean, code: string | null) => admin.rpc('tg_notification_done', { p_id: n.id, p_ok: ok, p_error: code });
      // Время вышло или нет адресата: строку возвращаем в очередь, не теряем
      if (!n.telegram_id || left() <= 0) { skipped++; await done(false, n.telegram_id ? 'deadline' : 'no_link'); continue; }
      const url = buttonUrl(n.kind, site);
      const text = dispatchText(n.kind, n.title, n.body);
      const opts = url ? { url, button: buttonText(n.kind) } : undefined;
      let r = await sendTelegram(n.telegram_id, text, opts);
      if (r.status === 429) {   // Telegram просит подождать: один повтор после паузы (не дольше 5 с)
        await sleep(Math.min(r.retryAfter ?? 1, 5) * 1000);
        r = await sendTelegram(n.telegram_id, text, opts);
      }
      const { error: e } = await done(r.ok, r.ok ? null : `tg_${r.status || 'net'}`);
      if (e) { console.error('tg-dispatch done', e.code ?? 'error'); await logServer('tg-dispatch', 'done_failed', e.code ?? 'error'); }
      if (r.ok) sent++; else failed++;
      await sleep(40);   // ~25 сообщений в секунду: ниже лимита Telegram (30/с)
    }
  }
  return json({ ok: true, sent, failed, skipped });
});
