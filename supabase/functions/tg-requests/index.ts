// Раздел «Заявки» для админа в вебе: заявки редакторов на внесение домашки и дедлайнов.
// Состояние то же, что у бота (tg_task_requests): решение здесь обновляет сообщение админа в
// Telegram, решение в боте видно здесь. Логика решения — общая (_shared/tgrequests.ts).
//
//   { ghToken, action: 'list' }                    → { ok, pending: [...], recent: [...] }
//   { ghToken, action: 'approve', id }             → { ok, status: 'approved', record_id }
//   { ghToken, action: 'reject', id, reason? }     → { ok, status: 'rejected' }
//   action: 'cron-expire' + заголовок x-cron-secret → { ok, expired }   (ежедневное задание pg_cron)
//
// Админ — тот, у кого токен GitHub с правом записи в репозиторий журнала (isRepoAdmin), как у
// tg-set-task-editor и journal-save; JWT студента не нужен и не принимается за доказательство.
import { admin, json, cors, loadStudents, studentName } from '../_shared/common.ts';
import { isRepoAdmin } from '../_shared/words.ts';
import { findDuplicate, cleanText } from '../_shared/tgbot.ts';
import {
  TBL, approveRequest, expireStale, ghRead, rejectRequest, type Req,
} from '../_shared/tgrequests.ts';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const WEB = { label: 'web', approvedBy: 'admin' };   // в data.json попадает только «admin»

const ALREADY = (status: string) => json({ error: 'already_decided', status }, 409);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...cors, 'Access-Control-Allow-Headers': cors['Access-Control-Allow-Headers'] + ', x-cron-secret' } });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const action = String(body.action ?? 'list');

  // Ежедневное истечение: по секрету расписания, как у send-reminders
  if (action === 'cron-expire') {
    const secret = Deno.env.get('CRON_SECRET');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);
    return json({ ok: true, expired: await expireStale() });
  }

  if (!await isRepoAdmin(String(body.ghToken ?? ''))) return json({ error: 'not_admin' }, 403);

  if (action === 'list') {
    await expireStale().catch(() => 0);
    const [{ data: open }, { data: recent }] = await Promise.all([
      admin.from(TBL).select('*').in('status', ['pending', 'approving']).order('created_at'),
      admin.from(TBL).select('*').not('status', 'in', '(pending,approving)').order('decided_at', { ascending: false }).limit(20),
    ]);
    const students = await loadStudents().catch(() => []);
    const author = (r: Req) => ({
      student_id: r.author_student_id,
      name: studentName(students.find((s) => s.id === r.author_student_id)) || null,
    });
    let records: Array<Record<string, unknown>> = [];
    try { const { data } = await ghRead(); records = [...(data.homework ?? []), ...(data.deadlines ?? [])]; } catch (_) { /* подсказка о дубле не обязательна */ }
    const pending = (open ?? []) as Req[];
    return json({
      ok: true,
      pending: pending.map((r) => ({
        id: r.id, author: author(r), kind: r.kind, subtype: r.subtype, subject: r.subject, due_date: r.due_date,
        text: r.text, status: r.status, created_at: r.created_at,
        duplicate: findDuplicate(
          { subject: r.subject, dueDate: r.due_date, text: r.text }, records,
          pending.filter((o) => o.id !== r.id)),
      })),
      recent: ((recent ?? []) as Req[]).map((r) => ({
        id: r.id, author: author(r), kind: r.kind, subtype: r.subtype, subject: r.subject, due_date: r.due_date,
        text: r.text, status: r.status, created_at: r.created_at, decided_at: r.decided_at,
        decided_by: r.decided_by === 'author' || r.decided_by === 'system' ? r.decided_by : r.decided_by ? 'admin' : null,
        reject_reason: r.reject_reason, record_id: r.record_id,
      })),
    });
  }

  const id = String(body.id ?? '');
  if (!UUID.test(id)) return json({ error: 'bad_request' }, 400);

  if (action === 'approve') {
    const d = await approveRequest(id, WEB);
    if (d.ok) return json({ ok: true, status: 'approved', record_id: d.req.record_id });
    if (d.code === 'not_found') return json({ error: 'not_found' }, 404);
    if (d.code === 'already') return ALREADY(d.req.status);
    return json({ error: 'github_failed' }, 502);   // заявка осталась pending — можно повторить
  }

  if (action === 'reject') {
    const reason = cleanText(String(body.reason ?? ''), 200) || undefined;
    const d = await rejectRequest(id, WEB, reason);
    if (d.ok) return json({ ok: true, status: 'rejected' });
    if (d.code === 'not_found') return json({ error: 'not_found' }, 404);
    return d.code === 'already' ? ALREADY(d.req.status) : json({ error: 'server_error' }, 500);
  }

  return json({ error: 'bad_request' }, 400);
});
