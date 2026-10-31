// Полночный запуск «Слова дня»: pg_cron в 21:00 UTC = 00:00 по Минску (journal-word-auto).
//
// Два независимых шага, ошибка одного другой не отменяет, статус каждого — в ответе:
//   1. finalize  подведение итогов ВЧЕРАШНЕГО дня (rpc finalize_assoc_day, идемпотентно); если
//                функции в базе ещё нет — шаг пропускается, в журнал уходит только тип ошибки;
//   2. word      слово НОВОГО дня из пула (ensureDailyWord): повторный запуск ничего не меняет.
// Необязательно (опция notify_admin_telegram, по умолчанию выключена): слово админу в Telegram.
//
// Слово не попадает ни в ответ, ни в журнал функции. Запуск — только с секретом x-cron-secret
// (CRON_SECRET, как у send-reminders). Руками: см. docs/word-auto.md.
import { admin, json, cors } from '../_shared/common.ts';
import { minskDay, ensureDailyWord, getFlag } from '../_shared/words.ts';
import { shiftDay } from '../_shared/wordpick.ts';
import { checkSecret } from '../_shared/tgbot.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!checkSecret(req.headers.get('x-cron-secret'), Deno.env.get('CRON_SECRET'))) {
    return json({ error: 'forbidden' }, 403);
  }

  const day = minskDay();
  const yesterday = shiftDay(day, -1);

  // Шаг 1: итоги вчерашнего дня
  let finalize: Record<string, unknown>;
  try {
    const { data, error } = await admin.rpc('finalize_assoc_day', { p_day: yesterday });
    if (error) {
      finalize = { ok: false, skipped: true, error: String(error.code ?? 'rpc_error') };
      console.log('word-auto finalize skipped:', finalize.error);   // только тип ошибки
    } else {
      finalize = { ok: true, day: yesterday, added: data };
    }
  } catch (e) {
    finalize = { ok: false, error: (e as Error)?.name ?? 'error' };
    console.log('word-auto finalize failed:', finalize.error);
  }

  // Шаг 2: слово нового дня
  let word: Record<string, unknown>;
  try {
    const res = await ensureDailyWord(day);
    if (!res) {
      word = { ok: false, error: 'no_word' };
      console.log('word-auto word: not set');
    } else {
      word = { ok: true, day, created: res.created, source: res.source };
      if (res.created && await getFlag('notify_admin_telegram')) {
        word.notified = await notifyAdmins(day, res.word);
      }
    }
  } catch (e) {
    word = { ok: false, error: (e as Error)?.name ?? 'error' };
    console.log('word-auto word failed:', word.error);
  }

  return json({ ok: true, day, finalize, word });
});

// Слово админам в Telegram (telegram_id из TG_ADMIN_IDS). Ошибки доставки установку слова не ломают
// и в журнал не попадают; сколько сообщений доставлено — в ответе.
async function notifyAdmins(day: string, word: string): Promise<number> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const ids = (Deno.env.get('TG_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token) return 0;
  let sent = 0;
  for (const chat_id of ids) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text: `Слово дня на ${day}: ${word}` }),
      });
      if (res.ok) sent++;
    } catch (_) { /* не доставилось — не страшно */ }
  }
  return sent;
}
