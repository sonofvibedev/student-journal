// «Журнал 2.0», этап 7: очередь пропусков без сети (headman.js). Подключается после cab-core.js.
// Пропуск получает id ('ab-…') при отметке, на сервер уходит вставкой с ON CONFLICT (id) DO NOTHING: повторная
// отправка (потерян ответ, две вкладки, повторный запуск) не даёт дублей. Очередь лежит в localStorage; отправка:
// событие online, возврат на вкладку, запуск страницы, сразу после отметки. Работает в браузере (window.OQ) и в Node (тест).
(function (root) {
  'use strict';
  const KEY = 'j2.oq.v1';
  const store = () => { try { return root.localStorage || null; } catch (_) { return null; } };
  const read = () => { const s = store(); try { const a = JSON.parse((s && s.getItem(KEY)) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
  const write = (a) => { const s = store(); if (s) s.setItem(KEY, JSON.stringify(a)); };
  const uuid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
  const norm = (s) => String(s || '').trim().toLowerCase();

  const OQ = {};
  OQ.newId = () => 'ab-' + uuid().replace(/-/g, '');

  // Нет связи: браузер сам говорит «офлайн» или запрос не дошёл (supabase-js: «Failed to fetch», Safari: «Load failed»)
  OQ.isNetError = (e) => {
    if (root.navigator && root.navigator.onLine === false) return true;
    if (e && String(e.code) === '57014') return true;           // statement timeout: сервер не успел, повтор уместен
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|bad gateway|gateway time|service unavailable|too many requests|connection (reset|closed)/i.test(String((e && e.message) || e || ''));
  };
  // Повтор бессмысленен: журнал закрыт, нет прав, студента убрали из группы
  OQ.isPermanent = (e) => !!e && ['42501', '23503', '23502', '22P02'].includes(String(e.code));

  // ---- массовое внесение: пачки, повтор с растущей паузой, правка и удаление по id ----
  OQ.CHUNK = 40;                          // записей в одном запросе (28 студентов × 4 пары = 3 запроса, а не один на 112 строк)
  OQ.DELAYS = [500, 1500, 4000];          // паузы перед повторами при обрыве, мс; пусто — без повторов
  OQ.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  OQ.chunk = (arr, n) => { const out = [], k = Math.max(1, n || OQ.CHUNK); for (let i = 0; i < arr.length; i += k) out.push(arr.slice(i, i + k)); return out; };
  // Повторяет fn на сетевой ошибке. Браузер говорит «офлайн» — не ждём, сразу отдаём ошибку (отметки уйдут в очередь).
  OQ.retry = async (fn, o) => {
    const delays = (o && o.delays) || OQ.DELAYS, sleep = (o && o.sleep) || OQ.sleep;
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (!OQ.isNetError(e) || i >= delays.length || (root.navigator && root.navigator.onLine === false)) throw e;
        await sleep(delays[i]);
      }
    }
  };
  const call = (mk, o) => OQ.retry(async () => { const r = await mk(); if (r.error) throw r.error; return r; }, o);
  // Вставка пачками. Повтор той же пачки безопасен: id у строк уже есть, ON CONFLICT (id) DO NOTHING.
  // Возвращает { sent, left, err }: left — то, что не ушло (неудавшаяся пачка и все после неё), err — причина.
  OQ.sendRows = async (sb, rows, o) => {
    const out = { sent: 0, left: rows.slice(), err: null };
    for (const part of OQ.chunk(rows, o && o.size)) {
      try { await call(() => sb.from('absences').upsert(part, { onConflict: 'id', ignoreDuplicates: true }), o); }
      catch (e) { out.err = e; return out; }
      out.sent += part.length; out.left = out.left.slice(part.length);
      if (o && o.onProgress) o.onProgress(part.length);
    }
    return out;
  };
  // Правка (patch) или удаление (patch = null) записей по id пачками. { done, left, err }: done — реально затронуто, left — id, до которых не дошли.
  OQ.mutateIds = async (sb, ids, patch, o) => {
    const out = { done: 0, left: ids.slice(), err: null };
    for (const part of OQ.chunk(ids, o && o.size)) {
      try {
        const r = await call(() => (patch ? sb.from('absences').update(patch) : sb.from('absences').delete()).in('id', part).select('id'), o);
        out.done += (r.data || []).length;
      } catch (e) { out.err = e; return out; }
      out.left = out.left.slice(part.length);
      if (o && o.onProgress) o.onProgress(part.length);
    }
    return out;
  };

  // Очередь пользователя: [{ id, uid, group_id, student_id, date, subject, hours, lesson_kind, at }]
  OQ.list = (uid) => read().filter((x) => x.uid === uid);
  OQ.count = (uid) => OQ.list(uid).length;
  OQ.add = (uid, rows) => {
    const have = new Set(read().map((x) => x.id));
    const add = rows.filter((r) => !have.has(r.id)).map((r) => ({ ...r, uid, at: r.at || new Date().toISOString() }));
    if (add.length) write(read().concat(add));
    return add.length;
  };
  const drop = (ids) => { const s = new Set(ids); write(read().filter((x) => !s.has(x.id))); };

  // Уже внесённое в очереди по предмету и дню (для блокировки кнопки «был» в журнале): Map student_id → часы
  OQ.pending = (uid, gid, date, subject) => {
    const m = new Map();
    OQ.list(uid).forEach((x) => { if (x.group_id === gid && x.date === date && norm(x.subject) === norm(subject)) m.set(x.student_id, x.hours); });
    return m;
  };

  let busy = null;
  // Отправить очередь: { sent, dropped, left, net }. sb — клиент Supabase. Одна отправка за раз.
  OQ.flush = (sb, uid) => busy || (busy = (async () => {
    const out = { sent: 0, dropped: 0, left: 0, net: false };
    try {
      for (;;) {
        const q = OQ.list(uid);
        if (!q.length) break;
        const batch = q.slice(0, OQ.CHUNK);
        // как при обычном сохранении: то же самое, внесённое кем-то ещё, второй раз не вносим
        const have = [];                      // уже внесённое: предмет, вид занятия и номер пары (пусто = подходит любое)
        const keys = [...new Set(batch.map((x) => x.group_id + '|' + x.date))];
        for (const k of keys) {
          const [g, d] = k.split('|');
          const r = await call(() => sb.from('absences').select('student_id, subject, lesson_kind, pair_no').eq('group_id', g).eq('date', d));
          r.data.forEach((a) => have.push({ ...a, g, d }));
        }
        const same = (x, a) => a.g === x.group_id && a.d === x.date && a.student_id === x.student_id && norm(a.subject) === norm(x.subject)
          && (a.lesson_kind == null || x.lesson_kind == null || a.lesson_kind === x.lesson_kind) && (a.pair_no == null || x.pair_no == null || a.pair_no === x.pair_no);
        const fresh = batch.filter((x) => !have.some((a) => same(x, a)));
        const dup = batch.length - fresh.length;
        if (fresh.length) {
          const rows = fresh.map(({ uid: _u, at, ...r }) => ({ is_excused: false, ...r, created_at: at }));   // уважительная отметка (причина и срок документа) идёт в самой записи
          await call(() => sb.from('absences').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }));
        }
        drop(batch.map((x) => x.id));
        out.sent += fresh.length; out.dropped += dup;
      }
    } catch (e) {
      if (OQ.isNetError(e)) out.net = true;
      else if (OQ.isPermanent(e)) {   // вся пачка не примется никогда: убираем её, пользователю скажем сколько
        const q = OQ.list(uid); const n = Math.min(OQ.CHUNK, q.length); drop(q.slice(0, n).map((x) => x.id)); out.dropped += n;
        out.error = e.code;
      } else out.error = e.code || 'error';
    }
    out.left = OQ.count(uid);
    return out;
  })().finally(() => { busy = null; }));

  root.OQ = OQ;
  if (typeof module !== 'undefined' && module.exports) module.exports = OQ;
})(typeof window !== 'undefined' ? window : globalThis);
