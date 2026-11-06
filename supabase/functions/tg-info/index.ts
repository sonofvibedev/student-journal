// Имя бота для кабинета (кнопка «Открыть бота в Telegram»). Публичный POST без входа: имя бота и так видно всем.
// getMe кэшируем на час в памяти функции; нет токена или Telegram недоступен — { bot_username: null }.
import { cors, json } from '../_shared/common.ts';

let cache: { name: string | null; at: number } | null = null;
const TTL_MS = 3_600_000;

async function botName(): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.name;
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8_000) });
    const name = r.ok ? ((await r.json())?.result?.username ?? null) : null;
    if (name) cache = { name: String(name), at: Date.now() };   // неудачу не кэшируем: следующий запрос попробует снова
    return name ? String(name) : null;
  } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  return json({ bot_username: await botName() });
});
