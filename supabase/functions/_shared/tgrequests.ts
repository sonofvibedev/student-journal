// Заявки на внесение задач: общая часть для бота (tg-bot) и веб-раздела «Заявки» (tg-requests).
// Состояние одно — таблица tg_task_requests; решение из бота видно в вебе и наоборот,
// а сообщение админа в Telegram обновляется при любом решении.
//
// Схема статусов (переходы — TRANSITIONS в tgbot.ts, каждый — один условный UPDATE):
//   pending ──claim──▶ approving ──commit──▶ approved
//      │                  └─rollback (GitHub не ответил)─▶ pending
//      ├─reject─▶ rejected   ├─withdraw─▶ withdrawn   └─expire (7 суток)─▶ expired
// Запись в data.json делается только между claim и commit, с id, назначенным при claim:
// повторное внесение (после обрыва) находит запись по id и ничего не дублирует.
import { Buffer } from 'node:buffer';
import { admin, loadStudents, studentName } from './common.ts';
import {
  TRANSITIONS, approvingStale, buildRecord, commitMessage, recordIdFor, requestSummary,
  type Kind, type TaskRecord,
} from './tgbot.ts';

// deno-lint-ignore no-explicit-any
export type Any = any;

export const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const GH_TOKEN = Deno.env.get('GITHUB_TOKEN');
const GH_REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';
const GH_BRANCH = Deno.env.get('GITHUB_BRANCH') ?? 'main';
export const ADMIN_IDS = new Set((Deno.env.get('TG_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export const TBL = 'tg_task_requests';
export type Req = {
  id: string; author_user_id: string | null; author_student_id: string; kind: Kind; subtype: string | null;
  subject: string; due_date: string; text: string; status: string; reject_reason: string | null;
  created_at: string; decided_at: string | null; decided_by: string | null;
  admin_message_refs: Array<{ chat_id: number; message_id: number }>; record_id: string | null;
};
export type By = { label: string; approvedBy: string };   // label — в базу и журнал, approvedBy — в data.json (публично!)

// ---------- Telegram ----------
export type Button = [string, string];
export async function tg(method: string, body: Record<string, unknown>): Promise<Any | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('telegram', method, res.status); return null; }   // без тел и токена
    return await res.json();
  } catch (_) { console.error('telegram', method, 'network'); return null; }
}
export const keyboard = (rows: Button[][]) => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});
export async function say(chat: number, text: string, rows?: Button[][]): Promise<number | null> {
  const r = await tg('sendMessage', { chat_id: chat, text, ...(rows ? { reply_markup: keyboard(rows) } : {}) });
  return r?.result?.message_id ?? null;
}

// ---------- GitHub: data.json ----------
const ghUrl = `https://api.github.com/repos/${GH_REPO}/contents/data.json`;
const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'journal-24dmm2-bot', 'X-GitHub-Api-Version': '2022-11-28',
});

export async function ghRead(): Promise<{ data: Any; sha: string }> {
  if (!GH_TOKEN) throw new Error('github_not_configured');
  const res = await fetch(`${ghUrl}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`github_read_${res.status}`);
  const j = await res.json();
  const text = Buffer.from(String(j.content ?? ''), 'base64').toString('utf8').replace(/^﻿/, '');
  return { data: JSON.parse(text), sha: j.sha };
}

// Прочитать свежий data.json → изменить → записать с sha. mutate вернёт null, если менять нечего.
// При 409/422 (кто-то успел раньше) читаем заново, до трёх попыток. Формат — как у админки.
export async function updateData<T>(mutate: (data: Any) => { result: T; message: string } | null): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, sha } = await ghRead();
    const out = mutate(data);
    if (!out) return null;
    data.lastUpdated = new Date().toISOString();
    const res = await fetch(ghUrl, {
      method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: out.message, branch: GH_BRANCH, sha,
        content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
      }),
    });
    if (res.ok) return out.result;
    if (res.status !== 409 && res.status !== 422) throw new Error(`github_write_${res.status}`);
  }
  throw new Error('github_conflict');
}

export function findRec(data: Any, id: string) {
  for (const key of ['homework', 'deadlines'] as const) {
    const list: TaskRecord[] = Array.isArray(data[key]) ? data[key] : [];
    const i = list.findIndex((r) => r && r.id === id);
    if (i >= 0) return { key, list, i, rec: list[i] };
  }
  return null;
}
export const listKey = (k: Kind) => (k === 'homework' ? 'homework' : 'deadlines');
export const kindOf = (rec: TaskRecord): Kind => (String(rec.id).startsWith('hw-') ? 'homework' : 'deadline');

// ---------- Имена, журнал ----------
export async function authorName(studentId: string): Promise<string> {
  try {
    const s = (await loadStudents()).find((x) => x.id === studentId);
    return studentName(s) || 'Студент';
  } catch (_) { return 'Студент'; }
}

export async function logAction(
  kind: 'request_created' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'admin_direct' | 'approve_failed',
  actor: string, requestId?: string | null, recordId?: string | null, actorUserId?: string | null,
) {
  const { error } = await admin.from('tg_action_log').insert({
    kind, actor, request_id: requestId ?? null, record_id: recordId ?? null, actor_user_id: actorUserId ?? null,
  });
  if (error) console.error('action log', error.code);   // журнал не должен ломать решение
}

// ---------- Сообщения по заявке ----------
const decisionKeyboard = (id: string): Button[][] => [
  [['Одобрить', `ap:${id}`], ['Отклонить', `rj:${id}`]],
  [['Отклонить с причиной', `rr:${id}`]],
];

// Отправляет заявку всем админам и запоминает сообщения, чтобы потом их обновить.
// Недоставленное (бот заблокирован и т. п.) только логируется: заявка остаётся ждать решения.
export async function notifyAdmins(req: Req, name: string, dupNote: string): Promise<number> {
  const text = (dupNote ? `${dupNote}\n\n` : '') + requestSummary(req, name);
  const refs: Req['admin_message_refs'] = [];
  for (const id of ADMIN_IDS) {
    const chat = Number(id);
    if (!Number.isFinite(chat)) continue;
    const mid = await say(chat, text, decisionKeyboard(req.id));
    if (mid) refs.push({ chat_id: chat, message_id: mid }); else console.error('admin notify failed');
  }
  await admin.from(TBL).update({ admin_message_refs: refs }).eq('id', req.id);
  return refs.length;
}

// Правит сообщения заявки у всех админов: итог вместо кнопок. Ошибки игнорируем.
export async function refreshAdminMessages(req: Req, headline: string) {
  const name = await authorName(req.author_student_id);
  const text = `${headline}\n\n${requestSummary(req, name)}`;
  for (const ref of req.admin_message_refs ?? []) {
    await tg('editMessageText', {
      chat_id: ref.chat_id, message_id: ref.message_id, text, reply_markup: { inline_keyboard: [] },
    });
  }
}

export async function notifyAuthor(req: Req, text: string) {
  if (!req.author_user_id) return;
  const { data } = await admin.from('tg_links').select('telegram_id').eq('user_id', req.author_user_id).maybeSingle();
  if (data?.telegram_id) await say(data.telegram_id, text);
}

const brief = (r: Req) => `${r.subject}, до ${r.due_date.slice(8, 10)}.${r.due_date.slice(5, 7)}`;

// ---------- Создание ----------
export async function submitRequest(
  userId: string, studentId: string, f: { kind: Kind; subtype: string | null; subject: string; dueDate: string; text: string },
): Promise<{ ok: true; req: Req } | { ok: false; code: 'too_many' | 'error' }> {
  const { data: id, error } = await admin.rpc('tg_submit_request', {
    p_user: userId, p_student: studentId, p_kind: f.kind, p_subtype: f.subtype,
    p_subject: f.subject, p_due: f.dueDate, p_text: f.text, p_max: 5,
  });
  if (error) {
    if (String(error.message).includes('too_many_pending')) return { ok: false, code: 'too_many' };
    console.error('submit request', error.code);
    return { ok: false, code: 'error' };
  }
  const { data: req } = await admin.from(TBL).select('*').eq('id', id).single();
  return { ok: true, req: req as Req };
}

// ---------- Решения ----------
export type Decision =
  | { ok: true; req: Req }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'already'; req: Req }     // уже решена (или идёт внесение): req — актуальное состояние
  | { ok: false; code: 'github'; req: Req };     // внести не вышло, заявка снова pending

async function getReq(id: string): Promise<Req | null> {
  const { data } = await admin.from(TBL).select('*').eq('id', id).maybeSingle();
  return (data as Req) ?? null;
}

export async function approveRequest(id: string, by: By): Promise<Decision> {
  const cur = await getReq(id);
  if (!cur) return { ok: false, code: 'not_found' };
  const now = Date.now(), iso = new Date(now).toISOString();
  const recordId = cur.record_id ?? recordIdFor(cur.kind, now);

  // 1. Занять заявку: только pending → approving, атомарно
  const c = TRANSITIONS.claim;
  let { data: claimed } = await admin.from(TBL)
    .update({ status: c.to, decided_by: by.label, decided_at: iso, record_id: recordId })
    .eq('id', id).eq('status', c.from).select().maybeSingle();
  // Внесение оборвалось (функция упала между claim и commit): через 2 минуты можно подхватить
  if (!claimed && cur.status === 'approving' && cur.decided_at && approvingStale(cur.decided_at, now)) {
    ({ data: claimed } = await admin.from(TBL)
      .update({ decided_by: by.label, decided_at: iso })
      .eq('id', id).eq('status', 'approving').eq('decided_at', cur.decided_at).select().maybeSingle());
  }
  if (!claimed) return { ok: false, code: 'already', req: (await getReq(id)) ?? cur };
  const req = claimed as Req;

  // 2. Внести в data.json. Запись с этим id уже есть — предыдущая попытка дошла до GitHub
  try {
    await updateData((data) => {
      const key = listKey(req.kind);
      if (!Array.isArray(data[key])) data[key] = [];
      if (data[key].some((r: TaskRecord) => r && r.id === req.record_id)) return null;
      const rec = buildRecord(
        req.kind,
        { subject: req.subject, type: req.subtype ?? 'ПЗ', text: req.text, dueDate: req.due_date },
        req.author_student_id, Date.now(), new Set(), req.record_id!,
      );
      rec.approvedBy = by.approvedBy;
      data[key].push(rec);
      return { result: rec, message: commitMessage('добавлено', req.kind, req.subject, req.due_date) };
    });
  } catch (e) {
    // 3a. Не вышло: возвращаем заявку в pending (record_id оставляем — повтор будет идемпотентным)
    const r = TRANSITIONS.rollback;
    await admin.from(TBL).update({ status: r.to, decided_by: null, decided_at: null }).eq('id', id).eq('status', r.from);
    await logAction('approve_failed', by.label, id);
    console.error('approve failed', e instanceof Error ? e.message.slice(0, 60) : 'unknown');
    return { ok: false, code: 'github', req: { ...req, status: 'pending', decided_by: null, decided_at: null } };
  }

  // 3b. Внесено: approving → approved
  const k = TRANSITIONS.commit;
  const { data: done } = await admin.from(TBL)
    .update({ status: k.to, decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', k.from).select().maybeSingle();
  const row = (done as Req) ?? { ...req, status: 'approved' };
  await logAction('approved', by.label, id, row.record_id);
  await refreshAdminMessages(row, 'Одобрено, внесено');
  await notifyAuthor(row, `Админ одобрил, запись добавлена: ${brief(row)}. В приложении появится через 1–2 минуты.`);
  return { ok: true, req: row };
}

export async function rejectRequest(id: string, by: By, reason?: string): Promise<Decision> {
  const cur = await getReq(id);
  if (!cur) return { ok: false, code: 'not_found' };
  const t = TRANSITIONS.reject;
  const { data } = await admin.from(TBL)
    .update({ status: t.to, decided_by: by.label, decided_at: new Date().toISOString(), reject_reason: reason || null })
    .eq('id', id).eq('status', t.from).select().maybeSingle();
  if (!data) return { ok: false, code: 'already', req: (await getReq(id)) ?? cur };
  const row = data as Req;
  await logAction('rejected', by.label, id);
  await refreshAdminMessages(row, reason ? `Отклонено: ${reason}` : 'Отклонено');
  await notifyAuthor(row, `Админ отказал: ${brief(row)}.` + (reason ? `\nПричина: ${reason}` : ''));
  return { ok: true, req: row };
}

export async function withdrawRequest(id: string, userId: string): Promise<Decision> {
  const cur = await getReq(id);
  if (!cur || cur.author_user_id !== userId) return { ok: false, code: 'not_found' };
  const t = TRANSITIONS.withdraw;
  const { data } = await admin.from(TBL)
    .update({ status: t.to, decided_by: 'author', decided_at: new Date().toISOString() })
    .eq('id', id).eq('status', t.from).select().maybeSingle();
  if (!data) return { ok: false, code: 'already', req: (await getReq(id)) ?? cur };
  const row = data as Req;
  await logAction('withdrawn', 'user', id, null, userId);
  await refreshAdminMessages(row, 'Автор отозвал');
  return { ok: true, req: row };
}

// Закрывает заявки старше 7 суток. Безопасно вызывать сколько угодно раз: переход из pending
// происходит один раз, автору и админам сообщение уходит только тогда.
export async function expireStale(): Promise<number> {
  const t = TRANSITIONS.expire;
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await admin.from(TBL)
    .update({ status: t.to, decided_by: 'system', decided_at: new Date().toISOString() })
    .eq('status', t.from).lt('created_at', cutoff).select();
  for (const r of (data ?? []) as Req[]) {
    await logAction('expired', 'system', r.id);
    await refreshAdminMessages(r, 'Истекла: 7 суток без решения');
    await notifyAuthor(r, `Заявка истекла: админ не ответил за 7 суток (${brief(r)}). Отправьте её заново, если задача актуальна.`);
  }
  return (data ?? []).length;
}
