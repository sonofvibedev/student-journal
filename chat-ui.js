// «Журнал 2.0», этап 4 (2.1 п.12 — без пароля переписки): экран чата со сквозным шифрованием, общий для кабинета старосты и преподавателя.
// Подключается после cab-core.js и chat-crypto.js. ChatUI.mount(el, { sb, ctx, role: 'headman'|'teacher', startThread, back, title, right }).
// Шифрует и расшифровывает ChatCrypto прямо в браузере; ключ устройства создаётся сам, пароля нет. Расшифрованный текст живёт
// только в памяти экрана (не в localStorage, не в адресе, не в console). Права проверяет сервер (RLS и RPC), страница лишь показывает.
'use strict';
(function () {
  const { h, str, plural, icon } = Cab;
  const KINDS = { lecture: 'Лекции', practice: 'ПЗ' };
  const MAX = 2000, NEAR = 1800;           // длина сообщения, с какой длины показываем счётчик
  const POLL_MS = 4000, SLOW = 4;          // опрос новых сообщений; каждый 4-й опрос ещё сверяет ключи и счётчики
  const QUICK = [['Перенос пары', 'Перенос пары: '], ['Другая аудитория', 'Пара пройдёт в другой аудитории: '], ['Новое задание', 'Новое задание: ']];
  const COLS = 'id, sender_id, key_epoch, sender_device, iv, ciphertext, created_at';
  const SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="24" height="24"><path d="M21 3L3 10l7 3 3 7z"/><path d="M21 3L10 13"/></svg>';
  const $ = (r, s) => r.querySelector(s);
  const put = (el, html) => { if (el) el.innerHTML = str(html); };
  const code = (e) => String((e && (e.rpc || e.message)) || '');

  // Ошибка человеческим языком (коды из raise exception в RPC)
  function errText(e) {
    const c = code(e);
    if (c.includes('key_changed') || c.includes('not_ready')) return 'Ключ переписки обновился. Повторите отправку.';
    if (c.includes('rate_limited')) return 'Слишком много сообщений. Подождите минуту и повторите.';
    if (c.includes('too_long')) return 'Сообщение слишком длинное. Сократите его.';
    if (!navigator.onLine || /fetch|network|load failed/i.test(c)) return 'Нет связи. Сообщение не отправлено: повторите, когда появится сеть.';
    return Cab.rpcText(e);
  }
  const errTextLoad = (e) => (code(e).includes('too_many_devices') ? 'К чату подключено слишком много устройств. Откройте чат на одном из прежних и нажмите «Сверить» → «Начать заново на этом устройстве».'
    : /fetch|network|load failed/i.test(code(e)) || !navigator.onLine ? 'Нет связи. Проверьте сеть и повторите.' : Cab.rpcText(e));
  // В консоль уходит только код ошибки: ни текста сообщений, ни ключей
  const logErr = (where, e) => console.error('[chat]', where, e && (e.rpc || e.name) || 'error');

  // Время по Минску; дата нужна, если сообщение не сегодняшнее
  function stamp(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Cab.minsk(t), p = (n) => String(n).padStart(2, '0');
    return (m.iso === Cab.minsk().iso ? '' : Cab.dateShort(m.iso) + ', ') + `${p(m.hh)}:${p(m.mm)}`;
  }

  // Устройства собеседника, которые мы уже видели в этом треде (не секрет: только id). Изменились — показываем «ключ заменён».
  const seenKey = (tid) => 'j2_chat_peer_' + tid;
  const seenGet = (tid) => { try { return JSON.parse(lsGet(seenKey(tid), 'null')); } catch (_) { return null; } };
  const seenSet = (tid, ids) => lsSet(seenKey(tid), JSON.stringify(ids));

  // ---------- нижний лист («Сверить», «Начать заново») ----------
  let sh = null;
  function closeSheet() {
    if (!sh) return;
    const s = sh; sh = null;
    document.removeEventListener('keydown', s.k); s.el.remove();
    const c = document.getElementById('cab'); if (c) c.inert = false;
    if (s.prev && s.prev.isConnected) s.prev.focus();
  }
  function openSheet(title, body) {
    closeSheet();
    const el = document.createElement('div');
    el.className = 'cab-modal';
    el.innerHTML = str(h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="chSheetT"><h2 class="hm-sheet-h" id="chSheetT" tabindex="-1">${title}</h2>${body}</div>`);
    const k = (e) => { if (e.key === 'Escape') closeSheet(); };
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeSheet(); });
    document.addEventListener('keydown', k);
    sh = { el, k, prev: document.activeElement };
    const c = document.getElementById('cab'); if (c) c.inert = true;
    document.body.appendChild(el);
    $(el, '#chSheetT').focus();
    return el;
  }

  // ---------- жизненный цикл ----------
  let cur = null;
  function unmount() {
    const i = cur; if (!i) return;
    cur = null; i.dead = true;
    clearTimeout(i.timer);
    window.removeEventListener('hashchange', unmount);
    document.removeEventListener('visibilitychange', i.onVis);
    closeSheet();
    i.msgs = []; i.ks = null; i.drafts = {};           // расшифрованное забываем
  }

  async function mount(el, o) {
    unmount();
    o = o || {};
    const role = o.role === 'teacher' ? 'teacher' : 'headman';
    const inst = cur = { el, sb: o.sb || Cab.sb, ctx: o.ctx || Cab.ctx, role, start: o.startThread || null, dead: false, rows: [], sel: -1, gen: 0, tid: null, ks: null,
      msgs: [], seen: new Set(), cursor: null, drafts: {}, sending: false, polling: false, again: false, n: 0, timer: 0, netErr: false };
    inst.onVis = () => { if (!document.hidden) poll(inst); };
    window.addEventListener('hashchange', unmount);
    document.addEventListener('visibilitychange', inst.onVis);
    const ctx = inst.ctx, teacher = role === 'teacher';
    const back = o.back || (teacher ? { href: '#/home', text: 'Главная' } : { href: '#/summary', text: 'Сводка' });
    const right = o.right || (teacher ? 'Преподаватель' + (ctx.subjects && ctx.subjects.length ? ', ' + ctx.subjects.join(', ') : '') : (ctx.group && ctx.group.name) || '');
    el.innerHTML = str(h`${Cab.top(back, right)}<h1 class="cab-title">${o.title || (teacher ? 'Чат со старостами' : 'Чат')}</h1><div class="ch" id="chBody"></div>`);
    inst.box = $(el, '#chBody');
    await boot(inst);
  }

  // Ключ устройства создаётся сам при первом открытии (или берётся из IndexedDB): пользователю ничего вводить не нужно
  async function boot(inst) {
    put(inst.box, h`<p class="cab-load" role="status">Готовим шифрование на этом устройстве…</p>`);
    try {
      const C = window.ChatCrypto;
      if (!C) { fail(inst, new Error('no_crypto'), 'Не загрузился модуль шифрования. Обновите страницу.'); return; }
      await C.init(inst.sb, inst.ctx.uid);
      if (inst.dead) return;
      await openChat(inst);
    } catch (e) { if (!inst.dead) fail(inst, e); }
  }

  function fail(inst, e, text) {
    logErr('boot', e);
    put(inst.box, h`<div class="j2-card bad"><h2>Чат недоступен</h2><p>${text || errTextLoad(e)}</p></div><button class="j2-btn" id="chRetry" type="button">Повторить</button>`);
    $(inst.box, '#chRetry').onclick = () => boot(inst);
  }
  // Это устройство отозвано «начать заново» с другого устройства: заводим новый ключ и открываем заново
  const revoked = (e) => code(e).includes('device_revoked');

  // =====================================================================================================
  // Экран чата
  // =====================================================================================================
  const rowLabel = (inst, r, rows) => {
    const base = inst.role === 'headman' ? KINDS[r.kind] || 'Чат' : r.group_name || 'Группа';
    const dup = rows.filter((x) => (inst.role === 'headman' ? KINDS[x.kind] : x.group_name) === (inst.role === 'headman' ? KINDS[r.kind] : r.group_name)).length > 1;
    const name = dup ? (inst.role === 'headman' ? `${base}, ${r.peer_name}` : r.peer_name || base) : base;
    const n = Number(r.unread) || 0;
    return n > 0 ? `${name}, ${n} ${plural(n, ['новое', 'новых', 'новых'])}` : name;
  };

  async function openChat(inst) {
    const rows = await Cab.rpc('chat_threads_my');
    if (inst.dead) return;
    const ord = (r) => (r.kind === 'lecture' ? 0 : 1);
    inst.rows = (rows || []).filter((r) => inst.role === 'teacher' || KINDS[r.kind])
      .sort((a, b) => (inst.role === 'headman' ? ord(a) - ord(b) : String(a.group_name).localeCompare(String(b.group_name), 'ru') || ord(a) - ord(b)));
    inst.gen++; inst.sel = -1; inst.tid = null; inst.ks = null;
    clearTimeout(inst.timer);
    if (!inst.rows.length) {
      put(inst.box, h`<div class="cab-card"><h3>${inst.role === 'headman' ? 'Преподаватели не назначены' : 'Переписок пока нет'}</h3><p>${inst.role === 'headman' ? 'Когда сисадмин назначит преподавателей группы, здесь появятся вкладки «Лекции» и «ПЗ».' : 'Они появятся, когда староста группы откроет чат с вами.'}</p></div>`);
      inst.timer = setTimeout(() => { if (!inst.dead && inst.box.isConnected) openChat(inst).catch(() => {}); }, 15000);   // вдруг переписка уже открыта
      return;
    }
    const teacher = inst.role === 'teacher';
    put(inst.box, h`
      ${inst.ctx.closed ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт</h2><p>Переписку можно читать, отправлять сообщения нельзя.</p></div>` : ''}
      <div id="chTabs"></div>
      <div class="ch-enc" id="chEnc"></div>
      <div id="chNote"></div>
      <div class="ch-list" id="chList" role="log" aria-live="polite" aria-label="Сообщения"></div>
      <div class="ch-compose">
        <div class="j2-msg err" id="chErr" role="alert"></div>
        ${teacher ? h`<div class="ch-chips">${QUICK.map((q) => h`<button type="button" class="ch-chip" data-t="${q[1]}">${q[0]}</button>`)}</div>` : ''}
        <div class="ch-row"><textarea id="chIn" rows="1" maxlength="${MAX}" placeholder="Сообщение" aria-label="Сообщение" autocomplete="off" enterkeyhint="send"></textarea><button type="button" class="ch-send" id="chSend" aria-label="Отправить">${Cab.raw(SEND)}</button></div>
        <div class="ch-cnt" id="chCnt" aria-live="off"></div>
      </div>`);
    const b = inst.box, ta = $(b, '#chIn');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    inst.grow = grow;
    ta.oninput = () => { grow(); counter(inst); if (!inst.netErr) setErr(inst, ''); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(inst); } };
    $(b, '#chSend').onclick = () => send(inst);
    b.querySelectorAll('.ch-chip').forEach((c) => { c.onclick = () => { ta.value = ta.value ? ta.value.replace(/\s+$/, '') + '\n' + c.dataset.t : c.dataset.t; grow(); counter(inst); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }; });
    let i = 0;
    if (inst.start) { const k = inst.rows.findIndex((r) => r.thread_id === inst.start || r.group_id === inst.start); if (k >= 0) i = k; }
    else { const k = inst.rows.findIndex((r) => Number(r.unread) > 0); if (k >= 0) i = k; }
    inst.start = null;
    await selectTab(inst, i);
    tick(inst);
    approveOthers(inst);
  }

  // Прежнее устройство подтверждает новые устройства этого же аккаунта во всех тредах, не только в открытом
  async function approveOthers(inst) {
    for (const r of inst.rows.slice()) {
      if (inst.dead) return;
      if (!r.thread_id || r === inst.rows[inst.sel]) continue;
      try { await window.ChatCrypto.open(r.thread_id); } catch (e) { /* не страшно: подтвердим при открытии вкладки */ }
    }
  }

  function paintTabs(inst) {
    const el = $(inst.box, '#chTabs'); if (!el) return;
    Cab.segmented(el, inst.rows.map((r, i) => ({ value: String(i), label: rowLabel(inst, r, inst.rows) })), String(inst.sel), (v) => selectTab(inst, Number(v)));
    el.classList.add('ch-tabs');
  }
  function setErr(inst, text) { const e = $(inst.box, '#chErr'); if (e) e.textContent = text || ''; }
  function counter(inst) {
    const ta = $(inst.box, '#chIn'), c = $(inst.box, '#chCnt'); if (!ta || !c) return;
    c.textContent = ta.value.length >= NEAR ? `${ta.value.length} из ${MAX}` : '';
  }
  const status = (inst) => (inst.ks ? inst.ks.status : null);
  // Поле и кнопка доступны, когда ключ треда есть на этом устройстве и журнал открыт
  function composer(inst) {
    const ta = $(inst.box, '#chIn'), btn = $(inst.box, '#chSend'); if (!ta) return;
    const s = status(inst);
    const why = inst.ctx.closed ? 'Журнал закрыт' : !s ? 'Загружаем…' : s === 'no_peer' ? 'Собеседник ещё не открывал чат' : s === 'waiting' ? 'Ждём подтверждения этого устройства' : '';
    ta.disabled = !!why; btn.disabled = !!why || inst.sending; ta.placeholder = why || 'Сообщение';
    const chips = inst.box.querySelectorAll('.ch-chip'); chips.forEach((c) => { c.disabled = !!why; });
  }

  function paintEnc(inst) {
    const enc = $(inst.box, '#chEnc'); if (!enc) return;
    const ks = inst.ks, fp = ks && ks.status !== 'no_peer' ? ks.fingerprint : null;
    put(enc, h`<span class="cab-ico sm">${icon.lock}</span><span class="ch-fp">${fp ? h`Сквозное шифрование, ключ <span class="ch-fpb">${fp}</span>` : 'Сквозное шифрование'}</span>${ks ? h`<button type="button" class="ch-ver" id="chVer">Сверить</button>` : ''}`);
    const v = $(enc, '#chVer');
    if (v) v.onclick = () => verifySheet(inst);
    paintNote(inst);
  }

  function verifySheet(inst) {
    const ks = inst.ks, r = inst.rows[inst.sel], n = (x) => `${x} ${plural(x, ['устройство', 'устройства', 'устройств'])}`;
    const el = openSheet('Сверить ключ', h`
      ${ks.status === 'no_peer' ? h`<p class="cab-note">Собеседник ещё не открывал чат: сверять пока нечего.</p>` : h`<div class="j2-code ch-code" role="status">${ks.fingerprint}</div>
      <p class="cab-note">${r && r.peer_name ? 'Собеседник: ' + r.peer_name + '. ' : ''}Сравните этот отпечаток с собеседником вне журнала, например по телефону. Если он не совпадает, ничего важного не отправляйте.</p>
      <p class="cab-note">В переписке: у вас ${n(ks.my_devices.length)}, у собеседника ${n(ks.peer_devices.length)}. Новое устройство меняет отпечаток.</p>`}
      <button class="j2-btn primary" type="button" id="chShDone">Готово</button>
      <button class="j2-btn link" type="button" id="chShReset">Начать заново на этом устройстве</button>`);
    $(el, '#chShDone').onclick = closeSheet;
    $(el, '#chShReset').onclick = () => resetSheet(inst);
  }

  // «Начать заново»: прежние устройства отзываются, переписка до этого момента на этом устройстве не откроется
  function resetSheet(inst) {
    const el = openSheet('Начать заново?', h`<div class="cab-card coral"><p>Ваши другие устройства потеряют доступ к чату. Сообщения, которых нет на этом устройстве, прочитать будет нельзя. Собеседник увидит, что ваш ключ заменён.</p></div>
      <p class="cab-note">Нужно, если прежнее устройство потеряно или его данные стёрты. Если оно под рукой, просто откройте на нём чат: это устройство получит доступ само.</p>
      <div class="j2-msg err" id="chShMsg" role="alert"></div>
      <button class="j2-btn danger" type="button" id="chShGo">Начать заново</button><button class="j2-btn" type="button" id="chShNo">Отмена</button>`);
    $(el, '#chShNo').onclick = closeSheet;
    const go = $(el, '#chShGo');
    go.onclick = () => J2.busy(go, async () => {
      try { await window.ChatCrypto.reset(); }
      catch (e) { logErr('reset', e); $(el, '#chShMsg').textContent = errTextLoad(e); return; }
      closeSheet();
      if (!inst.dead) await selectTab(inst, inst.sel);
    });
  }

  // Под строкой шифрования: устройство ждёт подтверждения / ключ собеседника заменён
  function paintNote(inst) {
    const box = $(inst.box, '#chNote'); if (!box) return;
    const ks = inst.ks, tid = inst.tid;
    if (ks && ks.status === 'waiting') {
      put(box, h`<div class="cab-card amber ch-note" role="status"><h3>Ждём подтверждения этого устройства</h3>
        <p>Откройте чат журнала на устройстве, где вы уже переписывались: оно само передаст ключи, пароль не нужен. Это окно обновится.</p>
        <div class="cab-actions"><button class="j2-btn" type="button" id="chNoteReset">Нет доступа к прежнему устройству</button></div></div>`);
      $(box, '#chNoteReset').onclick = () => resetSheet(inst);
      return;
    }
    const old = tid && ks && ks.status !== 'no_peer' ? seenGet(tid) : null;
    const now = ks ? ks.peer_devices : [];
    if (!old || !Array.isArray(old) || !now.length || old.slice().sort().join() === now.join()) {
      if (tid && ks && ks.status !== 'no_peer' && (!old || !Array.isArray(old))) seenSet(tid, now);   // первая встреча: запоминаем молча
      put(box, '');
      return;
    }
    const added = old.every((id) => now.includes(id));
    put(box, h`<div class="cab-card coral ch-note" role="status"><h3>${added ? 'У собеседника новое устройство' : 'Ключ собеседника заменён'}</h3>
      <p>Новый отпечаток: <b class="ch-fpb">${ks.fingerprint}</b>. ${added ? 'Если собеседник не входил с нового устройства, ' : 'Собеседник мог сменить телефон или очистить браузер. Если сомневаетесь, '}сверьте отпечаток с ним по телефону.</p>
      <div class="cab-actions"><button class="j2-btn" type="button" id="chNoteOk">Понятно</button></div></div>`);
    $(box, '#chNoteOk').onclick = () => { seenSet(tid, now); put(box, ''); };
  }

  async function selectTab(inst, i) {
    const old = inst.sel, ta = $(inst.box, '#chIn');
    if (ta && old >= 0 && old !== i) inst.drafts[old] = ta.value;
    inst.sel = i; const my = ++inst.gen;
    inst.tid = null; inst.ks = null; inst.msgs = []; inst.seen = new Set(); inst.cursor = null; inst.netErr = false;
    if (ta) { ta.value = inst.drafts[i] || ''; inst.grow(); counter(inst); }
    setErr(inst, '');
    paintTabs(inst); composer(inst);
    put($(inst.box, '#chList'), h`<p class="cab-load" role="status">Открываем переписку…</p>`);
    put($(inst.box, '#chEnc'), h`<span class="cab-ico sm">${icon.lock}</span><span class="ch-fp">Ключ создаётся…</span>`);
    put($(inst.box, '#chNote'), '');
    const r = inst.rows[i];
    try {
      if (!r.thread_id) r.thread_id = await Cab.rpc('chat_thread_open', { p_group: r.group_id, p_teacher: r.peer_user_id });
      if (inst.dead || my !== inst.gen) return;
      const ks = await window.ChatCrypto.open(r.thread_id);
      if (inst.dead || my !== inst.gen) return;
      inst.tid = r.thread_id; inst.ks = ks;
      paintEnc(inst);
      if (ks.status !== 'no_peer') await loadMsgs(inst, my); else paintList(inst, true);
      if (inst.dead || my !== inst.gen) return;
      composer(inst);
    } catch (e) {
      if (inst.dead || my !== inst.gen) return;
      if (revoked(e)) { boot(inst); return; }
      logErr('open', e);
      put($(inst.box, '#chList'), h`<div class="cab-card"><h3>Не получилось открыть чат</h3><p>${errTextLoad(e)}</p><div class="cab-actions"><button class="j2-btn" id="chAgain" type="button">Повторить</button></div></div>`);
      $(inst.box, '#chAgain').onclick = () => selectTab(inst, i);
    }
  }

  // Первая загрузка: последние 200 сообщений
  async function loadMsgs(inst, my) {
    const r = inst.rows[inst.sel];
    const rows = await Cab.q(inst.sb.from('chat_messages').select(COLS).eq('thread_id', r.thread_id).order('created_at', { ascending: false }).limit(200));
    if (inst.dead || my !== inst.gen) return;
    rows.reverse();
    await addMsgs(inst, rows, true);
    if (inst.dead || my !== inst.gen) return;
    if (!rows.length) paintList(inst, true);
    if (rows.some((m) => m.sender_id !== inst.ctx.uid) || Number(r.unread) > 0) markRead(inst);
  }

  // Расшифровать новые строки и дорисовать; true, если среди них есть чужие
  async function addMsgs(inst, rows, stick) {
    const C = window.ChatCrypto, uid = inst.ctx.uid, tid = inst.tid, gen = inst.gen;
    let peer = false, added = false;
    for (const m of rows) {
      if (inst.seen.has(m.id)) continue;
      inst.seen.add(m.id);
      let text = null;
      try { text = await C.decrypt(tid, m); } catch (e) { text = null; }
      if (inst.dead || inst.gen !== gen) return false;
      inst.msgs.push({ id: m.id, mine: m.sender_id === uid, text: typeof text === 'string' ? text : null, at: m.created_at });
      if (!inst.cursor || m.created_at > inst.cursor) inst.cursor = m.created_at;
      added = true; if (m.sender_id !== uid) peer = true;
    }
    if (added) paintList(inst, stick);
    return peer;
  }

  function paintList(inst, stick) {
    const list = $(inst.box, '#chList'); if (!list) return;
    const near = stick || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
    const r = inst.rows[inst.sel] || {}, who = r.peer_name || 'Собеседник', s = status(inst);
    const gone = s === 'waiting' ? 'Сообщение откроется, когда устройство подтвердят' : 'Сообщение недоступно на этом устройстве: ключ был заменён';
    put(list, inst.msgs.length ? inst.msgs.map((m) => h`<div class="ch-m ${m.mine ? 'me' : 'pe'}"><div class="ch-b ${m.text == null ? 'bad' : ''}">${m.text == null ? gone : m.text}</div><small class="ch-t">${m.mine ? 'Вы' : who}, ${stamp(m.at)}</small></div>`)
      : h`<p class="cab-empty">${s === 'no_peer' ? 'Собеседник ещё не открывал чат. Как только он его откроет, здесь можно будет писать.' : 'Сообщений пока нет. Текст шифруется на вашем устройстве.'}</p>`);
    if (near) setTimeout(() => { if (!inst.dead) window.scrollTo(0, document.documentElement.scrollHeight); }, 0);   // после scrollTo(0,0) роутера
  }

  async function markRead(inst) {
    const r = inst.rows[inst.sel];
    if (inst.dead || !r || !r.thread_id || document.hidden) return;
    try { await Cab.rpc('chat_mark_read', { p_thread: r.thread_id }); r.unread = 0; paintTabs(inst); }
    catch (e) { /* не страшно: отметим при следующем опросе */ }
  }

  // ---------- опрос ----------
  function tick(inst) {
    if (inst.dead) return;
    if (!inst.box.isConnected) { if (cur === inst) unmount(); return; }
    inst.timer = setTimeout(async () => { inst.n++; await poll(inst, inst.n % SLOW === 0); tick(inst); }, POLL_MS);
  }

  async function poll(inst, slow) {
    if (inst.dead || document.hidden || inst.sel < 0 || !inst.ks) return;
    if (inst.polling) { inst.again = true; return; }
    inst.polling = true;
    const my = inst.gen;
    try {
      do {
        inst.again = false;
        if (slow || status(inst) !== 'ready') { await refresh(inst, my); slow = false; }
        if (inst.dead || my !== inst.gen) return;
        if (status(inst) !== 'no_peer') {
          const r = inst.rows[inst.sel];
          let q = inst.sb.from('chat_messages').select(COLS).eq('thread_id', r.thread_id).order('created_at', { ascending: true }).limit(200);
          if (inst.cursor) q = q.gt('created_at', new Date(Date.parse(inst.cursor) - 2000).toISOString());   // запас 2 с: поздно появившиеся строки не теряем, дубли отсекает seen
          const rows = await Cab.q(q);
          if (inst.dead || my !== inst.gen) return;
          if (await addMsgs(inst, rows, false)) markRead(inst);
        }
        if (inst.netErr) { inst.netErr = false; setErr(inst, ''); }
      } while (inst.again);
    } catch (e) {
      if (revoked(e)) { if (!inst.dead) boot(inst); return; }
      if (!inst.dead && !inst.netErr) { inst.netErr = true; setErr(inst, 'Нет связи. Пробуем снова…'); }
    } finally { inst.polling = false; }
  }

  // Сверка ключей (заодно подтверждает свои новые устройства) и счётчиков на вкладках; сменилась эпоха, статус или
  // устройства — перерисовываем, а ключи новых эпох могли открыть старые сообщения: перечитываем тред
  async function refresh(inst, my) {
    const r = inst.rows[inst.sel];
    const [ks, all] = await Promise.all([window.ChatCrypto.open(r.thread_id), Cab.rpc('chat_threads_my').catch(() => null)]);
    if (inst.dead || my !== inst.gen) return;
    if (all) {
      all.forEach((x) => { const y = inst.rows.find((z) => z.thread_id && z.thread_id === x.thread_id); if (y) y.unread = y === r ? 0 : x.unread; });
      if (inst.role === 'teacher') inst.rows.push(...all.filter((x) => x.thread_id && !inst.rows.some((z) => z.thread_id === x.thread_id)));   // староста открыл новую переписку
      paintTabs(inst);
    }
    const was = inst.ks, sig = (k) => [k.status, k.epoch, k.fingerprint].join('|');
    inst.ks = ks;
    if (sig(was) !== sig(ks)) {
      paintEnc(inst);
      if (was.status !== ks.status || was.epoch !== ks.epoch) {
        inst.msgs = []; inst.seen = new Set(); inst.cursor = null;
        if (ks.status !== 'no_peer') await loadMsgs(inst, my); else paintList(inst, true);
      }
      composer(inst);
    }
  }

  // ---------- отправка ----------
  async function send(inst) {
    if (inst.dead || inst.sending || status(inst) !== 'ready' || inst.ctx.closed) return;
    const ta = $(inst.box, '#chIn'), btn = $(inst.box, '#chSend');
    const text = ta.value.trim();
    if (!text) return;
    setErr(inst, ''); inst.netErr = false;
    inst.sending = true; btn.disabled = true;
    const tid = inst.tid, my = inst.gen;
    let ok = false;
    try {
      const enc = await window.ChatCrypto.encrypt(tid, text);
      await Cab.rpc('chat_post', { p_thread: tid, p_device: enc.device, p_epoch: enc.epoch, p_iv: enc.iv, p_ciphertext: enc.ciphertext });
      ok = true;
    } catch (e) {
      logErr('send', e);
      if (!inst.dead) {
        if (revoked(e)) { inst.sending = false; boot(inst); return; }
        setErr(inst, errText(e));
        if (/key_changed|not_ready/.test(code(e))) refresh(inst, my).catch(() => {});      // следующая попытка уже с новым ключом
      }
    }
    inst.sending = false;
    if (inst.dead) return;
    if (ok && my === inst.gen) { ta.value = ''; inst.grow(); counter(inst); inst.drafts[inst.sel] = ''; }
    composer(inst);
    if (ok) { ta.focus(); await poll(inst); paintList(inst, true); }
  }

  // Сумма непрочитанных по всем тредам (для значков); ошибка запроса — исключение, вызывающий решает, что показать
  async function unreadTotal(sb) {
    const { data, error } = await (sb || Cab.sb).rpc('chat_threads_my');
    if (error) throw new Error(error.message || 'chat_threads_my');
    return (data || []).reduce((n, r) => n + (Number(r.unread) || 0), 0);
  }

  window.ChatUI = { mount, unmount, unreadTotal };
})();
