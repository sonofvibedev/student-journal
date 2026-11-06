// Отправка в Telegram и почту (Resend) и алерты сисадминам. Секреты только из окружения функции:
// TELEGRAM_BOT_TOKEN, RESEND_API_KEY, MAIL_FROM, TG_ADMIN_IDS, ADMIN_EMAIL, SITE_URL. Нет секрета — канал молча пропускается.
// Токен и тексты сообщений в логи не пишем. Без импортов и без Deno на верхнем уровне: чистые функции читает и node-тест.

// Экранирование под parse_mode=HTML: в тексте от пользователей и из базы могут быть < > &
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Кнопка «Открыть журнал» только при https: Telegram не принимает другие ссылки в кнопке, а localhost в продакшене не нужен
export function siteUrl(): string {
  const u = (Deno.env.get('SITE_URL') ?? '').trim().replace(/\/$/, '');
  return u.startsWith('https://') ? u : '';
}

// Куда ведёт кнопка в уведомлении: староста про семестр — в кабинет старосты, остальные — в приложение
export const buttonUrl = (kind: string, site: string) => (site.startsWith('https://') ? `${site}/${kind === 'semester' ? 'headman' : 'app'}.html` : '');

// Telegram-сообщение уведомления: заголовок жирным, текст ниже (всё экранировано).
// Текст сообщений чата в уведомление не попадает никогда: для kind 'chat' берём фиксированную фразу, даже если в строке что-то лежит.
export function dispatchText(kind: string, title: string, body: string | null): string {
  if (kind === 'chat') return '<b>Новое сообщение в чате</b>\nОткройте журнал, чтобы прочитать.';
  return `<b>${esc(title)}</b>${body ? `\n${esc(body)}` : ''}`;
}

// status 0 — сети или токена нет; 403 — пользователь заблокировал бота; 429 — retryAfter секунд ждать
export type TgResult = { ok: boolean; status: number; retryAfter?: number };

export async function sendTelegram(chatId: string | number, text: string, opts?: { url?: string; button?: string }): Promise<TgResult> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return { ok: false, status: 0 };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(opts?.url ? { reply_markup: { inline_keyboard: [[{ text: opts.button ?? 'Открыть журнал', url: opts.url }]] } } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true, status: r.status };
    const j = r.status === 429 ? await r.json().catch(() => null) : null;
    return { ok: false, status: r.status, ...(j?.parameters?.retry_after ? { retryAfter: Number(j.parameters.retry_after) } : {}) };
  } catch (_) { return { ok: false, status: 0 }; }
}

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: Deno.env.get('MAIL_FROM') ?? 'Журнал <onboarding@resend.dev>', to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch (_) { return false; }
}

// Сообщение системным администраторам: Telegram каждому из TG_ADMIN_IDS и письмо на ADMIN_EMAIL. Не бросает.
// Передавать только код ошибки и название группы: ни ответов bseu.by, ни секретов.
export async function alertSysadmins(subject: string, text: string): Promise<void> {
  try {
    const ids = (Deno.env.get('TG_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) await sendTelegram(id, `<b>${esc(subject)}</b>\n${esc(text)}`);
    await sendMail(Deno.env.get('ADMIN_EMAIL') ?? '', subject, text);
  } catch (_) { /* алерт не должен ронять вызвавшую функцию */ }
}
