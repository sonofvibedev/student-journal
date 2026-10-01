// Подписка на напоминания от бота: { initData } → { ok }.
//
// chat_id берём из initData, но только после проверки подписи токеном бота:
// без этой проверки кто угодно мог бы подписать на рассылку чужой чат.
// Токен бота живёт только в секретах функции.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
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

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', k, enc.encode(data));
}

// Проверка по документации Telegram: ключ = HMAC("WebAppData", токен бота)
async function verifyInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const sig = await hmac(secret, check);
  if (hex(sig) !== hash) return null;

  // Старые данные не принимаем: подпись вечна, а окно доверия — сутки
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try { return JSON.parse(params.get('user') ?? 'null'); } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!botToken) return json({ error: 'bot_not_configured' }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }

  const initData = String(body.initData ?? '');
  if (!initData) return json({ error: 'bad_request' }, 400);

  const user = await verifyInitData(initData, botToken);
  if (!user || !user.id) return json({ error: 'bad_signature' }, 401);

  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || null;
  const { error } = await admin.from('tg_subscribers').upsert({
    chat_id: user.id,
    tg_user_id: user.id,
    tg_name: name,
  }, { onConflict: 'chat_id' });

  if (error) return json({ error: 'server_error' }, 500);
  return json({ ok: true });
});
