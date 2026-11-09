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
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(String((e && e.message) || e || ''));
  };
  // Повтор бессмысленен: журнал закрыт, нет прав, студента убрали из группы
  OQ.isPermanent = (e) => !!e && ['42501', '23503', '23502', '22P02'].includes(String(e.code));

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
        const batch = q.slice(0, 100);
        // как при обычном сохранении: то же самое, внесённое кем-то ещё, второй раз не вносим
        const have = new Set();
        const keys = [...new Set(batch.map((x) => x.group_id + '|' + x.date))];
        for (const k of keys) {
          const [g, d] = k.split('|');
          const r = await sb.from('absences').select('student_id, subject').eq('group_id', g).eq('date', d);
          if (r.error) throw r.error;
          r.data.forEach((a) => have.add([g, d, a.student_id, norm(a.subject)].join('|')));
        }
        const fresh = batch.filter((x) => !have.has([x.group_id, x.date, x.student_id, norm(x.subject)].join('|')));
        const dup = batch.length - fresh.length;
        if (fresh.length) {
          const rows = fresh.map(({ uid: _u, at, ...r }) => ({ is_excused: false, ...r, created_at: at }));   // уважительная отметка (причина и срок документа) идёт в самой записи
          const r = await sb.from('absences').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
          if (r.error) throw r.error;
        }
        drop(batch.map((x) => x.id));
        out.sent += fresh.length; out.dropped += dup;
      }
    } catch (e) {
      if (OQ.isNetError(e)) out.net = true;
      else if (OQ.isPermanent(e)) {   // вся пачка не примется никогда: убираем её, пользователю скажем сколько
        const q = OQ.list(uid); const n = Math.min(100, q.length); drop(q.slice(0, n).map((x) => x.id)); out.dropped += n;
        out.error = e.code;
      } else out.error = e.code || 'error';
    }
    out.left = OQ.count(uid);
    return out;
  })().finally(() => { busy = null; }));

  root.OQ = OQ;
  if (typeof module !== 'undefined' && module.exports) module.exports = OQ;
})(typeof window !== 'undefined' ? window : globalThis);
