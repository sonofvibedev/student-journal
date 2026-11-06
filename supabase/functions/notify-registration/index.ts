// Уведомления о заявках на регистрацию старост: Telegram и почта (Resend).
//   { kind: 'submitted', request_id }  — вызывает староста (владелец заявки) после отправки: письмо и Telegram системному администратору
//   { kind: 'decided',   request_id }  — вызывает системный администратор после решения: староста узнаёт результат
// Идемпотентно: повтор по той же заявке и событию ничего не отправляет (отметка в audit_log).
// Код группы в уведомление НЕ попадает (он показывается один раз на экране); только факт решения и ссылка.
// Секреты функции (в репозитории их нет): RESEND_API_KEY, MAIL_FROM, ADMIN_EMAIL, TELEGRAM_BOT_TOKEN, TG_ADMIN_IDS, SITE_URL.
// Нет секрета — канал пропускается, функция не падает: заявка не должна зависеть от почты.
import { admin, cors, json } from '../_shared/common.ts';
import { sendMail } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';   // тот же Resend-запрос; sendTelegram тут свой: текст без HTML-разметки

const SITE = () => (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');

async function sendTelegram(chatId: string | number, text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!token) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch (_) { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json({ error: 'unauthorized' }, 401);
  const uid = auth.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const kind = body.kind === 'submitted' || body.kind === 'decided' ? body.kind : null;
  const rid = typeof body.request_id === 'string' ? body.request_id : '';
  if (!kind || !/^[0-9a-f-]{36}$/.test(rid)) return json({ error: 'bad_request' }, 400);

  const { data: r } = await admin.from('registration_requests').select('id, owner_user_id, status, payload, reject_reason, group_id').eq('id', rid).maybeSingle();
  if (!r) return json({ error: 'not_found' }, 404);

  const action = `notify_${kind}`;
  const { data: done } = await admin.from('audit_log').select('id').eq('action', action).contains('details', { request_id: rid }).limit(1);
  if (done?.length) return json({ ok: true, repeated: true });

  const group = (r.payload?.group ?? {}) as Record<string, string>;
  const owner = (r.payload?.owner ?? {}) as Record<string, string>;
  const gname = group.group_name ?? 'новая группа';
  const sent: Record<string, boolean> = {};

  if (kind === 'submitted') {
    if (r.owner_user_id !== uid || r.status !== 'submitted') return json({ error: 'forbidden' }, 403);
    const n = Array.isArray(r.payload?.students) ? r.payload.students.length : 0;
    const text = `Новая заявка на регистрацию группы ${gname}: староста ${owner.name ?? '—'}, студентов ${n}. Откройте «Роли → заявки»${SITE() ? `: ${SITE()}/sysadmin.html` : ''}.`;
    for (const id of (Deno.env.get('TG_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) sent[`tg:${id}`] = await sendTelegram(id, text);
    sent.mail = await sendMail(Deno.env.get('ADMIN_EMAIL') ?? '', `Журнал: заявка ${gname}`, text);
  } else {
    const { data: sys } = await admin.from('sysadmins').select('user_id').eq('user_id', uid).maybeSingle();
    if (!sys) return json({ error: 'forbidden' }, 403);
    if (r.status !== 'approved' && r.status !== 'rejected') return json({ error: 'not_decided' }, 409);
    const ok = r.status === 'approved';
    const text = ok
      ? `Заявка на группу ${gname} одобрена. Откройте страницу заявки и нажмите «Показать код группы»${SITE() ? `: ${SITE()}/register.html` : ''}.`
      : `Заявка на группу ${gname} отклонена.${r.reject_reason ? ` Причина: ${r.reject_reason}` : ''}`;
    const { data: tg } = await admin.from('tg_links').select('telegram_id').eq('user_id', r.owner_user_id).maybeSingle();
    if (tg?.telegram_id) sent.tg = await sendTelegram(tg.telegram_id, text);
    sent.mail = await sendMail(owner.email ?? '', `Журнал: заявка ${ok ? 'одобрена' : 'отклонена'}`, text);
  }

  // Каналы настроены, но ни один не сработал: сисадмину это видно в логе (в самих секретах и адресах причины нет)
  if (Object.keys(sent).length && !Object.values(sent).some(Boolean)) await logServer('notify-registration', 'not_sent', kind);

  // Отмечаем как «отправлено» только если хоть один канал сработал: без секретов (или при сбое) повтор позже разрешён
  if (Object.values(sent).some(Boolean)) {
    await admin.from('audit_log').insert({ actor: uid, group_id: r.group_id ?? null, action, details: { request_id: rid, sent } });
  }
  return json({ ok: true, sent });
});
