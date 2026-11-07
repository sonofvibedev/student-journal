// Проверка подписи initData из Telegram Mini App. Чистая функция: без Deno и сети, поэтому её гоняет tests/unit/tg-init.mjs.
const MAX_AGE_SEC = 3600;
const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Сравнение за время, не зависящее от того, где строки разошлись
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// По документации Telegram: ключ = HMAC("WebAppData", токен бота). Возвращает telegram_id или null.
// Данные старше часа (и из «будущего») не принимаем: подпись вечна, а вход по ней — нет.
export async function verifiedTelegramId(initData: string, botToken: string, nowSec = Date.now() / 1000): Promise<number | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  if (!sameString(hex(await hmac(secret, check)), hash)) return null;
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Math.abs(nowSec - authDate) > MAX_AGE_SEC) return null;
  try {
    const id = Number(JSON.parse(params.get('user') ?? 'null')?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (_) { return null; }
}
