// Модульный тест chat-crypto.js (Node 24, без сети). Сервер — подделка в памяти с той же логикой версий, что
// chat_keys_publish; хранилище — Map вместо IndexedDB. Каждый «участник» и «устройство» — отдельный экземпляр модуля
// (импорт с разным ?query даёт новый экземпляр).
//   node tests/unit/chat-crypto.mjs
import assert from 'node:assert/strict';

const results = [];
async function t(name, fn) {
  try { await fn(); results.push([name, true]); console.log('OK     ' + name); }
  catch (e) { results.push([name, false]); console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); }
}
async function rejects(p, code) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, 'ожидалась ошибка ' + code);
  assert.equal(err.message, code);
}
async function load(tag) {
  await import(new URL(`../../chat-crypto.js?${tag}`, import.meta.url).href);
  return globalThis.ChatCrypto;
}
// в выводе модуля нигде нет закрытой части ключа
function noD(x, path = '$') {
  if (x && typeof x === 'object') {
    if (!(x instanceof Uint8Array) && Object.prototype.hasOwnProperty.call(x, 'd')) throw new Error('найдено поле d в ' + path);
    for (const [k, v] of Object.entries(x)) noD(v, path + '.' + k);
  }
}

// ----- подделка Supabase: chat_keys + chat_keys_publish (как в миграции) -----
const server = { keys: new Map(), calls: [] };
function sbFor(uid) {
  return {
    from(table) {
      assert.equal(table, 'chat_keys');
      let id = null;
      const q = {
        select() { return q; },
        eq(col, v) { assert.equal(col, 'user_id'); id = v; return q; },
        async maybeSingle() {
          if (id !== uid) return { data: null, error: null };          // RLS: только своя строка
          const r = server.keys.get(uid);
          return { data: r ? structuredClone(r) : null, error: null };
        },
      };
      return q;
    },
    async rpc(name, args) {
      assert.equal(name, 'chat_keys_publish');
      server.calls.push(structuredClone(args));
      const { p_public_jwk: pub, p_backup: b, p_reset: reset } = args;
      if (!pub || 'd' in pub || pub.kty !== 'EC' || pub.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(pub.x) || !/^[A-Za-z0-9_-]{43}$/.test(pub.y)) return { data: null, error: { message: 'bad_key' } };
      if (b.v !== 1 || b.kdf !== 'PBKDF2-SHA256' || !(b.iter >= 600000) || !/^[A-Za-z0-9_-]{22}$/.test(b.salt) || !/^[A-Za-z0-9_-]{16}$/.test(b.iv) || !(b.ct.length >= 24 && b.ct.length <= 2048)) return { data: null, error: { message: 'bad_backup' } };
      const cur = server.keys.get(uid);
      let v;
      if (!cur) v = 1;
      else if (reset) v = cur.key_version + 1;
      else if (cur.public_jwk.x === pub.x && cur.public_jwk.y === pub.y) v = cur.key_version;
      else return { data: null, error: { message: 'key_mismatch' } };
      server.keys.set(uid, { public_jwk: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, key_version: v, backup: b });
      return { data: { key_version: v }, error: null };
    },
  };
}
function mapStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
}
const peerOf = (uid) => ({ id: uid, public_jwk: server.keys.get(uid).public_jwk, key_version: server.keys.get(uid).key_version });
const thread = (id, me, peer) => ({ id, me: { id: me }, peer: peerOf(peer), my_key_version: server.keys.get(me).key_version });
const row = (m, sender) => ({ ...m, sender_id: sender });

// console молчит: модуль не пишет ни текст, ни ключи
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { if (!String(a[0]).startsWith('OK') && !String(a[0]).startsWith('ПРОВАЛ')) printed.push(a); orig(...a); };
}

const A_ID = '11111111-1111-4111-8111-111111111111', B_ID = '22222222-2222-4222-8222-222222222222';
const TH = '33333333-3333-4333-8333-333333333333';
const PW_A = 'пароль переписки A', PW_B = 'password-of-B';
const TEXT = 'Перенос пары на 10:00, аудитория 512 🙂';
const stA = mapStorage(), stB = mapStorage();
const A = await load('a'), B = await load('b');
const outputs = [];
let m1, fpBefore;

await t('API: ровно имена контракта', () => {
  assert.deepEqual(Object.keys(A).sort(), ['decrypt', 'encrypt', 'fingerprint', 'init', 'reset', 'setup', 'unlock']);
  assert.ok(Object.isFrozen(A));
  assert.notEqual(A, B);
});

await t('init без ключей → none; короткий пароль → weak_password', async () => {
  const r = await A.init(sbFor(A_ID), A_ID, { storage: stA });
  outputs.push(r);
  assert.equal(r.state, 'none');
  await rejects(A.setup('1234567'), 'weak_password');
});

await t('setup обоих → ready, версия 1; повторный setup → already_exists', async () => {
  const ra = await A.setup(PW_A); outputs.push(ra);
  assert.deepEqual(ra, { state: 'ready', key_version: 1 });
  outputs.push(await B.init(sbFor(B_ID), B_ID, { storage: stB }));
  outputs.push(await B.setup(PW_B));
  await rejects(A.setup(PW_A), 'already_exists');
});

await t('на сервер ушли только открытый ключ и копия правильного формата', () => {
  assert.equal(server.calls.length, 2);
  for (const c of server.calls) {
    noD(c);
    assert.deepEqual(Object.keys(c.p_public_jwk).sort(), ['crv', 'kty', 'x', 'y']);
    assert.equal(c.p_backup.iter, 600000);
    assert.equal(c.p_backup.kdf, 'PBKDF2-SHA256');
    assert.match(c.p_backup.salt, /^[A-Za-z0-9_-]{22}$/);     // 16 байт
    assert.match(c.p_backup.iv, /^[A-Za-z0-9_-]{16}$/);       // 12 байт
    assert.ok(!JSON.stringify(c).includes(PW_A) && !JSON.stringify(c).includes(PW_B), 'пароль ушёл на сервер');
  }
});

await t('закрытый ключ локально неизвлекаемый, в хранилище нет JWK', async () => {
  const rec = stA.m.get(A_ID);
  assert.ok(rec.priv && rec.priv.type === 'private');
  assert.equal(rec.priv.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', rec.priv));
  noD({ pub: rec.pub, version: rec.version });
});

await t('A → B и B → A: расшифровка у получателя и у отправителя', async () => {
  const tA = thread(TH, A_ID, B_ID), tB = thread(TH, B_ID, A_ID);
  m1 = await A.encrypt(tA, TEXT); outputs.push(m1);
  assert.equal(m1.sender_key_version, 1); assert.equal(m1.recipient_key_version, 1);
  assert.match(m1.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(!m1.ciphertext.includes('Перенос'));
  assert.equal(await B.decrypt(tB, row(m1, A_ID)), TEXT);
  assert.equal(await A.decrypt(tA, row(m1, A_ID)), TEXT);
  const m2 = await B.encrypt(tB, 'Ответ');
  assert.equal(await A.decrypt(tA, row(m2, B_ID)), 'Ответ');
  const m3 = await A.encrypt(tA, TEXT);
  assert.notEqual(m3.iv, m1.iv); assert.notEqual(m3.ciphertext, m1.ciphertext);
});

await t('подмена шифртекста, iv, отправителя, треда, версий → null', async () => {
  const tB = thread(TH, B_ID, A_ID);
  const flip = (s) => (s[5] === 'A' ? 'B' : 'A') + '';
  const ct = m1.ciphertext.slice(0, 5) + flip(m1.ciphertext) + m1.ciphertext.slice(6);
  const iv = m1.iv.slice(0, 5) + flip(m1.iv) + m1.iv.slice(6);
  assert.equal(await B.decrypt(tB, { ...row(m1, A_ID), ciphertext: ct }), null);
  assert.equal(await B.decrypt(tB, { ...row(m1, A_ID), iv }), null);
  assert.equal(await B.decrypt(tB, { ...row(m1, A_ID), ciphertext: m1.ciphertext.slice(0, -2) }), null);
  assert.equal(await B.decrypt(tB, row(m1, B_ID)), null, 'отправитель подменён на получателя (AAD)');
  assert.equal(await B.decrypt(tB, row(m1, '44444444-4444-4444-8444-444444444444')), null, 'посторонний отправитель');
  assert.equal(await B.decrypt({ ...tB, id: '55555555-5555-4555-8555-555555555555' }, row(m1, A_ID)), null, 'другой тред (соль HKDF и AAD)');
  assert.equal(await B.decrypt(tB, { ...row(m1, A_ID), sender_key_version: 2 }), null);
  assert.equal(await B.decrypt(tB, { ...row(m1, A_ID), iv: 'не base64' }), null);
  assert.equal(await B.decrypt(tB, null), null);
});

await t('отпечаток одинаковый у обоих, формат «XXXX XXXX»', async () => {
  const fa = await A.fingerprint(thread(TH, A_ID, B_ID)), fb = await B.fingerprint(thread(TH, B_ID, A_ID));
  assert.match(fa, /^[0-9A-F]{4} [0-9A-F]{4}$/);
  assert.equal(fa, fb);
  fpBefore = fa;
});

await t('новое устройство: locked → неверный пароль bad_password → верный → та же расшифровка', async () => {
  const A2 = await load('a-device2'), st2 = mapStorage();
  const r = await A2.init(sbFor(A_ID), A_ID, { storage: st2 }); outputs.push(r);
  assert.deepEqual(r, { state: 'locked', key_version: 1 });
  assert.equal(await A2.decrypt(thread(TH, A_ID, B_ID), row(m1, A_ID)), null, 'до разблокировки не читает');
  await rejects(A2.unlock('неверный пароль'), 'bad_password');
  const u = await A2.unlock(PW_A); outputs.push(u);
  assert.deepEqual(u, { state: 'ready', key_version: 1 });
  assert.equal(await A2.decrypt(thread(TH, A_ID, B_ID), row(m1, A_ID)), TEXT);
  assert.equal(st2.m.get(A_ID).priv.extractable, false);
  assert.equal(await A2.fingerprint(thread(TH, A_ID, B_ID)), fpBefore);
  // то же устройство после перезагрузки страницы: ключ из хранилища, пароль не нужен
  const A3 = await load('a-device2-reload');
  assert.equal((await A3.init(sbFor(A_ID), A_ID, { storage: st2 })).state, 'ready');
});

await t('копия чужого пользователя не открывается (AAD = user_id)', async () => {
  const fake = { ...sbFor(A_ID) };
  const X = await load('x');
  // сервер подсовывает A копию B (пароль B известен) — ключ не принимается
  fake.from = () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { ...structuredClone(server.keys.get(B_ID)) }, error: null }; } });
  await X.init(fake, A_ID, { storage: mapStorage() });
  await rejects(X.unlock(PW_B), 'bad_password');
});

await t('сброс: версия 2, старые сообщения → null у обоих, новый отпечаток общий', async () => {
  const r = await B.reset('новый пароль B'); outputs.push(r);
  assert.deepEqual(r, { state: 'ready', key_version: 2 });
  const tB = thread(TH, B_ID, A_ID), tA = thread(TH, A_ID, B_ID);
  assert.equal(await B.decrypt(tB, row(m1, A_ID)), null);
  assert.equal(await A.decrypt(tA, row(m1, A_ID)), null, 'отправитель тоже не читает: ключ собеседника заменён');
  const fa = await A.fingerprint(tA), fb = await B.fingerprint(tB);
  assert.equal(fa, fb); assert.notEqual(fa, fpBefore);
  // A по старому ключу B → версия не совпадёт с сервером; модуль не шифрует под чужую текущую версию сам
  const m4 = await A.encrypt(tA, 'после сброса');
  assert.equal(m4.recipient_key_version, 2);
  assert.equal(await B.decrypt(tB, row(m4, A_ID)), 'после сброса');
  // переставленные версии (1 ↔ 2) — не расшифровываются
  assert.equal(await B.decrypt(tB, { ...row(m4, A_ID), sender_key_version: 2, recipient_key_version: 1 }), null);
  // старое устройство B (до сброса) теперь locked: ключ в хранилище не совпадает с сервером
  const Bold = await load('b-old');
  assert.equal((await Bold.init(sbFor(B_ID), B_ID, { storage: { get: async () => ({ ...stB.m.get(B_ID), pub: server.calls[1].p_public_jwk }), set: async () => {}, del: async () => {} } })).state, 'locked');
});

await t('ошибки encrypt: чужой тред, устаревшая своя версия, нет ключа собеседника, больше 8 КБ', async () => {
  const tA = thread(TH, A_ID, B_ID);
  await rejects(A.encrypt({ ...tA, me: { id: B_ID } }, 'x'), 'wrong_user');
  await rejects(A.encrypt({ ...tA, my_key_version: 5 }, 'x'), 'key_changed');
  await rejects(A.encrypt({ ...tA, peer: { id: B_ID, public_jwk: null, key_version: null } }, 'x'), 'no_peer_key');
  await rejects(A.encrypt(tA, 'я'.repeat(4200)), 'too_long');
  const ok = await A.encrypt(tA, 'я'.repeat(4000));                    // 8000 байт + тег 16
  assert.ok(ok.ciphertext.length <= 10923);
});

await t('ни один ответ модуля не содержит закрытой части ключа; console молчит', () => {
  noD(outputs);
  assert.equal(printed.length, 0, 'модуль что-то печатал');
});

const bad = results.filter((r) => !r[1]).length;
console.log(`\nchat-crypto: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
