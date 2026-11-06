// Сквозное шифрование чата «староста/заместитель ↔ преподаватель» (этап 4). Контракт: docs/stage4-contract.md,
// модель угроз: docs/stage4-db.md. Только Web Crypto API; работает в браузере (window.ChatCrypto) и в Node 24
// (тест tests/unit/chat-crypto.mjs подставляет crypto и хранилище через init(sb, uid, { crypto, storage })).
//
// Ключи: ECDH P-256. Закрытый ключ живёт в IndexedDB как неизвлекаемый CryptoKey и на сервере — только в виде
// резервной копии: AES-GCM-256, ключ из PBKDF2-SHA256 (600 000 итераций, соль 16 байт) от «пароля переписки»,
// additionalData = 'journal-chat-backup-v1|<user_id>'.
// Ключ треда: ECDH → HKDF-SHA256 (salt = id треда, info = 'journal-chat-v1') → AES-GCM-256.
// Сообщение: iv 12 байт, additionalData = '<thread_id>|<sender_id>|<sender_key_version>|<recipient_key_version>'.
// Закрытый ключ наружу не отдаётся; тексты сообщений и пароли никуда не пишутся (ни в console, ни в storage).
(function (root) {
  'use strict';

  const ITER = 600000;
  const MAX_ITER = 10000000;
  const MAX_CT = 8192;                                   // байт шифртекста, как в chat_send
  const INFO = 'journal-chat-v1';
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Состояние вошедшего пользователя (одна учётная запись на страницу)
  const S = { sb: null, uid: null, c: null, store: null, priv: null, pub: null, version: null, keys: new Map() };

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

  // ----- хранилище закрытого ключа (IndexedDB; ключ записи — user_id) -----
  // Интерфейс для подмены: { get(uid), set(uid, record), del(uid) }, все async. record = { priv, pub, version }.
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
  // Сбой хранилища (приватный режим, запрет сайта) не ломает чат: ключ остаётся в памяти до закрытия страницы
  const quiet = async (fn) => { try { return await fn(); } catch (_) { return undefined; } };

  // ----- ключи -----
  const pubOnly = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
  const sameKey = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
  const importPriv = (jwk) => S.c.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, CURVE, false, ['deriveBits']);
  const importPub = (jwk) => S.c.subtle.importKey('jwk', pubOnly(jwk), CURVE, false, []);

  async function passKey(password, salt, iter) {
    const base = await S.c.subtle.importKey('raw', enc.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return S.c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const backupAad = () => enc.encode('journal-chat-backup-v1|' + S.uid);

  async function myRow() {
    const { data, error } = await S.sb.from('chat_keys').select('public_jwk, key_version, backup').eq('user_id', S.uid).maybeSingle();
    if (error) fail(error.message || 'load_failed');
    return data || null;
  }

  async function adopt(priv, pub, version) {
    S.priv = priv; S.pub = pubOnly(pub); S.version = Number(version); S.keys.clear();
    await quiet(() => S.store.set(S.uid, { priv, pub: S.pub, version: S.version }));
  }
  const ready = () => ({ state: 'ready', key_version: S.version });

  // Новая пара → копия под паролем → публикация → локально только неизвлекаемый ключ
  async function publish(password, reset) {
    if (typeof password !== 'string' || password.length < 8) fail('weak_password');
    const pair = await S.c.subtle.generateKey(CURVE, true, ['deriveBits']);
    const jwk = await S.c.subtle.exportKey('jwk', pair.privateKey);
    const salt = rand(16), iv = rand(12);
    const ct = await S.c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: backupAad() }, await passKey(password, salt, ITER),
      enc.encode(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d })));
    const priv = await importPriv(jwk);
    const pub = pubOnly(jwk);
    jwk.d = '';
    const backup = { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
    const { data, error } = await S.sb.rpc('chat_keys_publish', { p_public_jwk: pub, p_backup: backup, p_reset: !!reset });
    if (error) fail(error.message || 'publish_failed');
    await adopt(priv, pub, data.key_version);
    return ready();
  }

  // Ключ треда (кэш по треду, ключу собеседника и своей версии)
  function threadKey(thread) {
    const p = thread.peer.public_jwk;
    const id = [thread.id, thread.peer.id, p.x, p.y, S.version].join('|');
    if (!S.keys.has(id)) {
      const job = (async () => {
        const bits = await S.c.subtle.deriveBits({ name: 'ECDH', public: await importPub(p) }, S.priv, 256);
        const hk = await S.c.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
        return S.c.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(thread.id)), info: enc.encode(INFO) },
          hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      })();
      job.catch(() => S.keys.delete(id));
      S.keys.set(id, job);
    }
    return S.keys.get(id);
  }
  const msgAad = (threadId, senderId, skv, rkv) => enc.encode(`${threadId}|${senderId}|${skv}|${rkv}`);

  // ===== API =====

  // → { state: 'none' | 'locked' | 'ready', key_version }  (key_version — своя текущая версия на сервере или null)
  async function init(sb, uid, opts) {
    const o = opts || {};
    if (!sb || !uid) fail('bad_args');
    S.sb = sb; S.uid = String(uid);
    S.c = o.crypto || root.crypto;
    S.store = o.storage || idbStorage();
    S.priv = null; S.pub = null; S.version = null; S.keys.clear();
    if (!S.c || !S.c.subtle) fail('no_crypto');
    const row = await myRow();
    if (!row) {
      await quiet(() => S.store.del(S.uid));
      return { state: 'none', key_version: null };
    }
    const rec = await quiet(() => S.store.get(S.uid));
    if (rec && rec.priv && sameKey(rec.pub, row.public_jwk)) {
      S.priv = rec.priv; S.pub = pubOnly(row.public_jwk); S.version = Number(row.key_version);
      return ready();
    }
    return { state: 'locked', key_version: Number(row.key_version) };
  }

  async function setup(password) {
    if (!S.sb) fail('not_initialized');
    if (await myRow()) fail('already_exists');
    return publish(password, false);
  }

  // Неверный пароль → Error('bad_password'); копия не от этого ключа → Error('bad_backup')
  async function unlock(password) {
    if (!S.sb) fail('not_initialized');
    const row = await myRow();
    if (!row) fail('no_keys');
    const b = row.backup || {};
    let salt, iv, ct;
    try { salt = unb64u(b.salt); iv = unb64u(b.iv); ct = unb64u(b.ct); } catch (_) { fail('bad_backup'); }
    if (b.v !== 1 || b.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(b.iter) || b.iter < ITER || b.iter > MAX_ITER
        || salt.length !== 16 || iv.length !== 12) fail('bad_backup');
    let jwk;
    try {
      const pt = await S.c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: backupAad() }, await passKey(password, salt, b.iter), ct);
      jwk = JSON.parse(dec.decode(pt));
    } catch (_) { fail('bad_password'); }
    if (!jwk || typeof jwk.d !== 'string' || !sameKey(jwk, row.public_jwk)) fail('bad_backup');
    const priv = await importPriv(jwk);
    jwk.d = '';
    await adopt(priv, row.public_jwk, row.key_version);
    return ready();
  }

  // Новая пара (p_reset): старые сообщения обеих сторон станут нечитаемыми
  async function reset(password) {
    if (!S.sb) fail('not_initialized');
    return publish(password, true);
  }

  // thread = { id, me:{id}, peer:{id, public_jwk, key_version}, my_key_version }
  // → { iv, ciphertext, sender_key_version, recipient_key_version }
  async function encrypt(thread, plaintext) {
    if (!S.priv) fail('not_ready');
    if (!thread || !thread.id || !thread.me || String(thread.me.id) !== S.uid) fail('wrong_user');
    if (thread.my_key_version != null && Number(thread.my_key_version) !== S.version) fail('key_changed');
    if (!thread.peer || !thread.peer.public_jwk || thread.peer.key_version == null) fail('no_peer_key');
    if (typeof plaintext !== 'string') fail('bad_text');
    const skv = S.version, rkv = Number(thread.peer.key_version);
    const iv = rand(12);
    const ct = await S.c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(thread.id, S.uid, skv, rkv) },
      await threadKey(thread), enc.encode(plaintext));
    if (ct.byteLength > MAX_CT) fail('too_long');
    return { iv: b64u(iv), ciphertext: b64u(ct), sender_key_version: skv, recipient_key_version: rkv };
  }

  // msg = строка chat_messages { sender_id, sender_key_version, recipient_key_version, iv, ciphertext } → текст или null
  // null: ключ заменён (версия не совпала с текущей у меня или у собеседника), чужой отправитель, подмена, повреждение.
  async function decrypt(thread, msg) {
    try {
      if (!S.priv || !thread || !thread.peer || !thread.peer.public_jwk || !msg) return null;
      const sender = String(msg.sender_id);
      const mine = sender === S.uid;
      if (!mine && sender !== String(thread.peer.id)) return null;
      const skv = Number(msg.sender_key_version), rkv = Number(msg.recipient_key_version);
      if ((mine ? skv : rkv) !== S.version || (mine ? rkv : skv) !== Number(thread.peer.key_version)) return null;
      const iv = unb64u(msg.iv);
      if (iv.length !== 12) return null;
      const pt = await S.c.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: msgAad(thread.id, sender, skv, rkv) },
        await threadKey(thread), unb64u(msg.ciphertext));
      return dec.decode(pt);
    } catch (_) {
      return null;
    }
  }

  // Отпечаток пары ключей: SHA-256('journal-chat-fp-v1|' + x.y первого по user_id + '|' + x.y второго),
  // первые 8 hex-знаков в верхнем регистре → 'XXXX XXXX'. У обоих собеседников одинаковый.
  async function fingerprint(thread) {
    if (!S.pub) fail('not_ready');
    if (!thread || !thread.peer || !thread.peer.public_jwk) fail('no_peer_key');
    const parts = [[S.uid, S.pub], [String(thread.peer.id), thread.peer.public_jwk]]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canon = 'journal-chat-fp-v1|' + parts.map(([, j]) => j.x + '.' + j.y).join('|');
    const h = new Uint8Array(await S.c.subtle.digest('SHA-256', enc.encode(canon)));
    const hex = Array.from(h.slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.slice(0, 4) + ' ' + hex.slice(4);
  }

  root.ChatCrypto = Object.freeze({ init, setup, unlock, reset, encrypt, decrypt, fingerprint });
})(typeof window !== 'undefined' ? window : globalThis);
