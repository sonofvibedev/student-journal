// Вход без пароля из Telegram Mini App: { initData } → { token_hash } (клиент: auth.verifyOtp({ token_hash, type: 'magiclink' })).
//
// Пускаем только того, чей telegram_id уже привязан к аккаунту в tg_links (привязка — кодом из бота, функция
// tg_create_link_code). Привязку эта функция не создаёт: иначе «войти без пароля» мог бы любой.
// initData принимаем только с верной подписью токеном бота и не старше часа (_shared/tginit.ts).
// Сисадмину пароль обязателен: у его аккаунта слишком широкие права, чтобы открывать его одним Telegram.
import { admin, cors, json } from '../_shared/common.ts';
import { verifiedTelegramId } from '../_shared/tginit.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!botToken) return json({ error: 'bot_not_configured' }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const initData = String(body.initData ?? '');
  if (!initData || initData.length > 4096) return json({ error: 'bad_request' }, 400);

  const tgId = await verifiedTelegramId(initData, botToken);
  if (!tgId) return json({ error: 'bad_signature' }, 401);

  const { data: link, error: linkErr } = await admin.from('tg_links').select('user_id').eq('telegram_id', tgId).maybeSingle();
  if (linkErr) return json({ error: 'server_error' }, 500);
  if (!link) return json({ error: 'not_linked' }, 404);

  const { data: sa } = await admin.from('sysadmins').select('user_id').eq('user_id', link.user_id).maybeSingle();
  if (sa) return json({ error: 'password_required' }, 403);

  const { data: u, error: uErr } = await admin.auth.admin.getUserById(link.user_id);
  const email = u?.user?.email;
  if (uErr || !email) return json({ error: 'server_error' }, 500);

  const { data: gen, error: genErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = gen?.properties?.hashed_token;
  if (genErr || !tokenHash) return json({ error: 'server_error' }, 500);
  return json({ token_hash: tokenHash });
});
