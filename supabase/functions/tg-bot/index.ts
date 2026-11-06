// Telegram-бот для внесения домашки и дедлайнов. Вебхук: Telegram → эта функция.
//
// Защита:
//   1. секретный заголовок X-Telegram-Bot-Api-Secret-Token (секрет TG_WEBHOOK_SECRET) —
//      без него функция отвечает 403 (verify_jwt у неё выключен: Telegram JWT не шлёт);
//   2. действовать может только тот, чей telegram_id привязан к аккаунту (tg_links)
//      и у чьего профиля стоит profiles.can_post_tasks (проверяется на каждое действие);
//   3. не больше 20 заявок/записей в час на пользователя, не больше 5 заявок на проверке;
//   4. редактор НЕ пишет в data.json: его диалог заканчивается заявкой (tg_task_requests), которую
//      одобряет админ (telegram_id из TG_ADMIN_IDS; проверяется по from.id нажавшего). Записи админа
//      публикуются сразу. Правит и удаляет готовые записи только админ.
//
// Где живут задачи: в таблице tasks; data.json в GitHub — публичное зеркало, его пересобирает сервер (_shared/taskstore.ts).
// Состояние диалога лежит в tg_dialog_state (функция сама ничего не помнит), срок — 30 минут.
// Токены и тексты задач в логи функции не пишутся.
import { admin, sha256hex } from '../_shared/common.ts';
import {
  addDaysYmd, buildRecord, canDecide, canModify, checkSecret, cleanText, commitMessage, dialogFresh, dowShort,
  fallbackDates, findDuplicate, fmtDm, fmtDmy, isValidYmd, linkCodeState, looksLikeCode, minskYmd, nextLessonDates,
  normalizeCode, parseDmy, parseSchedule, rateAllowed, requestSummary, STATUS_RU,
  type Kind, type ReqStatus, type TaskRecord,
} from '../_shared/tgbot.ts';
import {
  ADMIN_IDS, TBL, TOKEN, approveRequest, authorName, expireStale, findRec, ghRead, kindOf, loadLists, listKey, logAction,
  notifyAdmins, refreshAdminMessages, rejectRequest, say, submitRequest, tg, updateData, withdrawRequest,
  type Any, type Button, type Decision, type Req,
} from '../_shared/tgrequests.ts';

const WEBHOOK_SECRET = Deno.env.get('TG_WEBHOOK_SECRET');
const SITE_URL = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');

type Payload = {
  kind?: Kind; subjects?: string[]; subject?: string; dueDate?: string;
  type?: string; text?: string; editId?: string; requestId?: string;
};
type Me = { userId: string; studentId: string; isAdmin: boolean };

const KIND_LABEL: Record<string, string> = { homework: 'Домашка', deadline: 'Дедлайн' };
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MENU: Button[][] = [[['Домашка', 'k:homework'], ['Дедлайн', 'k:deadline']]];
const STALE = 'Диалог устарел. Начните заново: /start';
const NO_RIGHTS = 'У вас нет права вносить задачи. Попросите администратора выдать его.';
const lazyExpire = () => expireStale().catch(() => 0);   // просроченные заявки закрываем при любом обращении

// ---------- Состояние диалога ----------
async function getState(tid: number): Promise<{ step: string; payload: Payload } | null> {
  const { data } = await admin.from('tg_dialog_state').select('step, payload, updated_at').eq('telegram_id', tid).maybeSingle();
  if (!data) return null;
  if (!dialogFresh(data.updated_at, Date.now())) { await clearState(tid); return null; }
  return { step: data.step, payload: data.payload ?? {} };
}
const setState = (tid: number, step: string, payload: Payload) =>
  admin.from('tg_dialog_state').upsert({ telegram_id: tid, step, payload, updated_at: new Date().toISOString() });
const clearState = (tid: number) => admin.from('tg_dialog_state').delete().eq('telegram_id', tid);

// ---------- Кто пишет ----------
async function getMe(tid: number): Promise<(Me & { canPost: boolean }) | null> {
  const { data: link } = await admin.from('tg_links').select('user_id').eq('telegram_id', tid).maybeSingle();
  if (!link) return null;
  const { data: p } = await admin.from('profiles').select('student_id, can_post_tasks').eq('user_id', link.user_id).maybeSingle();
  if (!p) return null;
  const isAdmin = canDecide(tid, ADMIN_IDS);
  return { userId: link.user_id, studentId: p.student_id, isAdmin, canPost: p.can_post_tasks === true || isAdmin };
}

// Что писать в data.json в поле approvedBy: student_id админа, если он привязан, иначе «admin».
// Telegram-id туда не попадает: data.json публичный.
async function approverName(tid: number): Promise<string> {
  const me = await getMe(tid);
  return me?.studentId || 'admin';
}

// Привязан, но профиля нет (студенты новых групп): бот им только шлёт уведомления, задачи через бота вносят старосты прежней группы
const NO_BOT_TASKS = 'Аккаунт привязан, уведомления включены. Задачи через бота вносят только старосты прежней группы, '
  + 'остальное — в приложении журнала.';

const HOW_TO_LINK = 'Чтобы пользоваться ботом, привяжите аккаунт: в личном кабинете журнала получите код привязки '
  + 'и пришлите его сюда (или команду /start КОД). Код действует 10 минут.';

async function tryLink(tid: number, chat: number, raw: string) {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await admin.from('tg_task_log').select('id', { count: 'exact', head: true })
    .eq('telegram_id', tid).eq('kind', 'link_fail').gte('created_at', since);
  if ((count ?? 0) >= 5) return say(chat, 'Слишком много неверных кодов. Подождите 10 минут.');

  const fail = async (text: string) => {
    await admin.from('tg_task_log').insert({ telegram_id: tid, kind: 'link_fail' });
    return say(chat, text);
  };
  const hash = await sha256hex(normalizeCode(raw));
  const { data: row } = await admin.from('tg_link_codes').select('user_id, expires_at, used_at').eq('code_hash', hash).maybeSingle();
  const state = linkCodeState(row, Date.now());
  if (state === 'none') return fail('Код не найден. Проверьте его или получите новый в личном кабинете.');
  if (state === 'used') return fail('Этот код уже использован. Получите новый в личном кабинете.');
  if (state === 'expired') return fail('Срок кода (10 минут) истёк. Получите новый в личном кабинете.');

  // Код одноразовый: забираем его атомарно
  const { data: claimed } = await admin.from('tg_link_codes')
    .update({ used_at: new Date().toISOString() }).eq('code_hash', hash).is('used_at', null).select('user_id');
  if (!claimed?.length) return fail('Этот код уже использован. Получите новый в личном кабинете.');

  // Этот Telegram мог быть привязан к другому аккаунту — привязка переезжает
  await admin.from('tg_links').delete().eq('telegram_id', tid).neq('user_id', row!.user_id);
  const { error } = await admin.from('tg_links').upsert(
    { user_id: row!.user_id, telegram_id: tid, linked_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) { console.error('link', error.code); return say(chat, 'Не удалось привязать. Получите новый код и попробуйте ещё раз.'); }
  // Привязка закрывает экран «Журнал обновился» (после сброса привязок); таблицы может ещё не быть — ошибку не смотрим
  await admin.from('tg_rebind').update({ dismissed_at: new Date().toISOString() }).eq('user_id', row!.user_id).is('dismissed_at', null);
  const me = await getMe(tid);
  const who = await whoIs(row!.user_id);
  if (!who) {
    return say(chat, 'Аккаунт привязан.' + (me?.canPost
      ? ' Чтобы добавить задачу, нажмите /start.'
      : ' Но права вносить задачи у вас пока нет — попросите администратора выдать их.'));
  }
  // Подсказку про задачи показываем только тем, кто их может вносить (профиль + право, как и раньше)
  await say(chat, `Готово, вы вошли как ${who}. Уведомления включены.` + (me?.canPost ? ' Чтобы добавить задачу, нажмите /start.' : ''));
  await tg('sendMessage', {
    chat_id: chat, text: 'Что приходит: горящие домашки, изменения расписания, оценки и пропуски. Выключить можно в профиле.',
    ...(SITE_URL.startsWith('https://') ? { reply_markup: { inline_keyboard: [[{ text: 'Настройки уведомлений', url: `${SITE_URL}/app.html#/profile/telegram` }]] } } : {}),
  });
}

// «Фамилия И., название группы» по активному членству студента; null, если не нашли (тогда ответ как раньше)
async function whoIs(userId: string): Promise<string | null> {
  const { data: m } = await admin.from('memberships').select('student_id, group_id')
    .eq('user_id', userId).eq('status', 'active').eq('base_role', 'student').order('created_at').limit(1).maybeSingle();
  if (!m?.student_id) return null;
  const [{ data: s }, { data: g }] = await Promise.all([
    admin.from('students').select('last_name, first_name').eq('id', m.student_id).maybeSingle(),
    admin.from('groups').select('name').eq('id', m.group_id).maybeSingle(),
  ]);
  if (!s?.last_name || !g?.name) return null;
  const ini = String(s.first_name ?? '').trim().charAt(0);
  return `${String(s.last_name).trim()}${ini ? ` ${ini.toUpperCase()}.` : ''}, ${g.name}`;
}

// ---------- Предметы и расписание ----------
async function siteText(file: string): Promise<string | null> {
  if (!SITE_URL) return null;
  try {
    const res = await fetch(`${SITE_URL}/${file}?t=${Date.now()}`);
    return res.ok ? await res.text() : null;
  } catch (_) { return null; }
}

async function loadSubjects(): Promise<string[]> {
  let subjects: unknown;
  const txt = await siteText('data.json');
  if (txt) { try { subjects = JSON.parse(txt.replace(/^﻿/, '')).subjects; } catch (_) { /* возьмём из GitHub */ } }
  if (!Array.isArray(subjects)) subjects = (await ghRead()).data.subjects;
  return (Array.isArray(subjects) ? subjects : []).map(String).filter(Boolean).slice(0, 30);
}

// ---------- Шаги диалога ----------
async function startDialog(tid: number, chat: number, kind: Kind) {
  let subjects: string[];
  try { subjects = await loadSubjects(); } catch (_) { return say(chat, 'Не удалось получить список предметов. Попробуйте позже.'); }
  if (!subjects.length) return say(chat, 'Список предметов пуст.');
  await setState(tid, 'subject', { kind, subjects });
  return say(chat, `${KIND_LABEL[kind]}: выберите предмет.`, subjects.map((s, i): Button[] => [[s, `s:${i}`]]));
}

async function askDate(tid: number, chat: number, p: Payload) {
  const today = minskYmd(Date.now());
  const sched = parseSchedule((await siteText('schedule.js')) ?? '');
  const lessons = sched ? nextLessonDates(sched, p.subject!, today, 4) : [];
  const dates = lessons.length ? lessons : fallbackDates(today);
  const names = lessons.length ? null : ['Сегодня', 'Завтра', 'Через неделю'];
  const btns: Button[] = dates.map((d, i) => [`${names ? names[i] + ' ' : dowShort(d) + ' '}${fmtDm(d)}`, `d:${d}`]);
  const rows: Button[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([['Другая дата', 'd:x']]);
  await setState(tid, 'date', p);
  const why = lessons.length ? 'ближайшие занятия по предмету' : 'расписание недоступно, предлагаю простые варианты';
  return say(chat, `${p.subject}\nДо какого числа? (${why})`, rows);
}

const askText = (chat: number, kind: Kind) =>
  say(chat, kind === 'homework' ? 'Пришлите текст задания (до 500 символов).' : 'Пришлите, что нужно сделать (до 500 символов).');

function previewRows(p: Payload, isAdmin: boolean): Button[][] {
  const rows: Button[][] = [[[isAdmin ? 'Сохранить' : 'Отправить на проверку', 'p:save']]];
  if (p.kind === 'homework') rows.push([[`Тип: ${p.type} (сменить)`, 'p:type']]);
  rows.push([['Изменить текст', 'p:edit'], ['Отмена', 'p:cancel']]);
  return rows;
}
const previewText = (p: Payload, isAdmin: boolean) =>
  `Проверьте:\n${KIND_LABEL[p.kind!]}${p.kind === 'homework' ? ` (${p.type})` : ''}\n` +
  `Предмет: ${p.subject}\nСрок: ${dowShort(p.dueDate!)} ${fmtDmy(p.dueDate!)}\nТекст: ${p.text}` +
  (isAdmin ? '' : '\n\nЗапись попадёт в журнал после одобрения админом.');

async function save(tid: number, chat: number, me: Me) {
  // Забираем состояние атомарно: двойное нажатие второй записи/заявки не даст
  const { data: row } = await admin.from('tg_dialog_state').delete()
    .eq('telegram_id', tid).eq('step', 'preview').select('payload, updated_at').maybeSingle();
  if (!row || !dialogFresh(row.updated_at, Date.now())) return say(chat, STALE);
  const p: Payload = row.payload;
  const restore = () => setState(tid, 'preview', p);

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { data: recent } = await admin.from('tg_task_log').select('created_at')
    .eq('user_id', me.userId).in('kind', ['homework', 'deadline']).gte('created_at', since);
  if (!rateAllowed((recent ?? []).map((r) => r.created_at), Date.now())) {
    await restore();
    return say(chat, 'Лимит — 20 записей в час. Попробуйте позже.', previewRows(p, me.isAdmin));
  }
  return me.isAdmin ? saveDirect(tid, chat, me, p, restore) : sendRequest(tid, chat, me, p, restore);
}

// Админ: запись сразу в data.json
async function saveDirect(tid: number, chat: number, me: Me, p: Payload, restore: () => Promise<unknown>) {
  try {
    const rec = await updateData((data) => {
      const key = listKey(p.kind!);
      if (!Array.isArray(data[key])) data[key] = [];
      const taken = new Set<string>(data[key].map((r: TaskRecord) => r?.id));
      const r = buildRecord(p.kind!, { subject: p.subject!, type: p.type ?? 'ПЗ', text: p.text!, dueDate: p.dueDate! }, me.studentId, Date.now(), taken);
      data[key].push(r);
      return { result: r, message: commitMessage('добавлено', p.kind!, p.subject!, p.dueDate!) };
    });
    await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: p.kind, record_id: rec!.id });
    await logAction('admin_direct', `tg:${tid}`, null, rec!.id, me.userId);
    return say(chat, 'Сохранено. В приложении запись появится через 1–2 минуты, когда обновится сайт.\n/start — добавить ещё, /мои — записи.');
  } catch (e) {
    console.error('save failed', e instanceof Error ? e.message : 'unknown');
    await restore();
    return say(chat, 'Не удалось сохранить. Нажмите «Сохранить» ещё раз чуть позже.', previewRows(p, true));
  }
}

// Редактор: заявка админу
async function sendRequest(tid: number, chat: number, me: Me, p: Payload, restore: () => Promise<unknown>) {
  await lazyExpire();
  // Возможный дубль: такая запись уже в data.json или заявка на проверке с тем же предметом и датой
  let dup = '';
  try {
    const data = await loadLists();
    const { data: pending } = await admin.from(TBL).select('subject, due_date, text')
      .in('status', ['pending', 'approving']).eq('subject', p.subject!).eq('due_date', p.dueDate!);
    const found = findDuplicate(
      { subject: p.subject!, dueDate: p.dueDate!, text: p.text! },
      [...(data.homework ?? []), ...(data.deadlines ?? [])], pending ?? []);
    if (found) dup = found === 'record' ? '⚠ Возможный дубль: похожая запись уже есть в журнале' : '⚠ Возможный дубль: похожая заявка уже ждёт решения';
  } catch (_) { /* проверка дубля — подсказка, без неё заявка всё равно уходит */ }

  const r = await submitRequest(me.userId, me.studentId, {
    kind: p.kind!, subtype: p.kind === 'homework' ? (p.type ?? 'ПЗ') : null,
    subject: p.subject!, dueDate: p.dueDate!, text: p.text!,
  });
  if (!r.ok) {
    await restore();
    return say(chat, r.code === 'too_many'
      ? 'Дождитесь решения по прежним заявкам: на проверке уже 5. Посмотреть: /мои'
      : 'Не удалось отправить заявку. Нажмите кнопку ещё раз чуть позже.', previewRows(p, false));
  }
  await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: p.kind, record_id: r.req.id });
  await notifyAdmins(r.req, await authorName(me.studentId), dup);
  return say(chat, 'Отправлено админу на проверку. Решение придёт сюда, статус — в /мои.');
}

// ---------- /мои ----------
const ruStatus = (s: string) => STATUS_RU[s as ReqStatus] ?? s;
const dm = (iso: string) => fmtDm(String(iso).slice(0, 10));

async function showMine(chat: number, me: Me) {
  await lazyExpire();
  if (me.isAdmin) {
    // Админ: заявки, ждущие решения, и последние записи в журнале
    const { data: pend } = await admin.from(TBL).select('*').eq('status', 'pending').order('created_at').limit(5);
    for (const r of (pend ?? []) as Req[]) {
      await say(chat, requestSummary(r, await authorName(r.author_student_id)),
        [[['Одобрить', `ap:${r.id}`], ['Отклонить', `rj:${r.id}`]], [['Отклонить с причиной', `rr:${r.id}`]]]);
    }
    let data: Any;
    try { data = await loadLists(); } catch (_) { return say(chat, 'Не удалось получить записи. Попробуйте позже.'); }
    const all: TaskRecord[] = [...(data.homework ?? []), ...(data.deadlines ?? [])].filter((r) => r && r.id);
    const last = all.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, 5);
    if (!last.length && !(pend ?? []).length) return say(chat, 'Записей и заявок пока нет.');
    if (last.length) await say(chat, 'Последние записи в журнале:');
    for (const r of last) {
      const text = String(r.text ?? '').replace(/\s+/g, ' ');
      await say(chat, `${KIND_LABEL[kindOf(r)]} · ${r.subject} · до ${fmtDm(String(r.dueDate))}\n${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`,
        [[['Изменить текст', `e:${r.id}`], ['Удалить', `x:${r.id}`]]]);
    }
    return;
  }
  // Редактор: свои заявки со статусом
  const { data: mine } = await admin.from(TBL).select('*').eq('author_user_id', me.userId)
    .order('created_at', { ascending: false }).limit(5);
  if (!mine?.length) return say(chat, 'Заявок пока нет. /start — добавить задачу.');
  await say(chat, 'Ваши последние заявки. После одобрения запись правит только админ.');
  for (const r of mine as Req[]) {
    const text = r.text.replace(/\s+/g, ' ');
    const line = `${KIND_LABEL[r.kind]} · ${r.subject} · до ${dm(r.due_date)}\n${text.slice(0, 120)}${text.length > 120 ? '…' : ''}\n`
      + `Статус: ${ruStatus(r.status)}${r.status === 'rejected' && r.reject_reason ? ` (${r.reject_reason})` : ''}`;
    await say(chat, line, r.status === 'pending' ? [[['Отозвать', `wd:${r.id}`]]] : undefined);
  }
}

async function deleteRec(tid: number, chat: number, me: Me, id: string) {
  try {
    const gone = await updateData((data) => {
      const f = findRec(data, id);
      if (!f || !canModify(f.rec, me)) return null;
      f.list.splice(f.i, 1);
      return { result: f.rec, message: commitMessage('удалено', kindOf(f.rec), String(f.rec.subject), String(f.rec.dueDate)) };
    });
    if (!gone) return say(chat, 'Запись не найдена или у вас нет права её удалить.');
    await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: 'delete', record_id: id });
    await admin.from('tg_task_log').update({ deleted_at: new Date().toISOString() }).eq('record_id', id).in('kind', ['homework', 'deadline']);
    return say(chat, 'Удалено. Из приложения запись пропадёт через 1–2 минуты.');
  } catch (e) {
    console.error('delete failed', e instanceof Error ? e.message : 'unknown');
    return say(chat, 'Не удалось удалить. Попробуйте позже.');
  }
}

async function editText(tid: number, chat: number, me: Me, id: string, text: string) {
  try {
    const done = await updateData((data) => {
      const f = findRec(data, id);
      if (!f || !canModify(f.rec, me)) return null;
      f.rec.text = text;
      f.rec.editedAt = new Date().toISOString();
      return { result: f.rec, message: commitMessage('изменено', kindOf(f.rec), String(f.rec.subject), String(f.rec.dueDate)) };
    });
    if (!done) return say(chat, 'Запись не найдена или у вас нет права её править.');
    await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: 'edit', record_id: id });
    return say(chat, 'Текст изменён. В приложении обновится через 1–2 минуты.');
  } catch (e) {
    console.error('edit failed', e instanceof Error ? e.message : 'unknown');
    return say(chat, 'Не удалось изменить. Попробуйте позже.');
  }
}

// ---------- Решения админа ----------
// Итог для всплывающей подсказки у нажавшего; сообщения заявки обновляет сама библиотека
async function reportDecision(cb: Any, chat: number, d: Decision, doneText: string) {
  let toast = doneText;
  if (!d.ok) {
    if (d.code === 'not_found') toast = 'Заявка не найдена';
    else if (d.code === 'github') toast = 'Не вышло внести, повторите';
    else {
      toast = d.req.status === 'approving' ? 'Заявка сейчас вносится, подождите' : `Уже решено: ${ruStatus(d.req.status)}`;
      if (d.req.status !== 'approving' && d.req.status !== 'pending') await refreshAdminMessages(d.req, `Уже решено: ${ruStatus(d.req.status)}`);
    }
  }
  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: toast, show_alert: false });
  // Решено (кем бы то ни было) — кнопки у этого сообщения больше не нужны
  const settled = d.ok || (d.code === 'already' && d.req.status !== 'approving');
  if (settled) {
    await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (!d.ok && d.code === 'github') {
    await say(chat, 'Не вышло внести запись в GitHub — заявка осталась на проверке. Нажмите «Одобрить» ещё раз.');
  }
}

async function onDecision(cb: Any, chat: number, op: string, id: string) {
  const tid: number = cb.from.id;
  const by = { label: `tg:${tid}`, approvedBy: await approverName(tid) };
  if (op === 'ap') return reportDecision(cb, chat, await approveRequest(id, by), 'Одобрено, внесено');
  if (op === 'rj') return reportDecision(cb, chat, await rejectRequest(id, by), 'Отклонено');
  // rr: причину админ пришлёт следующим сообщением
  const { data: req } = await admin.from(TBL).select('status').eq('id', id).maybeSingle();
  if (!req) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Заявка не найдена' });
  if (req.status !== 'pending') return tg('answerCallbackQuery', { callback_query_id: cb.id, text: `Уже решено: ${ruStatus(req.status)}` });
  await setState(tid, 'reject_reason', { requestId: id });
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  return say(chat, 'Напишите причину отказа одним сообщением (до 200 символов). /отмена — передумать.');
}

// ---------- Сообщения ----------
async function onMessage(msg: Any) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const tid: number = msg.from.id, chat: number = msg.chat.id;
  const text = String(msg.text ?? '').trim();
  const cmdM = /^\/([^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text);
  const cmd = cmdM ? cmdM[1].toLowerCase() : '';
  const arg = (cmdM?.[2] ?? '').trim();
  const isCancel = cmd === 'cancel' || cmd === 'отмена';

  // Админ вводит причину отказа (привязка аккаунта для этого не нужна)
  if (canDecide(tid, ADMIN_IDS)) {
    const st = await getState(tid);
    if (st?.step === 'reject_reason') {
      if (isCancel) { await clearState(tid); return say(chat, 'Отменено.'); }
      if (!cmd) {
        const reason = cleanText(text, 200);
        if (!reason) return say(chat, 'Пришлите причину текстом.');
        await clearState(tid);
        const d = await rejectRequest(st.payload.requestId!, { label: `tg:${tid}`, approvedBy: await approverName(tid) }, reason);
        return say(chat, d.ok ? 'Отклонено, автору отправлена причина.'
          : d.code === 'already' ? `Уже решено: ${ruStatus(d.req.status)}` : 'Заявка не найдена.');
      }
    }
  }

  const me = await getMe(tid);
  if (!me) {
    if (cmd === 'start' && looksLikeCode(arg)) return tryLink(tid, chat, arg);
    if (!cmd && looksLikeCode(text)) return tryLink(tid, chat, text);
    const { data: link } = await admin.from('tg_links').select('user_id').eq('telegram_id', tid).maybeSingle();
    return say(chat, link ? NO_BOT_TASKS : HOW_TO_LINK);
  }
  if (cmd === 'start' && looksLikeCode(arg)) return tryLink(tid, chat, arg);   // перепривязка
  if (!me.canPost) return say(chat, NO_RIGHTS);

  if (cmd === 'start' || cmd === 'new') {
    await clearState(tid);
    // Заодно убираем устаревший мусор
    await admin.from('tg_dialog_state').delete().lt('updated_at', new Date(Date.now() - 86_400_000).toISOString());
    await admin.from('tg_task_log').delete().eq('kind', 'link_fail').lt('created_at', new Date(Date.now() - 86_400_000).toISOString());
    await lazyExpire();
    return say(chat, 'Что добавить?', MENU);
  }
  if (isCancel) { await clearState(tid); return say(chat, 'Отменено. /start — начать заново.'); }
  if (cmd === 'my' || cmd === 'мои') return showMine(chat, me);
  if (cmd) return say(chat, 'Команды: /start — добавить задачу, /мои — заявки и записи, /отмена.');

  const st = await getState(tid);
  if (!st) return say(chat, 'Нажмите /start, чтобы добавить задачу.');
  const p = st.payload;

  if (st.step === 'date_input') {
    const r = parseDmy(text, minskYmd(Date.now()));
    if (!r.ok) {
      return say(chat, r.reason === 'past' ? 'Эта дата уже прошла. Введите будущую: ДД.ММ'
        : r.reason === 'far' ? 'Слишком далеко. Введите дату в пределах года: ДД.ММ'
        : 'Не понял дату. Напишите в виде ДД.ММ, например 05.11');
    }
    await setState(tid, 'text', { ...p, dueDate: r.date });
    return askText(chat, p.kind!);
  }
  if (st.step === 'text') {
    const t = cleanText(text);
    if (!t) return say(chat, 'Пришлите текст сообщением.');
    const next: Payload = { ...p, text: t, type: p.type ?? 'ПЗ' };
    await setState(tid, 'preview', next);
    return say(chat, previewText(next, me.isAdmin), previewRows(next, me.isAdmin));
  }
  if (st.step === 'edit_text') {
    const t = cleanText(text);
    if (!t) return say(chat, 'Пришлите новый текст сообщением.');
    await clearState(tid);
    return editText(tid, chat, me, p.editId!, t);
  }
  return say(chat, 'Выберите вариант кнопкой выше или нажмите /start, чтобы начать заново.');
}

// ---------- Кнопки ----------
async function onCallback(cb: Any) {
  const chat: number | undefined = cb.message?.chat?.id;
  if (!cb.from || cb.from.is_bot || cb.message?.chat?.type !== 'private' || !chat) return;
  const tid: number = cb.from.id;
  const data = String(cb.data ?? '');
  const [op, ...rest] = data.split(':');
  const val = rest.join(':');

  // Решения по заявкам: только telegram_id из TG_ADMIN_IDS (по тому, кто нажал, а не по чату)
  if (op === 'ap' || op === 'rj' || op === 'rr') {
    if (!canDecide(tid, ADMIN_IDS) || !UUID.test(val)) {
      console.log('tg-bot', 'decision_denied');   // без текстов и id
      return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет прав', show_alert: true });
    }
    return onDecision(cb, chat, op, val);
  }

  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const me = await getMe(tid);
  if (!me) return say(chat, HOW_TO_LINK);
  if (!me.canPost) return say(chat, NO_RIGHTS);
  // Нажатая кнопка отработала: убираем клавиатуру, чтобы по ней не нажимали второй раз
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });

  if (op === 'k' && (val === 'homework' || val === 'deadline')) return startDialog(tid, chat, val);
  if (op === 'n') return say(chat, 'Отменено.');
  if (op === 'wd' && UUID.test(val)) {
    const d = await withdrawRequest(val, me.userId);
    return say(chat, d.ok ? 'Заявка отозвана.'
      : d.code === 'already' ? `Отозвать уже нельзя: заявка ${ruStatus(d.req.status)}.` : 'Заявка не найдена.');
  }
  // Правка и удаление готовых записей — только админ
  if ((op === 'x' || op === 'y' || op === 'e') && /^(hw|dl)-\d+$/.test(val)) {
    if (!me.isAdmin) return say(chat, 'Править и удалять готовые записи может только админ.');
    if (op === 'x') return say(chat, 'Удалить эту запись?', [[['Да, удалить', `y:${val}`], ['Нет', 'n']]]);
    if (op === 'y') return deleteRec(tid, chat, me, val);
    await setState(tid, 'edit_text', { editId: val });
    return say(chat, 'Пришлите новый текст (до 500 символов). /отмена — передумать.');
  }

  const st = await getState(tid);
  if (!st) return say(chat, STALE);
  const p = st.payload;

  if (op === 's' && st.step === 'subject') {
    const subject = p.subjects?.[Number(val)];
    if (!subject) return say(chat, STALE);
    return askDate(tid, chat, { ...p, subject });
  }
  if (op === 'd' && st.step === 'date') {
    if (val === 'x') {
      await setState(tid, 'date_input', p);
      return say(chat, 'Введите дату: ДД.ММ, например 05.11');
    }
    if (!isValidYmd(val) || val < minskYmd(Date.now()) || val > addDaysYmd(minskYmd(Date.now()), 400)) return say(chat, STALE);
    await setState(tid, 'text', { ...p, dueDate: val });
    return askText(chat, p.kind!);
  }
  if (op === 'p' && st.step === 'preview') {
    if (val === 'save') return save(tid, chat, me);
    if (val === 'type') {
      const next = { ...p, type: p.type === 'УСР' ? 'ПЗ' : 'УСР' };
      await setState(tid, 'preview', next);
      return say(chat, previewText(next, me.isAdmin), previewRows(next, me.isAdmin));
    }
    if (val === 'edit') { await setState(tid, 'text', p); return askText(chat, p.kind!); }
    if (val === 'cancel') { await clearState(tid); return say(chat, 'Отменено. /start — начать заново.'); }
  }
  return say(chat, STALE);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!TOKEN || !WEBHOOK_SECRET) return new Response('not_configured', { status: 500 });
  if (!checkSecret(req.headers.get('x-telegram-bot-api-secret-token'), WEBHOOK_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  let update: Any;
  try { update = await req.json(); } catch (_) { return new Response('ok'); }
  try {
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message) await onMessage(update.message);
  } catch (e) {
    // Только тип ошибки: ни токенов, ни текстов задач в журнал не попадает
    console.error('tg-bot error', e instanceof Error ? e.message.slice(0, 80) : 'unknown');
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (chat?.type === 'private') await say(chat.id, 'Что-то пошло не так. Попробуйте ещё раз чуть позже.');
  }
  // Telegram повторяет запрос, если ответ не 200, — а повтор здесь не нужен
  return new Response('ok');
});
