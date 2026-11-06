// «Журнал 2.0», этап 4: экран чата со сквозным шифрованием, общий для кабинета старосты и преподавателя.
// Подключается после cab-core.js и chat-crypto.js. ChatUI.mount(el, { sb, ctx, role: 'headman'|'teacher', startThread, back, title, right }).
// Шифрует и расшифровывает ChatCrypto прямо в браузере; расшифрованный текст живёт только в памяти экрана
// (не в localStorage, не в адресе, не в console). Права проверяет сервер (RLS и RPC), страница лишь показывает.
'use strict';
(function () {
  const { h, str, plural, icon } = Cab;
  const KINDS = { lecture: 'Лекции', practice: 'ПЗ' };
  const MAX = 2000, NEAR = 1800;           // длина сообщения, с какой длины показываем счётчик
  const POLL_MS = 4000, SLOW = 4;          // опрос новых сообщений; каждый 4-й опрос ещё сверяет ключи и счётчики
  const QUICK = [['Перенос пары', 'Перенос пары: '], ['Другая аудитория', 'Пара пройдёт в другой аудитории: '], ['Новое задание', 'Новое задание: ']];
  const COLS = 'id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext, created_at';
  const SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="24" height="24"><path d="M21 3L3 10l7 3 3 7z"/><path d="M21 3L10 13"/></svg>';
  const $ = (r, s) => r.querySelector(s);
  const put = (el, html) => { if (el) el.innerHTML = str(html); };
  const code = (e) => String((e && (e.rpc || e.message)) || '');

  // Ошибка человеческим языком (коды из raise exception в RPC)
  function errText(e) {
    const c = code(e);
    if (c.includes('key_changed')) return 'Собеседник заменил ключ. Обновите страницу и повторите.';
    if (c.includes('rate_limited')) return 'Слишком много сообщений. Подождите минуту и повторите.';
    if (c.includes('too_long')) return 'Сообщение слишком длинное. Сократите его.';
    if (!navigator.onLine || /fetch|network|load failed/i.test(c)) return 'Нет связи. Сообщение не отправлено: повторите, когда появится сеть.';
    return Cab.rpcText(e);
  }
  const errTextLoad = (e) => (/fetch|network|load failed/i.test(code(e)) || !navigator.onLine ? 'Нет связи. Проверьте сеть и повторите.' : Cab.rpcText(e));
  // В консоль уходит только код ошибки: ни текста сообщений, ни паролей, ни ключей
  const logErr = (where, e) => console.error('[chat]', where, e && (e.rpc || e.name) || 'error');

  // Время по Минску; дата нужна, если сообщение не сегодняшнее
  function stamp(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Cab.minsk(t), p = (n) => String(n).padStart(2, '0');
    return (m.iso === Cab.minsk().iso ? '' : Cab.dateShort(m.iso) + ', ') + `${p(m.hh)}:${p(m.mm)}`;
  }

  // ---------- нижний лист («Сверить») ----------
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
    i.msgs = []; i.thread = null; i.drafts = {};           // расшифрованное забываем
  }

  async function mount(el, o) {
    unmount();
    o = o || {};
    const role = o.role === 'teacher' ? 'teacher' : 'headman';
    const inst = cur = { el, sb: o.sb || Cab.sb, ctx: o.ctx || Cab.ctx, role, start: o.startThread || null, dead: false, rows: [], sel: -1, gen: 0, thread: null, peerReady: false,
      myKv: null, msgs: [], seen: new Set(), cursor: null, drafts: {}, sending: false, polling: false, again: false, n: 0, timer: 0, netErr: false };
    inst.onVis = () => { if (!document.hidden) poll(inst); };
    window.addEventListener('hashchange', unmount);
    document.addEventListener('visibilitychange', inst.onVis);
    const ctx = inst.ctx, teacher = role === 'teacher';
    const back = o.back || (teacher ? { href: '#/home', text: 'Главная' } : { href: '#/summary', text: 'Сводка' });
    const right = o.right || (teacher ? 'Преподаватель' + (ctx.subjects && ctx.subjects.length ? ', ' + ctx.subjects.join(', ') : '') : (ctx.group && ctx.group.name) || '');
    el.innerHTML = str(h`${Cab.top(back, right)}<h1 class="cab-title">${o.title || (teacher ? 'Чат со старостами' : 'Чат')}</h1><div class="ch" id="chBody"></div>`);
    inst.box = $(el, '#chBody');
    put(inst.box, h`<p class="cab-load">Загружаем…</p>`);
    await boot(inst);
  }

  async function boot(inst) {
    try {
      const C = window.ChatCrypto;
      if (!C) { fail(inst, new Error('no_crypto'), 'Не загрузился модуль шифрования. Обновите страницу.'); return; }
      const { state } = await C.init(inst.sb, inst.ctx.uid);
      if (inst.dead) return;
      if (state === 'ready') await openChat(inst); else gate(inst, state === 'locked' ? 'locked' : 'none');
    } catch (e) { if (!inst.dead) fail(inst, e); }
  }

  function fail(inst, e, text) {
    logErr('boot', e);
    put(inst.box, h`<div class="j2-card bad"><h2>Чат недоступен</h2><p>${text || errTextLoad(e)}</p></div><button class="j2-btn" id="chRetry" type="button">Повторить</button>`);
    $(inst.box, '#chRetry').onclick = () => { put(inst.box, h`<p class="cab-load">Загружаем…</p>`); boot(inst); };
  }

  // =====================================================================================================
  // Ключи: создать пароль, ввести пароль, сброс
  // =====================================================================================================
  function gate(inst, mode) {
    const none = mode === 'none', locked = mode === 'locked', reset = mode === 'reset';
    put(inst.box, h`
      <div class="cab-card ${reset ? 'coral' : 'ch-violet'}"><h3>${none ? 'Защитите переписку' : locked ? 'Чат закрыт на этом устройстве' : 'Старая переписка пропадёт'}</h3>
        <p>${none ? 'Сообщения шифруются на вашем устройстве: сервер и администраторы их прочитать не могут.' : locked ? 'Введите пароль переписки, чтобы открыть чат на этом устройстве.'
          : 'Новый пароль создаст новые ключи. Прежние сообщения станут нечитаемыми для вас и для собеседника, он увидит, что ключ заменён. Отменить это нельзя.'}</p></div>
      ${none ? h`<div class="cab-card amber"><p>Без этого пароля старые сообщения на новом устройстве не открыть. Запомните его.</p></div>` : ''}
      <label class="j2-field"><span>${reset ? 'Новый пароль переписки' : 'Пароль переписки'}</span><input id="chPw" type="password" autocomplete="${locked ? 'current-password' : 'new-password'}"></label>
      ${locked ? '' : h`<label class="j2-field"><span>Повторите пароль</span><input id="chPw2" type="password" autocomplete="new-password"></label>`}
      ${locked ? '' : h`<p class="cab-note">Минимум 8 символов. Можно тот же, что для входа в журнал.</p>`}
      <div class="j2-msg err" id="chMsg" role="alert"></div>
      <button class="j2-btn ${reset ? 'danger' : 'primary'}" id="chGo" type="button">${none ? 'Создать ключи' : locked ? 'Открыть чат' : 'Сбросить и создать новые ключи'}</button>
      ${locked ? h`<button class="j2-btn link" id="chForgot" type="button">Забыл пароль</button>` : ''}
      ${reset ? h`<button class="j2-btn" id="chBack" type="button">Назад</button>` : ''}`);
    const b = inst.box, pw = $(b, '#chPw'), pw2 = $(b, '#chPw2'), msg = $(b, '#chMsg'), go = $(b, '#chGo');
    if ($(b, '#chForgot')) $(b, '#chForgot').onclick = () => gate(inst, 'reset');
    if ($(b, '#chBack')) $(b, '#chBack').onclick = () => gate(inst, 'locked');
    const submit = () => J2.busy(go, async () => {
      msg.textContent = '';
      const p1 = pw.value, p2 = pw2 ? pw2.value : p1;
      if (!p1) { msg.textContent = 'Введите пароль переписки.'; return; }
      if (!locked && p1.length < 8) { msg.textContent = 'Пароль переписки: минимум 8 символов.'; return; }
      if (p1 !== p2) { msg.textContent = 'Пароли не совпадают.'; return; }
      const label = go.textContent; go.textContent = 'Подождите…';
      const C = window.ChatCrypto;
      try { await (none ? C.setup(p1) : locked ? C.unlock(p1) : C.reset(p1)); }
      catch (e) {
        const c = String((e && (e.message || e.code)) || '') + code(e);
        msg.textContent = c.includes('bad_password') ? 'Неверный пароль переписки.' : c.includes('key_mismatch') || c.includes('already_exists') ? 'Ключи уже созданы на другом устройстве. Обновите страницу и введите пароль.'
          : !navigator.onLine ? 'Нет связи. Повторите, когда появится сеть.' : 'Не получилось. Проверьте связь и повторите.';
        if (!/bad_password/.test(c)) logErr('keys', e);
        return;
      } finally { go.textContent = label; }
      pw.value = ''; if (pw2) pw2.value = '';
      if (inst.dead) return;
      try { await openChat(inst); } catch (e) { fail(inst, e); }
    });
    go.onclick = submit;
    [pw, pw2].forEach((x) => { if (x) x.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }; });
    pw.focus();
  }

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
    const [mine, rows] = await Promise.all([
      Cab.q(inst.sb.from('chat_keys').select('key_version').eq('user_id', inst.ctx.uid)),
      Cab.rpc('chat_threads_my'),
    ]);
    if (inst.dead) return;
    inst.myKv = mine[0] ? mine[0].key_version : null;
    const ord = (r) => (r.kind === 'lecture' ? 0 : 1);
    inst.rows = (rows || []).filter((r) => inst.role === 'teacher' || KINDS[r.kind])
      .sort((a, b) => (inst.role === 'headman' ? ord(a) - ord(b) : String(a.group_name).localeCompare(String(b.group_name), 'ru') || ord(a) - ord(b)));
    inst.gen++; inst.sel = -1; inst.thread = null; inst.peerReady = false;
    clearTimeout(inst.timer);
    if (!inst.rows.length) {
      put(inst.box, h`<div class="cab-card"><h3>${inst.role === 'headman' ? 'Преподаватели не назначены' : 'Переписок пока нет'}</h3><p>${inst.role === 'headman' ? 'Когда сисадмин назначит преподавателей группе, здесь появятся вкладки «Лекции» и «ПЗ».' : 'Они появятся, когда староста группы откроет чат с вами.'}</p></div>`);
      inst.timer = setTimeout(() => { if (!inst.dead && inst.box.isConnected) openChat(inst).catch(() => {}); }, 15000);   // вдруг переписка уже открыта
      return;
    }
    const teacher = inst.role === 'teacher';
    put(inst.box, h`
      ${inst.ctx.closed ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт</h2><p>Переписку можно читать, отправлять сообщения нельзя.</p></div>` : ''}
      <div id="chTabs"></div>
      <div class="ch-enc" id="chEnc"></div>
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
  // Поле и кнопка доступны, когда есть ключ собеседника и журнал открыт
  function composer(inst) {
    const ta = $(inst.box, '#chIn'), btn = $(inst.box, '#chSend'); if (!ta) return;
    const why = inst.ctx.closed ? 'Журнал закрыт' : !inst.thread ? 'Загружаем…' : !inst.peerReady ? 'Собеседник ещё не включил шифрование' : '';
    ta.disabled = !!why; btn.disabled = !!why || inst.sending; ta.placeholder = why || 'Сообщение';
    const chips = inst.box.querySelectorAll('.ch-chip'); chips.forEach((c) => { c.disabled = !!why; });
  }

  async function paintEnc(inst) {
    const enc = $(inst.box, '#chEnc'); if (!enc) return;
    let fp = null;
    if (inst.peerReady) { try { fp = await window.ChatCrypto.fingerprint(inst.thread); } catch (e) { logErr('fp', e); } }
    if (inst.dead || !enc.isConnected) return;
    inst.fp = fp;
    put(enc, h`<span class="cab-ico sm">${icon.lock}</span><span class="ch-fp">${fp ? 'Сквозное шифрование, ключ ' + fp : 'Сквозное шифрование. Ключ собеседника ещё не создан'}</span>${fp ? h`<button type="button" class="ch-ver" id="chVer">Сверить</button>` : ''}`);
    const v = $(enc, '#chVer');
    if (v) v.onclick = () => {
      const r = inst.rows[inst.sel];
      const el = openSheet('Сверить ключ', h`<div class="j2-code" role="status">${fp}</div><p class="cab-note">${r && r.peer_name ? 'Собеседник: ' + r.peer_name + '. ' : ''}Сравните этот отпечаток с собеседником вне журнала, например по телефону. Если он не совпадает, ничего важного не отправляйте.</p><button class="j2-btn primary" type="button" id="chShDone">Готово</button>`);
      $(el, '#chShDone').onclick = closeSheet;
    };
  }

  // Ключ собеседника: объект или null, если он ещё не создал ключи
  async function peerKey(r) {
    let k;
    try { k = await Cab.rpc('chat_peer_key', { p_thread: r.thread_id }); }
    catch (e) { if (/key/.test(e.rpc || '') && !/key_changed/.test(e.rpc)) return null; throw e; }
    if (Array.isArray(k)) k = k[0];
    return k && k.public_jwk ? k : null;
  }
  // Собрать thread для ChatCrypto; true, если версии ключей изменились
  function applyKeys(inst, r, k, myKv) {
    const was = inst.thread ? `${inst.peerReady ? inst.thread.peer.key_version : '-'}|${inst.thread.my_key_version}` : '';
    inst.myKv = myKv;
    inst.peerReady = !!k;
    inst.thread = { id: r.thread_id, me: { id: inst.ctx.uid }, peer: { id: (k && k.user_id) || r.peer_user_id, public_jwk: k ? k.public_jwk : null, key_version: k ? k.key_version : null }, my_key_version: myKv };
    return was !== `${inst.peerReady ? k.key_version : '-'}|${myKv}`;
  }
  const myVersion = async (inst) => { const m = await Cab.q(inst.sb.from('chat_keys').select('key_version').eq('user_id', inst.ctx.uid)); return m[0] ? m[0].key_version : null; };

  async function selectTab(inst, i) {
    const old = inst.sel, ta = $(inst.box, '#chIn');
    if (ta && old >= 0) inst.drafts[old] = ta.value;
    inst.sel = i; const my = ++inst.gen;
    inst.thread = null; inst.peerReady = false; inst.msgs = []; inst.seen = new Set(); inst.cursor = null; inst.netErr = false;
    if (ta) { ta.value = inst.drafts[i] || ''; inst.grow(); counter(inst); }
    setErr(inst, '');
    paintTabs(inst); composer(inst);
    put($(inst.box, '#chList'), h`<p class="cab-load">Загружаем…</p>`);
    put($(inst.box, '#chEnc'), h`<span class="cab-ico sm">${icon.lock}</span><span class="ch-fp">Сквозное шифрование</span>`);
    const r = inst.rows[i];
    try {
      if (!r.thread_id) r.thread_id = await Cab.rpc('chat_thread_open', { p_group: r.group_id, p_teacher: r.peer_user_id });
      if (inst.dead || my !== inst.gen) return;
      const [k, kv] = await Promise.all([peerKey(r), myVersion(inst)]);
      if (inst.dead || my !== inst.gen) return;
      applyKeys(inst, r, k, kv);
      await paintEnc(inst);
      if (inst.peerReady) await loadMsgs(inst, my);
      if (inst.dead || my !== inst.gen) return;
      composer(inst);
      if (!inst.peerReady) paintList(inst, true);
    } catch (e) {
      if (inst.dead || my !== inst.gen) return;
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
    const C = window.ChatCrypto, uid = inst.ctx.uid, thread = inst.thread;
    let peer = false, added = false;
    for (const m of rows) {
      if (inst.seen.has(m.id)) continue;
      inst.seen.add(m.id);
      let text = null;
      try { text = await C.decrypt(thread, m); } catch (e) { text = null; }
      if (inst.dead || inst.thread !== thread) return false;
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
    const r = inst.rows[inst.sel] || {}, who = r.peer_name || 'Собеседник';
    put(list, inst.msgs.length ? inst.msgs.map((m) => h`<div class="ch-m ${m.mine ? 'me' : 'pe'}"><div class="ch-b ${m.text == null ? 'bad' : ''}">${m.text == null ? 'Сообщение недоступно: ключ был заменён' : m.text}</div><small class="ch-t">${m.mine ? 'Вы' : who}, ${stamp(m.at)}</small></div>`)
      : h`<p class="cab-empty">${inst.peerReady ? 'Сообщений пока нет. Текст шифруется на вашем устройстве.' : 'Собеседник ещё не включил шифрование. Как только он это сделает, здесь можно будет писать.'}</p>`);
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
    if (inst.dead || document.hidden || inst.sel < 0 || !inst.thread) return;
    if (inst.polling) { inst.again = true; return; }
    inst.polling = true;
    const my = inst.gen;
    try {
      do {
        inst.again = false;
        if (slow || !inst.peerReady) { await refresh(inst, my); slow = false; }
        if (inst.dead || my !== inst.gen) return;
        if (inst.peerReady) {
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
      if (!inst.dead && !inst.netErr) { inst.netErr = true; setErr(inst, 'Нет связи. Пробуем снова…'); }
    } finally { inst.polling = false; }
  }

  // Сверка ключей и счётчиков на вкладках; сменился ключ: перечитываем тред заново
  async function refresh(inst, my) {
    const r = inst.rows[inst.sel];
    const [k, kv, all] = await Promise.all([peerKey(r), myVersion(inst), Cab.rpc('chat_threads_my').catch(() => null)]);
    if (inst.dead || my !== inst.gen) return;
    if (all) {
      all.forEach((x) => { const y = inst.rows.find((z) => z.thread_id && z.thread_id === x.thread_id); if (y) y.unread = y === r ? 0 : x.unread; });
      if (inst.role === 'teacher') inst.rows.push(...all.filter((x) => x.thread_id && !inst.rows.some((z) => z.thread_id === x.thread_id)));   // староста открыл новую переписку
      paintTabs(inst);
    }
    if (applyKeys(inst, r, k, kv)) {
      inst.msgs = []; inst.seen = new Set(); inst.cursor = null;
      await paintEnc(inst);
      if (inst.peerReady) await loadMsgs(inst, my); else paintList(inst, true);
      composer(inst);
    }
  }

  // ---------- отправка ----------
  async function send(inst) {
    if (inst.dead || inst.sending || !inst.peerReady || inst.ctx.closed) return;
    const ta = $(inst.box, '#chIn'), btn = $(inst.box, '#chSend');
    const text = ta.value.trim();
    if (!text) return;
    setErr(inst, ''); inst.netErr = false;
    inst.sending = true; btn.disabled = true;
    const thread = inst.thread, my = inst.gen;
    let ok = false;
    try {
      const enc = await window.ChatCrypto.encrypt(thread, text);
      await Cab.rpc('chat_send', { p_thread: thread.id, p_iv: enc.iv, p_ciphertext: enc.ciphertext, p_sender_kv: enc.sender_key_version, p_recipient_kv: enc.recipient_key_version });
      ok = true;
    } catch (e) {
      logErr('send', e);
      if (!inst.dead) {
        setErr(inst, errText(e));
        if (code(e).includes('key_changed')) refresh(inst, my).catch(() => {});      // следующая попытка уже с новым ключом
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
