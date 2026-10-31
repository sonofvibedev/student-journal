// Telegram-бот для внесения домашки и дедлайнов. Вебхук: Telegram → эта функция.
//
// Защита:
//   1. секретный заголовок X-Telegram-Bot-Api-Secret-Token (секрет TG_WEBHOOK_SECRET) —
//      без него функция отвечает 403 (verify_jwt у неё выключен: Telegram JWT не шлёт);
//   2. действовать может только тот, чей telegram_id привязан к аккаунту (tg_links)
//      и у чьего профиля стоит profiles.can_post_tasks (проверяется на каждое действие);
//   3. не больше 20 записей в час на пользователя (tg_task_log);
//   4. обычный пользователь правит и удаляет только свои записи, сделанные ботом, в течение
//      суток; админ (TG_ADMIN_IDS) — любые.
//
// Где живут задачи: в data.json в GitHub (его читают приложение и send-reminders). Бот правит
// его через GitHub Contents API токеном GITHUB_TOKEN: читает свежую версию, меняет, пишет с sha;
// при 409/422 (кто-то успел раньше) повторяет, до трёх попыток.
// Состояние диалога лежит в tg_dialog_state (функция сама ничего не помнит), срок — 30 минут.
// Токены и тексты задач в логи функции не пишутся.
import { Buffer } from 'node:buffer';
import { admin, sha256hex } from '../_shared/common.ts';
import {
  addDaysYmd, buildRecord, canModify, checkSecret, cleanText, commitMessage, dialogFresh, dowShort,
  fallbackDates, fmtDm, fmtDmy, isValidYmd, linkCodeState, looksLikeCode, minskYmd, nextLessonDates,
  normalizeCode, parseDmy, parseSchedule, rateAllowed,
  type Kind, type TaskRecord,
} from '../_shared/tgbot.ts';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const WEBHOOK_SECRET = Deno.env.get('TG_WEBHOOK_SECRET');
const GH_TOKEN = Deno.env.get('GITHUB_TOKEN');
const GH_REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';
const GH_BRANCH = Deno.env.get('GITHUB_BRANCH') ?? 'main';
const SITE_URL = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');
const ADMIN_IDS = new Set((Deno.env.get('TG_ADMIN_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// deno-lint-ignore no-explicit-any
type Any = any;
type Button = [string, string];                       // [подпись, callback_data]
type Payload = {
  kind?: Kind; subjects?: string[]; subject?: string; dueDate?: string;
  type?: string; text?: string; editId?: string;
};
type Me = { userId: string; studentId: string; isAdmin: boolean };

const listKey = (k: Kind) => (k === 'homework' ? 'homework' : 'deadlines');
const KIND_LABEL: Record<string, string> = { homework: 'Домашка', deadline: 'Дедлайн' };

// ---------- Telegram ----------
async function tg(method: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) console.error('telegram', method, res.status);
  } catch (_) { console.error('telegram', method, 'network'); }
}

const keyboard = (rows: Button[][]) => ({
  inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))),
});
const say = (chat: number, text: string, rows?: Button[][]) =>
  tg('sendMessage', { chat_id: chat, text, ...(rows ? { reply_markup: keyboard(rows) } : {}) });

const MENU: Button[][] = [[['Домашка', 'k:homework'], ['Дедлайн', 'k:deadline']]];
const STALE = 'Диалог устарел. Начните заново: /start';

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
  const isAdmin = ADMIN_IDS.has(String(tid));
  return { userId: link.user_id, studentId: p.student_id, isAdmin, canPost: p.can_post_tasks === true || isAdmin };
}

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
  const me = await getMe(tid);
  return say(chat, 'Аккаунт привязан.' + (me?.canPost
    ? ' Чтобы добавить задачу, нажмите /start.'
    : ' Но права вносить задачи у вас пока нет — попросите администратора выдать их.'));
}

// ---------- Данные: сайт и GitHub ----------
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

const ghUrl = `https://api.github.com/repos/${GH_REPO}/contents/data.json`;
const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'journal-24dmm2-bot', 'X-GitHub-Api-Version': '2022-11-28',
});

async function ghRead(): Promise<{ data: Any; sha: string }> {
  if (!GH_TOKEN) throw new Error('github_not_configured');
  const res = await fetch(`${ghUrl}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`github_read_${res.status}`);
  const j = await res.json();
  const text = Buffer.from(String(j.content ?? ''), 'base64').toString('utf8').replace(/^﻿/, '');
  return { data: JSON.parse(text), sha: j.sha };
}

// Прочитать свежий data.json → изменить → записать с sha. mutate вернёт null, если менять нечего.
// Формат записи тот же, что у админки (JSON.stringify(…, null, 2), без личной части).
async function updateData<T>(mutate: (data: Any) => { result: T; message: string } | null): Promise<T | null> {
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

function findRec(data: Any, id: string) {
  for (const key of ['homework', 'deadlines'] as const) {
    const list: TaskRecord[] = Array.isArray(data[key]) ? data[key] : [];
    const i = list.findIndex((r) => r && r.id === id);
    if (i >= 0) return { key, list, i, rec: list[i] };
  }
  return null;
}
const kindOf = (rec: TaskRecord): Kind => (String(rec.id).startsWith('hw-') ? 'homework' : 'deadline');

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

function previewRows(p: Payload): Button[][] {
  const rows: Button[][] = [[['Сохранить', 'p:save']]];
  if (p.kind === 'homework') rows.push([[`Тип: ${p.type} (сменить)`, 'p:type']]);
  rows.push([['Изменить текст', 'p:edit'], ['Отмена', 'p:cancel']]);
  return rows;
}
const previewText = (p: Payload) =>
  `Проверьте:\n${KIND_LABEL[p.kind!]}${p.kind === 'homework' ? ` (${p.type})` : ''}\n` +
  `Предмет: ${p.subject}\nСрок: ${dowShort(p.dueDate!)} ${fmtDmy(p.dueDate!)}\nТекст: ${p.text}`;

async function save(tid: number, chat: number, me: Me) {
  // Забираем состояние атомарно: двойное нажатие «Сохранить» второй записи не даст
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
    return say(chat, 'Лимит — 20 записей в час. Попробуйте позже.', previewRows(p));
  }

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
    console.log('saved', p.kind, rec!.id, 'by', me.studentId);
    return say(chat, 'Сохранено. В приложении запись появится через 1–2 минуты, когда обновится сайт.\n/start — добавить ещё, /мои — мои записи.');
  } catch (e) {
    console.error('save failed', e instanceof Error ? e.message : 'unknown');
    await restore();
    return say(chat, 'Не удалось сохранить. Нажмите «Сохранить» ещё раз чуть позже.', previewRows(p));
  }
}

// ---------- /мои ----------
async function showMine(chat: number, me: Me) {
  let data: Any;
  try { data = (await ghRead()).data; } catch (_) { return say(chat, 'Не удалось получить данные. Попробуйте позже.'); }
  const all: TaskRecord[] = [...(data.homework ?? []), ...(data.deadlines ?? [])].filter((r) => r && r.id);
  const mine = all
    .filter((r) => me.isAdmin || (r.source === 'bot' && r.author === me.studentId))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, 5);
  if (!mine.length) return say(chat, 'Записей пока нет.');
  await say(chat, me.isAdmin ? 'Последние записи (вы админ — доступны любые):' : 'Ваши последние записи. Удалять и править можно в течение суток после создания:');
  for (const r of mine) {
    const text = String(r.text ?? '').replace(/\s+/g, ' ');
    const line = `${KIND_LABEL[kindOf(r)]} · ${r.subject} · до ${fmtDm(String(r.dueDate))}\n${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`;
    await say(chat, line, canModify(r, me, Date.now()) ? [[['Изменить текст', `e:${r.id}`], ['Удалить', `x:${r.id}`]]] : undefined);
  }
}

async function deleteRec(tid: number, chat: number, me: Me, id: string) {
  try {
    const gone = await updateData((data) => {
      const f = findRec(data, id);
      if (!f || !canModify(f.rec, me, Date.now())) return null;
      f.list.splice(f.i, 1);
      return { result: f.rec, message: commitMessage('удалено', kindOf(f.rec), String(f.rec.subject), String(f.rec.dueDate)) };
    });
    if (!gone) return say(chat, 'Запись не найдена или её уже нельзя удалить (прошло больше суток).');
    await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: 'delete', record_id: id });
    await admin.from('tg_task_log').update({ deleted_at: new Date().toISOString() }).eq('record_id', id).in('kind', ['homework', 'deadline']);
    console.log('deleted', id, 'by', me.studentId);
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
      if (!f || !canModify(f.rec, me, Date.now())) return null;
      f.rec.text = text;
      f.rec.editedAt = new Date().toISOString();
      return { result: f.rec, message: commitMessage('изменено', kindOf(f.rec), String(f.rec.subject), String(f.rec.dueDate)) };
    });
    if (!done) return say(chat, 'Запись не найдена или её уже нельзя править (прошло больше суток).');
    await admin.from('tg_task_log').insert({ user_id: me.userId, telegram_id: tid, kind: 'edit', record_id: id });
    console.log('edited', id, 'by', me.studentId);
    return say(chat, 'Текст изменён. В приложении обновится через 1–2 минуты.');
  } catch (e) {
    console.error('edit failed', e instanceof Error ? e.message : 'unknown');
    return say(chat, 'Не удалось изменить. Попробуйте позже.');
  }
}

// ---------- Сообщения ----------
async function onMessage(msg: Any) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const tid: number = msg.from.id, chat: number = msg.chat.id;
  const text = String(msg.text ?? '').trim();
  const cmdM = /^\/([^\s@]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text);
  const cmd = cmdM ? cmdM[1].toLowerCase() : '';
  const arg = (cmdM?.[2] ?? '').trim();

  const me = await getMe(tid);
  if (!me) {
    if (cmd === 'start' && looksLikeCode(arg)) return tryLink(tid, chat, arg);
    if (!cmd && looksLikeCode(text)) return tryLink(tid, chat, text);
    return say(chat, HOW_TO_LINK);
  }
  if (cmd === 'start' && looksLikeCode(arg)) return tryLink(tid, chat, arg);   // перепривязка
  if (!me.canPost) return say(chat, 'У вас нет права вносить задачи. Попросите администратора выдать его.');

  if (cmd === 'start' || cmd === 'new') {
    await clearState(tid);
    // Заодно убираем устаревший мусор
    await admin.from('tg_dialog_state').delete().lt('updated_at', new Date(Date.now() - 86_400_000).toISOString());
    await admin.from('tg_task_log').delete().eq('kind', 'link_fail').lt('created_at', new Date(Date.now() - 86_400_000).toISOString());
    return say(chat, 'Что добавить?', MENU);
  }
  if (cmd === 'cancel' || cmd === 'отмена') { await clearState(tid); return say(chat, 'Отменено. /start — начать заново.'); }
  if (cmd === 'my' || cmd === 'мои') return showMine(chat, me);
  if (cmd) return say(chat, 'Команды: /start — добавить задачу, /мои — мои записи, /отмена.');

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
    return say(chat, previewText(next), previewRows(next));
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
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  const tid: number = cb.from.id;
  const me = await getMe(tid);
  if (!me) return say(chat, HOW_TO_LINK);
  if (!me.canPost) return say(chat, 'У вас нет права вносить задачи. Попросите администратора выдать его.');
  // Нажатая кнопка отработала: убираем клавиатуру, чтобы по ней не нажимали второй раз
  await tg('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });

  const data = String(cb.data ?? '');
  const [op, ...rest] = data.split(':');
  const val = rest.join(':');

  if (op === 'k' && (val === 'homework' || val === 'deadline')) return startDialog(tid, chat, val);
  if (op === 'n') return say(chat, 'Отменено.');
  if (op === 'x' && /^(hw|dl)-\d+$/.test(val)) return say(chat, 'Удалить эту запись?', [[['Да, удалить', `y:${val}`], ['Нет', 'n']]]);
  if (op === 'y' && /^(hw|dl)-\d+$/.test(val)) return deleteRec(tid, chat, me, val);
  if (op === 'e' && /^(hw|dl)-\d+$/.test(val)) {
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
      return say(chat, previewText(next), previewRows(next));
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
