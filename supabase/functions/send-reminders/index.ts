// Рассылка напоминаний о дедлайнах и домашке.
//
// Запускает pg_cron раз в сутки в 06:00 UTC = 09:00 по Минску
// (в Беларуси круглый год UTC+3, перевода часов нет).
//
// Дедлайны и домашку берём из опубликованного data.json, а не из базы:
// источник правды у них один — файл в репозитории.
// В базе только подписки и журнал отправок.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    if (keys.default) return keys.default;
  } catch (_) { /* старый формат окружения */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Дата в Минске (UTC+3) с отступом в днях
function minskDate(offsetDays = 0): string {
  const t = new Date(Date.now() + 3 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return t.toISOString().slice(0, 10);
}

type Item = { id: string; kind: string; subject: string; text?: string; dueDate: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Запускать рассылку может только тот, кто знает секрет расписания
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) return json({ error: 'forbidden' }, 403);

  const siteUrl = Deno.env.get('SITE_URL');
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY');
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY');
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!siteUrl) return json({ error: 'site_url_not_configured' }, 500);

  // --- Что сегодня напоминать ---
  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/data.json?t=${Date.now()}`);
    if (!res.ok) return json({ error: 'data_fetch_failed', status: res.status }, 502);
    data = await res.json();
  } catch (e) {
    return json({ error: 'data_fetch_failed', detail: String(e) }, 502);
  }

  const today = minskDate(0);
  const tomorrow = minskDate(1);
  const items: Array<Item & { stage: 'due' | 'day1' }> = [];
  const collect = (list: unknown, kind: string) => {
    (Array.isArray(list) ? list : []).forEach((raw) => {
      const x = raw as Item;
      if (!x || !x.dueDate || !x.id) return;
      if (x.dueDate === today) items.push({ ...x, kind, stage: 'due' });
      else if (x.dueDate === tomorrow) items.push({ ...x, kind, stage: 'day1' });
    });
  };
  collect(data.deadlines, 'Дедлайн');
  collect(data.homework, 'Домашка');

  if (!items.length) return json({ ok: true, today, items: 0, sent: 0 });

  // --- Кому слать ---
  const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth');
  const { data: chats } = await admin.from('tg_subscribers').select('chat_id');
  const { data: alreadySent } = await admin.from('notify_log')
    .select('item_id, stage, target')
    .gte('sent_at', new Date(Date.now() - 3 * 86400 * 1000).toISOString());
  const sentKey = new Set((alreadySent ?? []).map((r) => `${r.item_id}|${r.stage}|${r.target}`));

  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails(`${siteUrl.replace(/\/$/, '')}`, vapidPublic, vapidPrivate);
  }

  const logRows: Array<{ item_id: string; stage: string; target: string }> = [];
  const deadEndpoints: string[] = [];
  let sent = 0;
  const errors: string[] = [];

  for (const item of items) {
    const when = item.stage === 'due' ? 'сегодня' : 'завтра';
    const title = `${item.kind}: ${when}`;
    const body = [item.subject, item.text].filter(Boolean).join(' — ');

    // Web Push
    if (vapidPublic && vapidPrivate) {
      for (const sub of subs ?? []) {
        const key = `${item.id}|${item.stage}|${sub.endpoint}`;
        if (sentKey.has(key)) continue;
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title, body, tag: `${item.id}-${item.stage}`, url: './index.html#homework' }),
          );
          logRows.push({ item_id: item.id, stage: item.stage, target: sub.endpoint });
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // 404/410 — подписка больше не жива: удалим, чтобы не стучаться впустую
          if (status === 404 || status === 410) deadEndpoints.push(sub.endpoint);
          else errors.push(`push ${status ?? ''}: ${String(e).slice(0, 120)}`);
        }
      }
    }

    // Сообщение от бота
    if (botToken) {
      for (const chat of chats ?? []) {
        const target = `tg:${chat.chat_id}`;
        const key = `${item.id}|${item.stage}|${target}`;
        if (sentKey.has(key)) continue;
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat.chat_id, text: `${title}\n${body}`, disable_notification: false }),
          });
          if (res.ok) { logRows.push({ item_id: item.id, stage: item.stage, target }); sent++; }
          else errors.push(`telegram ${res.status}`);
        } catch (e) {
          errors.push(`telegram: ${String(e).slice(0, 120)}`);
        }
      }
    }
  }

  if (logRows.length) await admin.from('notify_log').upsert(logRows, { onConflict: 'item_id,stage,target' });
  if (deadEndpoints.length) await admin.from('push_subscriptions').delete().in('endpoint', deadEndpoints);
  // Журнал старше двух месяцев ни на что не влияет
  await admin.from('notify_log').delete().lt('sent_at', new Date(Date.now() - 60 * 86400 * 1000).toISOString());

  return json({
    ok: true, today, items: items.length, sent,
    pushSubscribers: (subs ?? []).length, telegramSubscribers: (chats ?? []).length,
    removedDead: deadEndpoints.length,
    errors: errors.slice(0, 5),
  });
});
