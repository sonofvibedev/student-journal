// Сквозное шифрование чата «староста/заместитель ↔ преподаватель», 2.1 п.12: без «пароля переписки».
// Протокол и модель угроз: docs/v21-chat-keys.md; база: миграция 20261122110000_journal21_chat_devices.sql.
// Только Web Crypto API; работает в браузере (window.ChatCrypto) и в Node 24
// (тест tests/unit/chat-crypto.mjs подставляет crypto и хранилище через init(sb, uid, { crypto, storage })).
//
// Устройство: пара ECDH P-256 создаётся сама при первом открытии чата; закрытый ключ — неизвлекаемый CryptoKey в IndexedDB,
// на сервер уходит только открытый (chat_device_register). Ключ треда — случайные 32 байта «эпохи»; в базе только обёртки:
//   KEK = HKDF-SHA256(ECDH(устройство-обёртчик, устройство-получатель), salt = '<thread>|<epoch>',
//                     info = 'journal-chat-wrap-v2|<обёртчик>|<получатель>') → AES-GCM-256,
//   iv 12 байт, additionalData = 'journal-chat-wrap-v2|<thread>|<epoch>|<обёртчик>|<получатель>'.
// Сообщение: AES-GCM ключом эпохи, iv 12 байт, additionalData = 'journal-chat-v2|<thread>|<epoch>|<sender_id>|<sender_device>'.
// Закрытые ключи наружу не отдаются; тексты сообщений и ключи никуда не пишутся (ни в console, ни в storage).
(function (root) {
  'use strict';

  const MAX_CT = 8192;                                   // байт шифртекста, как в chat_post
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const AES = { name: 'AES-GCM', length: 256 };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Состояние вошедшего пользователя (одна учётная запись на страницу); th — треды: Map(id → состояние ключей)
  const S = { sb: null, uid: null, c: null, store: null, priv: null, pub: null, dev: null, th: new Map() };

  // ----- base64url -----
  function b64u(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('bad_b64');
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const rand = (n) => S.c.getRandomValues(new Uint8Array(n));
  const fail = (code) => { throw new Error(code); };

  // ----- хранилище ключа устройства (IndexedDB; запись 'dev:<user_id>' = { device_id, priv, pub }) -----
  // Интерфейс для подмены: { get(k), set(k, v), del(k) }, все async.
  function idbStorage() {
    const open = () => new Promise((res, rej) => {
      const r = root.indexedDB.open('journal-chat', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const run = async (mode, fn) => {
      const db = await open();
      try {
        return await new Promise((res, rej) => {
          const t = db.transaction('keys', mode);
          const req = fn(t.objectStore('keys'));
          t.oncomplete = () => res(req.result);
          t.onerror = t.onabort = () => rej(t.error);
        });
      } finally { db.close(); }
    };
    return {
      get: (k) => run('readonly', (s) => s.get(k)),
      set: (k, v) => run('readwrite', (s) => s.put(v, k)),
      del: (k) => run('readwrite', (s) => s.delete(k)),
    };
  }
  // Сбой хранилища (приватный режим, запрет сайта) не ломает чат: ключ живёт в памяти до закрытия страницы
  const quiet = async (fn) => { try { return await fn(); } catch (_) { return undefined; } };

  async function rpc(name, args) {
    const { data, error } = await S.sb.rpc(name, args);
    if (error) fail(error.message || name + '_failed');
    return data;
  }

  // ----- ключи -----
  const pubOnly = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
  const okJwk = (j) => !!j && /^[A-Za-z0-9_-]{43}$/.test(j.x || '') && /^[A-Za-z0-9_-]{43}$/.test(j.y || '');
  const importPub = (jwk) => S.c.subtle.importKey('jwk', pubOnly(jwk), CURVE, false, []);
  const msgKey = (raw) => S.c.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // Ключ обёртки между моим устройством и устройством other (одинаков с обеих сторон)
  async function kek(threadId, epoch, wrapper, target, otherJwk) {
    const bits = await S.c.subtle.deriveBits({ name: 'ECDH', public: await importPub(otherJwk) }, S.priv, 256);
    const hk = await S.c.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return S.c.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(threadId + '|' + epoch), info: enc.encode(`journal-chat-wrap-v2|${wrapper}|${target}`) },
      hk, AES, false, ['encrypt', 'decrypt']);
  }
  const wrapAad = (threadId, epoch, wrapper, target) => enc.encode(`journal-chat-wrap-v2|${threadId}|${epoch}|${wrapper}|${target}`);

  async function wrap(th, epoch, raw, dev) {
    const iv = rand(12);
    const ct = await S.c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(th.id, epoch, S.dev, dev.id) },
      await kek(th.id, epoch, S.dev, dev.id, dev.pub), raw);
    return { device_id: dev.id, iv: b64u(iv), ct: b64u(ct) };
  }
  async function unwrap(th, w) {
    const from = th.devices.get(w.wrapper);
    if (!from || (from.user_id !== th.me && from.user_id !== th.peer)) return null;   // обернул не участник треда
    try {
      const iv = unb64u(w.iv);
      if (iv.length !== 12) return null;
      const raw = new Uint8Array(await S.c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(th.id, w.epoch, w.wrapper, S.dev) },
        await kek(th.id, w.epoch, w.wrapper, S.dev, from.pub), unb64u(w.ct)));
      return raw.length === 32 ? raw : null;
    } catch (_) { return null; }
  }
  const msgAad = (threadId, epoch, sender, device) => enc.encode(`journal-chat-v2|${threadId}|${epoch}|${sender}|${device}`);

  // Ответ chat_thread_state → состояние треда (ключи эпох из прошлых открытий сохраняются)
  async function absorb(threadId, st) {
    const me = String(st.me), peer = String(st.peer);
    if (me !== S.uid) fail('wrong_user');
    let th = S.th.get(threadId);
    if (!th || th.peer !== peer) th = { id: threadId, me, peer, keys: new Map(), raw: new Map(), wrappers: new Map() };
    th.epoch = st.epoch == null ? null : Number(st.epoch);
    th.devices = new Map();
    for (const d of st.devices || []) {
      const uid = String(d.user_id);
      if ((uid === me || uid === peer) && okJwk(d.public_jwk)) th.devices.set(String(d.id), { id: String(d.id), user_id: uid, pub: pubOnly(d.public_jwk), revoked: !!d.revoked, epochs: (d.epochs || []).map(Number) });
    }
    for (const w of st.wraps || []) {
      const e = Number(w.epoch);
      if (th.raw.has(e)) continue;
      const raw = await unwrap(th, { ...w, epoch: e, wrapper: String(w.wrapper) });
      if (raw) { th.raw.set(e, raw); th.keys.set(e, await msgKey(raw)); th.wrappers.set(e, String(w.wrapper)); }
    }
    S.th.set(threadId, th);
    return th;
  }
  const active = (th, uid) => [...th.devices.values()].filter((d) => !d.revoked && (uid == null || d.user_id === uid));
  // Писать можно ключом текущей эпохи, только если обернувшее его устройство действующее (оно входит в отпечаток)
  function sendable(th) {
    const w = th.devices.get(th.wrappers.get(th.epoch));
    return th.keys.has(th.epoch) && !!w && !w.revoked;
  }

  async function newEpoch(th, epoch) {
    const raw = rand(32);
    const wraps = [];
    for (const d of active(th)) wraps.push(await wrap(th, epoch, raw, d));
    await rpc('chat_epoch_create', { p_thread: th.id, p_device: S.dev, p_epoch: epoch, p_wraps: wraps });
    th.raw.set(epoch, raw); th.keys.set(epoch, await msgKey(raw)); th.wrappers.set(epoch, S.dev);
  }

  // Подтверждение своего нового устройства: выдать ему ключи всех эпох, что есть у этого
  async function approve(th) {
    const wraps = [];
    for (const d of active(th, S.uid)) {
      if (d.id === S.dev) continue;
      for (const [e, raw] of th.raw) if (!d.epochs.includes(e)) wraps.push({ ...(await wrap(th, e, raw, d)), epoch: e });
    }
    for (let i = 0; i < wraps.length; i += 200) await rpc('chat_wraps_add', { p_thread: th.id, p_device: S.dev, p_wraps: wraps.slice(i, i + 200) });
    return wraps.length;
  }

  // Отпечаток: SHA-256('journal-chat-fp-v2|' + по участникам в порядке user_id: '<user_id>:<x.y действующих устройств
  // по возрастанию через запятую>' через '|'), первые 16 hex-знаков → 'XXXX XXXX XXXX XXXX'. У обоих собеседников одинаковый.
  async function fp(th) {
    const part = (uid) => uid + ':' + active(th, uid).map((d) => d.pub.x + '.' + d.pub.y).sort().join(',');
    const canon = 'journal-chat-fp-v2|' + [th.me, th.peer].sort().map(part).join('|');
    const h = new Uint8Array(await S.c.subtle.digest('SHA-256', enc.encode(canon)));
    const hex = Array.from(h.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.match(/.{4}/g).join(' ');
  }

  // ===== API =====

  // Ключ устройства: из хранилища или новый (без вопросов пользователю). → { state: 'ready', device_id, created }
  async function init(sb, uid, opts) {
    const o = opts || {};
    if (!sb || !uid) fail('bad_args');
    S.sb = sb; S.uid = String(uid);
    S.c = o.crypto || root.crypto;
    S.store = o.storage || idbStorage();
    S.priv = null; S.pub = null; S.dev = null; S.th.clear();
    if (!S.c || !S.c.subtle) fail('no_crypto');
    const slot = 'dev:' + S.uid;
    const rec = await quiet(() => S.store.get(slot));
    if (rec && rec.priv && okJwk(rec.pub)) {
      const r = await rpc('chat_device_register', { p_public_jwk: pubOnly(rec.pub) });
      if (!r.revoked) {
        S.priv = rec.priv; S.pub = pubOnly(rec.pub); S.dev = String(r.device_id);
        return { state: 'ready', device_id: S.dev, created: false };
      }
    }
    // закрытый ключ создаётся неизвлекаемым: наружу его не достать даже коду страницы; открытый экспортируется всегда
    const pair = await S.c.subtle.generateKey(CURVE, false, ['deriveBits']);
    const pub = pubOnly(await S.c.subtle.exportKey('jwk', pair.publicKey));
    const r = await rpc('chat_device_register', { p_public_jwk: pub });
    if (r.revoked) fail('device_revoked');
    S.priv = pair.privateKey; S.pub = pub; S.dev = String(r.device_id);
    await quiet(() => S.store.set(slot, { device_id: S.dev, priv: S.priv, pub }));
    await quiet(() => S.store.del(S.uid));                 // запись прежней схемы (ключ под паролем переписки) больше не нужна
    return { state: 'ready', device_id: S.dev, created: true };
  }

  // Открыть тред: прочитать ключи, при необходимости создать эпоху и подтвердить свои новые устройства.
  // → { status: 'ready' | 'waiting' | 'no_peer', epoch, fingerprint, peer_devices: [id], my_devices: [id], approved }
  //   waiting — ключ текущей эпохи этому устройству ещё не выдан (ждём своё прежнее устройство или «начать заново»);
  //   no_peer — у собеседника ещё нет ни одного устройства (он не открывал чат).
  async function open(threadId) {
    if (!S.dev) fail('not_ready');
    threadId = String(threadId);
    for (let tries = 0; ; tries++) {
      const st = await rpc('chat_thread_state', { p_thread: threadId, p_device: S.dev });
      const th = await absorb(threadId, st);
      if (!active(th, th.peer).length) return result(th, 'no_peer', 0);
      if (st.stale) {
        if (tries >= 3) fail('epoch_conflict');
        try { await newEpoch(th, (th.epoch || 0) + 1); }
        catch (e) { if (!/epoch_conflict|devices_changed/.test(e.message)) throw e; }
        continue;                                          // перечитать: своя или чужая новая эпоха
      }
      const n = await approve(th);
      return result(th, sendable(th) ? 'ready' : 'waiting', n);
    }
  }
  async function result(th, status, approved) {
    const ids = (uid) => active(th, uid).map((d) => d.id).sort();
    return { status, epoch: th.epoch, fingerprint: await fp(th), peer_devices: ids(th.peer), my_devices: ids(th.me), approved };
  }

  // → { epoch, device, iv, ciphertext } для chat_post
  async function encrypt(threadId, plaintext) {
    const th = S.th.get(String(threadId));
    if (!S.dev || !th || !sendable(th)) fail('not_ready');
    if (typeof plaintext !== 'string') fail('bad_text');
    const iv = rand(12);
    const ct = await S.c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(th.id, th.epoch, S.uid, S.dev) },
      th.keys.get(th.epoch), enc.encode(plaintext));
    if (ct.byteLength > MAX_CT) fail('too_long');
    return { epoch: th.epoch, device: S.dev, iv: b64u(iv), ciphertext: b64u(ct) };
  }

  // msg = строка chat_messages { sender_id, key_epoch, sender_device, iv, ciphertext } → текст или null
  // null: ключа этой эпохи у устройства нет (старая переписка, ещё не подтверждено), сообщение прежней схемы,
  // чужой отправитель или устройство, подмена, повреждение.
  async function decrypt(threadId, msg) {
    try {
      const th = S.th.get(String(threadId));
      if (!th || !msg || msg.key_epoch == null) return null;
      const e = Number(msg.key_epoch), sender = String(msg.sender_id), dev = th.devices.get(String(msg.sender_device));
      if (!th.keys.has(e) || (sender !== th.me && sender !== th.peer) || !dev || dev.user_id !== sender) return null;
      const iv = unb64u(msg.iv);
      if (iv.length !== 12) return null;
      const pt = await S.c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: msgAad(th.id, e, sender, dev.id) }, th.keys.get(e), unb64u(msg.ciphertext));
      return dec.decode(pt);
    } catch (_) {
      return null;
    }
  }

  async function fingerprint(threadId) {
    const th = S.th.get(String(threadId));
    if (!th) fail('not_ready');
    return fp(th);
  }

  // «Начать заново на этом устройстве»: остальные свои устройства отзываются; треды получат новую эпоху при открытии.
  async function reset() {
    if (!S.dev) fail('not_ready');
    const n = await rpc('chat_device_reset', { p_device: S.dev });
    S.th.clear();
    return { revoked: Number(n) || 0 };
  }

  root.ChatCrypto = Object.freeze({ init, open, encrypt, decrypt, fingerprint, reset });
})(typeof window !== 'undefined' ? window : globalThis);
