// Подделка серверной части чата 2.1 п.12 в памяти: те же правила, что в миграции 20261122110000_journal21_chat_devices.sql
// (устройства, эпохи, обёртки, chat_post) + chat_threads_my / chat_thread_open / chat_mark_read этапа 4.
// Общая для tests/unit/chat-crypto.mjs (как sb) и tests/e2e/chat-mock.mjs (как маршрут Playwright).
// Настоящую SQL-логику проверяет tests/db/chat-devices-pglite.mjs.
const B64 = /^[A-Za-z0-9_-]+$/;
const err = (message) => ({ data: null, error: { message } });
let seq = 0;
const uuid = () => { const h = (++seq).toString(16).padStart(12, '0'); return `00000000-0000-4000-8000-${h}`; };

export function makeChatServer({ threads = [], eligible = [], groups = {} } = {}) {
  const S = { devices: [], keys: [], messages: [], reads: [], notifications: [], threads: threads.map((t) => ({ key_epoch: null, ...t })), eligible: new Set(eligible), calls: [] };
  const thread = (uid, id) => S.threads.find((t) => t.id === id && (t.student_user_id === uid || t.teacher_user_id === uid));
  const peerOf = (t, uid) => (t.student_user_id === uid ? t.teacher_user_id : t.student_user_id);
  const dev = (id) => S.devices.find((d) => d.id === id);
  const activeOf = (uids) => S.devices.filter((d) => uids.includes(d.user_id) && !d.revoked_at);
  const stale = (t) => t.key_epoch == null
    || S.keys.some((k) => k.thread_id === t.id && k.epoch === t.key_epoch && dev(k.device_id).revoked_at)
    || [t.student_user_id, t.teacher_user_id].some((u) => !S.keys.some((k) => k.thread_id === t.id && k.epoch === t.key_epoch && dev(k.device_id).user_id === u && !dev(k.device_id).revoked_at));
  const myDev = (uid, id) => { const d = dev(id); if (!d || d.user_id !== uid) throw new Error('forbidden'); if (d.revoked_at) throw new Error('device_revoked'); return d; };
  const okWrap = (w) => w && /^[A-Za-z0-9_-]{16}$/.test(w.iv || '') && /^[A-Za-z0-9_-]{64}$/.test(w.ct || '');

  const R = {
    chat_device_register(uid, { p_public_jwk: j }) {
      if (!S.eligible.has(uid)) throw new Error('forbidden');
      if (!j || 'd' in j || j.kty !== 'EC' || j.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(j.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(j.y || '')) throw new Error('bad_key');
      const same = S.devices.find((d) => d.public_jwk.x === j.x && d.public_jwk.y === j.y);
      if (same) { if (same.user_id !== uid) throw new Error('bad_key'); return { device_id: same.id, revoked: !!same.revoked_at }; }
      if (activeOf([uid]).length >= 10) throw new Error('too_many_devices');
      const d = { id: uuid(), user_id: uid, public_jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, created_at: Date.now(), revoked_at: null };
      S.devices.push(d);
      return { device_id: d.id, revoked: false };
    },
    chat_device_reset(uid, { p_device }) {
      myDev(uid, p_device);
      let n = 0;
      for (const d of S.devices) if (d.user_id === uid && d.id !== p_device && !d.revoked_at) { d.revoked_at = Date.now(); n++; }
      return n;
    },
    chat_thread_state(uid, { p_thread, p_device }) {
      const t = thread(uid, p_thread); if (!t) throw new Error('forbidden');
      myDev(uid, p_device);
      const peer = peerOf(t, uid), mine = S.keys.filter((k) => k.thread_id === t.id);
      return structuredClone({
        me: uid, peer, epoch: t.key_epoch, stale: stale(t),
        devices: S.devices.filter((d) => [uid, peer].includes(d.user_id) && (!d.revoked_at || mine.some((k) => k.device_id === d.id || k.wrapper_device_id === d.id)))
          .map((d) => ({ id: d.id, user_id: d.user_id, public_jwk: d.public_jwk, revoked: !!d.revoked_at, epochs: mine.filter((k) => k.device_id === d.id).map((k) => k.epoch).sort((a, b) => a - b) })),
        wraps: mine.filter((k) => k.device_id === p_device).map((k) => ({ epoch: k.epoch, wrapper: k.wrapper_device_id, iv: k.iv, ct: k.ct })),
      });
    },
    chat_epoch_create(uid, { p_thread, p_device, p_epoch, p_wraps }) {
      const t = thread(uid, p_thread); if (!t) throw new Error('forbidden');
      myDev(uid, p_device);
      if (p_epoch !== (t.key_epoch || 0) + 1 || !stale(t)) throw new Error('epoch_conflict');
      const peer = peerOf(t, uid);
      if (!activeOf([peer]).length) throw new Error('no_peer_device');
      if (!Array.isArray(p_wraps) || !p_wraps.length || p_wraps.length > 40 || !p_wraps.every(okWrap)) throw new Error('bad_message');
      const want = activeOf([uid, peer]).map((d) => d.id).sort(), got = p_wraps.map((w) => w.device_id).sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error('devices_changed');
      for (const w of p_wraps) S.keys.push({ thread_id: t.id, epoch: p_epoch, device_id: w.device_id, wrapper_device_id: p_device, iv: w.iv, ct: w.ct });
      t.key_epoch = p_epoch;
      return p_epoch;
    },
    chat_wraps_add(uid, { p_thread, p_device, p_wraps }) {
      const t = thread(uid, p_thread); if (!t) throw new Error('forbidden');
      myDev(uid, p_device);
      if (!Array.isArray(p_wraps) || !p_wraps.length || p_wraps.length > 200 || !p_wraps.every(okWrap)) throw new Error('bad_message');
      for (const w of p_wraps) {
        const d = dev(w.device_id);
        if (w.device_id === p_device || !d || d.user_id !== uid || d.revoked_at
            || !S.keys.some((k) => k.thread_id === t.id && k.epoch === w.epoch && k.device_id === p_device)) throw new Error('forbidden');
      }
      let n = 0;
      for (const w of p_wraps) {
        if (S.keys.some((k) => k.thread_id === t.id && k.epoch === w.epoch && k.device_id === w.device_id)) continue;
        S.keys.push({ thread_id: t.id, epoch: w.epoch, device_id: w.device_id, wrapper_device_id: p_device, iv: w.iv, ct: w.ct }); n++;
      }
      return n;
    },
    chat_post(uid, { p_thread, p_device, p_epoch, p_iv, p_ciphertext }) {
      const t = thread(uid, p_thread); if (!t) throw new Error('forbidden');
      if (t.closed) throw new Error('group_closed');
      myDev(uid, p_device);
      if (String(p_ciphertext).length > 10923) throw new Error('too_long');
      if (!/^[A-Za-z0-9_-]{16}$/.test(p_iv || '') || !B64.test(p_ciphertext || '') || p_ciphertext.length < 22) throw new Error('bad_message');
      if (p_epoch !== t.key_epoch || stale(t) || !S.keys.some((k) => k.thread_id === t.id && k.epoch === p_epoch && k.device_id === p_device)) throw new Error('key_changed');
      const m = { id: uuid(), thread_id: t.id, sender_id: uid, sender_key_version: null, recipient_key_version: null, key_epoch: p_epoch, sender_device: p_device, iv: p_iv, ciphertext: p_ciphertext, created_at: new Date(Date.now() + S.messages.length).toISOString() };
      S.messages.push(m);
      S.notifications.push({ user_id: peerOf(t, uid), kind: 'chat', title: 'Новое сообщение в чате', ref: { thread_id: t.id } });
      return m.id;
    },
    chat_threads_my(uid) {
      return S.threads.filter((t) => t.student_user_id === uid || t.teacher_user_id === uid).map((t) => {
        const st = t.student_user_id === uid, last = (S.reads.find((r) => r.thread_id === t.id && r.user_id === uid) || {}).at || '';
        return { thread_id: t.id, group_id: t.group_id, group_name: groups[t.group_id] || '24ДММ-2', peer_user_id: peerOf(t, uid),
          peer_name: st ? (t.kind === 'lecture' ? 'Преподаватель лекций' : 'Преподаватель ПЗ') : 'Староста ' + (groups[t.group_id] || '24ДММ-2'),
          peer_role: st ? 'teacher_' + t.kind : 'headman', kind: t.kind, last_message_at: null,
          unread: S.messages.filter((m) => m.thread_id === t.id && m.sender_id !== uid && m.created_at > last).length };
      });
    },
    chat_thread_open(uid, { p_group, p_teacher }) {
      const t = S.threads.find((x) => x.group_id === p_group && x.student_user_id === uid && x.teacher_user_id === p_teacher);
      if (!t) throw new Error('forbidden');
      return t.id;
    },
    chat_mark_read(uid, { p_thread }) {
      if (!thread(uid, p_thread)) throw new Error('forbidden');
      S.reads = S.reads.filter((r) => !(r.thread_id === p_thread && r.user_id === uid));
      S.reads.push({ thread_id: p_thread, user_id: uid, at: new Date(Date.now() + 1e6).toISOString() });
      return null;
    },
  };

  // Вызов RPC от имени uid → { data, error } как у supabase-js
  function call(uid, name, args) {
    S.calls.push({ uid, name, args: structuredClone(args || {}) });
    if (!R[name]) return err('unknown_rpc');
    try { return { data: R[name](uid, args || {}), error: null }; } catch (e) { return err(e.message); }
  }
  // chat_messages участника (RLS: только свой тред)
  const messages = (uid, threadId) => (thread(uid, threadId) ? structuredClone(S.messages.filter((m) => m.thread_id === threadId)) : []);
  // Клиент Supabase для Node: rpc + from('chat_messages') (только то, что нужно тесту)
  const sbFor = (uid) => ({ rpc: async (name, args) => call(uid, name, args) });
  return { S, call, messages, sbFor };
}
