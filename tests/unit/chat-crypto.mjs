// Модульный тест chat-crypto.js 2.1 п.12 (Node 24, без сети). Сервер — подделка в памяти tests/e2e/chat-fake.mjs с теми же
// правилами, что миграция 20261122110000; хранилище — Map вместо IndexedDB. Каждое «устройство» — отдельный экземпляр модуля
// (импорт с разным ?query даёт новый экземпляр).
//   node tests/unit/chat-crypto.mjs
import assert from 'node:assert/strict';
import { makeChatServer } from '../e2e/chat-fake.mjs';

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
// в выводе модуля и в запросах к серверу нигде нет закрытой части ключа
function noD(x, path = '$') {
  if (x && typeof x === 'object') {
    if (!(x instanceof Uint8Array) && Object.prototype.hasOwnProperty.call(x, 'd')) throw new Error('найдено поле d в ' + path);
    for (const [k, v] of Object.entries(x)) noD(v, path + '.' + k);
  }
}
function mapStorage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
}

// console молчит: модуль не пишет ни текст, ни ключи
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { if (!String(a[0]).startsWith('OK') && !String(a[0]).startsWith('ПРОВАЛ')) printed.push(a); orig(...a); };
}

const A_ID = '11111111-1111-4111-8111-111111111111';   // староста
const B_ID = '22222222-2222-4222-8222-222222222222';   // преподаватель
const C_ID = '44444444-4444-4444-8444-444444444444';   // староста другой группы (чужой)
const TH = '33333333-3333-4333-8333-333333333333', TH_C = '55555555-5555-4555-8555-555555555555';
const srv = makeChatServer({ eligible: [A_ID, B_ID, C_ID], threads: [
  { id: TH, group_id: 'g1', student_user_id: A_ID, teacher_user_id: B_ID, kind: 'lecture' },
  { id: TH_C, group_id: 'g2', student_user_id: C_ID, teacher_user_id: B_ID, kind: 'lecture' }] });
// отправка как в chat-ui.js: encrypt → chat_post; чтение: строки chat_messages треда
async function send(C, uid, text) {
  const e = await C.encrypt(TH, text);
  const r = srv.call(uid, 'chat_post', { p_thread: TH, p_device: e.device, p_epoch: e.epoch, p_iv: e.iv, p_ciphertext: e.ciphertext });
  if (r.error) throw new Error(r.error.message);
  return srv.S.messages.find((m) => m.id === r.data);
}
const readAll = (C, uid) => Promise.all(srv.messages(uid, TH).map((m) => C.decrypt(TH, m)));

const TEXT = 'Перенос пары на 10:00, аудитория 512 🙂';
const stA = mapStorage(), stB = mapStorage();
const A = await load('a'), B = await load('b');
const outputs = [];
let m1, fp1, devA;

await t('API: init, open, encrypt, decrypt, fingerprint, reset — без пароля', () => {
  assert.deepEqual(Object.keys(A).sort(), ['decrypt', 'encrypt', 'fingerprint', 'init', 'open', 'reset']);
  assert.ok(Object.isFrozen(A));
  assert.notEqual(A, B);
});

await t('init: ключ устройства создаётся сам, на сервер уходит только открытый ключ; повторный init — то же устройство', async () => {
  const r = await A.init(srv.sbFor(A_ID), A_ID, { storage: stA }); outputs.push(r);
  assert.equal(r.state, 'ready'); assert.equal(r.created, true);
  devA = r.device_id;
  const reg = srv.S.calls.filter((c) => c.name === 'chat_device_register');
  assert.equal(reg.length, 1);
  assert.deepEqual(Object.keys(reg[0].args.p_public_jwk).sort(), ['crv', 'kty', 'x', 'y']);
  const again = await (await load('a-reload')).init(srv.sbFor(A_ID), A_ID, { storage: stA });
  assert.deepEqual(again, { state: 'ready', device_id: devA, created: false });
});

await t('закрытый ключ в хранилище неизвлекаемый, JWK с d нигде нет', async () => {
  const rec = stA.m.get('dev:' + A_ID);
  assert.ok(rec.priv && rec.priv.type === 'private');
  assert.equal(rec.priv.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', rec.priv));
  noD({ pub: rec.pub, device_id: rec.device_id });
});

await t('собеседник ещё не открывал чат → no_peer, ключ треда не создаётся', async () => {
  const o = await A.open(TH); outputs.push(o);
  assert.equal(o.status, 'no_peer');
  assert.equal(srv.S.threads[0].key_epoch, null);
  await rejects(A.encrypt(TH, 'x'), 'not_ready');
});

await t('оба открыли чат → эпоха 1 создаётся автоматически, ready у обоих, отпечаток общий «XXXX XXXX XXXX XXXX»', async () => {
  outputs.push(await B.init(srv.sbFor(B_ID), B_ID, { storage: stB }));
  const ob = await B.open(TH); outputs.push(ob);
  assert.equal(ob.status, 'ready'); assert.equal(ob.epoch, 1);
  const oa = await A.open(TH); outputs.push(oa);
  assert.equal(oa.status, 'ready'); assert.equal(oa.epoch, 1);
  assert.match(oa.fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.equal(oa.fingerprint, ob.fingerprint);
  fp1 = oa.fingerprint;
  assert.equal(srv.S.keys.filter((k) => k.thread_id === TH && k.epoch === 1).length, 2, 'обёртки на оба устройства');
});

await t('A → B и B → A: расшифровка у получателя и у отправителя; в «базе» нет открытого текста и ключа треда', async () => {
  m1 = await send(A, A_ID, TEXT);
  assert.equal(await B.decrypt(TH, m1), TEXT);
  assert.equal(await A.decrypt(TH, m1), TEXT);
  const m2 = await send(B, B_ID, 'Ответ преподавателя');
  assert.equal(await A.decrypt(TH, m2), 'Ответ преподавателя');
  const m3 = await send(A, A_ID, TEXT);
  assert.notEqual(m3.iv, m1.iv); assert.notEqual(m3.ciphertext, m1.ciphertext);
  const db = JSON.stringify(srv.S);
  for (const s of ['Перенос', 'аудитория', 'Ответ', '512']) assert.ok(!db.includes(s), 'в базе открытый текст: ' + s);
  assert.ok(!/"d":/.test(db), 'в базе закрытый ключ');
  noD(srv.S.calls);
});

await t('подмена шифртекста, iv, отправителя, устройства, треда, эпохи → null', async () => {
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  assert.equal(await B.decrypt(TH, { ...m1, ciphertext: flip(m1.ciphertext, 5) }), null);
  assert.equal(await B.decrypt(TH, { ...m1, iv: flip(m1.iv, 5) }), null);
  assert.equal(await B.decrypt(TH, { ...m1, ciphertext: m1.ciphertext.slice(0, -2) }), null);
  assert.equal(await B.decrypt(TH, { ...m1, sender_id: B_ID }), null, 'отправитель подменён на получателя');
  const devB = srv.S.devices.find((d) => d.user_id === B_ID).id;
  assert.equal(await B.decrypt(TH, { ...m1, sender_id: B_ID, sender_device: devB }), null, 'выдан за сообщение собеседника (AAD)');
  assert.equal(await B.decrypt(TH, { ...m1, sender_id: C_ID }), null, 'посторонний отправитель');
  assert.equal(await B.decrypt(TH, { ...m1, key_epoch: 2 }), null);
  assert.equal(await B.decrypt(TH_C, m1), null, 'другой тред');
  assert.equal(await B.decrypt(TH, { ...m1, key_epoch: null, sender_key_version: 1, recipient_key_version: 1 }), null, 'сообщение прежней схемы');
  assert.equal(await B.decrypt(TH, { ...m1, iv: 'не base64' }), null);
  assert.equal(await B.decrypt(TH, null), null);
});

await t('чужой пользователь: сервер не отдаёт тред, а с полной копией базы ключ треда не разворачивается', async () => {
  const C = await load('c');
  await C.init(srv.sbFor(C_ID), C_ID, { storage: mapStorage() });
  await rejects(C.open(TH), 'forbidden');
  assert.equal(srv.messages(C_ID, TH).length, 0, 'RLS: сообщения чужого треда не видны');
  // злонамеренный сервер подсовывает C обёртки устройства A, выдав устройства A за устройства C
  const st = srv.call(A_ID, 'chat_thread_state', { p_thread: TH, p_device: devA }).data;
  const evil = { rpc: async (name, args) => (name === 'chat_thread_state'
    ? { data: { ...st, me: C_ID, devices: st.devices.map((d) => (d.user_id === A_ID ? { ...d, user_id: C_ID } : d)) }, error: null }
    : srv.call(C_ID, name, args)) };
  const C2 = await load('c2');
  await C2.init(evil, C_ID, { storage: mapStorage() });
  const o = await C2.open(TH);
  assert.notEqual(o.status, 'ready');
  assert.equal(await C2.decrypt(TH, m1), null);
});

await t('новое устройство того же аккаунта: ждёт → прежнее устройство открывает чат и выдаёт ключи → читает историю', async () => {
  const A2 = await load('a2'), stA2 = mapStorage();
  const r = await A2.init(srv.sbFor(A_ID), A_ID, { storage: stA2 }); outputs.push(r);
  assert.equal(r.created, true); assert.notEqual(r.device_id, devA);
  let o = await A2.open(TH); outputs.push(o);
  assert.equal(o.status, 'waiting', 'ключа ещё нет');
  assert.equal(await A2.decrypt(TH, m1), null);
  await rejects(A2.encrypt(TH, 'x'), 'not_ready');
  assert.notEqual(o.fingerprint, fp1, 'новое устройство меняет отпечаток');
  const oa = await A.open(TH); outputs.push(oa);
  assert.equal(oa.approved, 1, 'прежнее устройство выдало ключ эпохи 1');
  o = await A2.open(TH);
  assert.equal(o.status, 'ready');
  assert.equal(await A2.decrypt(TH, m1), TEXT);
  assert.deepEqual(await readAll(B, B_ID).then((x) => x.every((s) => typeof s === 'string')), true);
  const ob = await B.open(TH);
  assert.equal(ob.fingerprint, o.fingerprint, 'отпечаток снова общий');
  assert.equal(ob.peer_devices.length, 2, 'собеседник видит, что устройств стало два');
  assert.equal(srv.S.keys.filter((k) => k.thread_id === TH && k.epoch === 1).length, 3);
  assert.equal(srv.S.threads[0].key_epoch, 1, 'новое устройство не меняет эпоху');
});

await t('подмена ключа: сервер добавил собеседнику своё устройство → отпечаток и список устройств меняются, ключ ему не выдаётся', async () => {
  const before = await A.open(TH);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const j = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const fake = { id: '99999999-9999-4999-8999-999999999999', user_id: B_ID, public_jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, created_at: Date.now(), revoked_at: null };
  srv.S.devices.push(fake);
  const after = await A.open(TH);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(after.peer_devices.includes(fake.id) && !before.peer_devices.includes(fake.id));
  assert.equal(srv.S.keys.filter((k) => k.device_id === fake.id).length, 0, 'чужие устройства собеседника ключ от A не получают');
  srv.S.devices.splice(srv.S.devices.indexOf(fake), 1);
  assert.equal((await A.open(TH)).fingerprint, before.fingerprint);
});

await t('потеря всех устройств: «начать заново» → эпоха 2, история на новом устройстве недоступна, собеседник видит замену ключа', async () => {
  const oldFp = (await A.open(TH)).fingerprint, oldPeer = (await A.open(TH)).peer_devices;
  const B2 = await load('b2');
  await B2.init(srv.sbFor(B_ID), B_ID, { storage: mapStorage() });
  assert.equal((await B2.open(TH)).status, 'waiting');
  const r = await B2.reset(); outputs.push(r);
  assert.equal(r.revoked, 1);
  const o = await B2.open(TH); outputs.push(o);
  assert.equal(o.status, 'ready'); assert.equal(o.epoch, 2);
  assert.equal(await B2.decrypt(TH, m1), null, 'старая переписка на новом устройстве не читается');
  const m4 = await send(B2, B_ID, 'С нового телефона');
  const oa = await A.open(TH);
  assert.equal(oa.epoch, 2);
  assert.notEqual(oa.fingerprint, oldFp, 'отпечаток изменился');
  assert.ok(!oa.peer_devices.some((id) => oldPeer.includes(id)), 'у собеседника другие устройства — ключ заменён');
  assert.equal(await A.decrypt(TH, m4), 'С нового телефона');
  assert.equal(await A.decrypt(TH, m1), TEXT, 'у A старая переписка остаётся');
  await rejects(B.open(TH), 'device_revoked');
  const Bre = await load('b-reinit');
  const ri = await Bre.init(srv.sbFor(B_ID), B_ID, { storage: stB });
  assert.equal(ri.created, true, 'отозванное устройство при следующем входе получает новый ключ');
});

await t('отправка старой эпохой → key_changed; больше 8 КБ → too_long', async () => {
  const e = await A.encrypt(TH, 'x');
  const Bre = await load('b-reinit2');
  await Bre.init(srv.sbFor(B_ID), B_ID, { storage: stB });
  // A2 и B2 существуют: у B новое устройство без ключа эпохи 2 → не устарела; отправка эпохой 1 — key_changed
  const r = srv.call(A_ID, 'chat_post', { p_thread: TH, p_device: e.device, p_epoch: 1, p_iv: e.iv, p_ciphertext: e.ciphertext });
  assert.equal(r.error && r.error.message, 'key_changed');
  await rejects(A.encrypt(TH, 'я'.repeat(4200)), 'too_long');
  const ok = await A.encrypt(TH, 'я'.repeat(4000));
  assert.ok(ok.ciphertext.length <= 10923);
});

await t('ни один ответ модуля и запрос к серверу не содержит закрытой части ключа; console молчит', () => {
  noD(outputs); noD(srv.S.calls);
  assert.equal(printed.length, 0, 'модуль что-то печатал');
});

const bad = results.filter((r) => !r[1]).length;
console.log(`\nchat-crypto: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
