// «Журнал 2.0»: шлюз основного журнала. Подключается в index.html ПОСЛЕ env.js, vendor/supabase.js и j2-core.js.
// Показывает поверх страницы: «Ждём подтверждения старосты», «Ваши данные в журнале» (согласие),
// плашку и панель «Заявки студентов» для старосты и заместителя.
// Если таблицы memberships нет (старая база) или у пользователя нет членств, шлюз молчит и ничего не меняет.
// Зависит только от env.js и j2-core.js (J2.sb, J2.esc, J2.CONSENT_*, J2.consentHash), внутренностей index.html не касается.
(function () {
  'use strict';
  if (window.__j2gate) return;
  window.__j2gate = true;
  const dbg = (...a) => { try { console.debug('[j2-gate]', ...a); } catch (e) { /* консоли нет */ } };
  if (!window.J2 || !J2.sb) { dbg('нет J2.sb: шлюз выключен'); return; }
  const sb = J2.sb, esc = J2.esc;
  const SRC = document.currentScript && document.currentScript.src;
  const POLL_PENDING = 15000, POLL_STAFF = 30000, PROBE = 5000;
  const g = { uid: null, kind: null, ov: null, panel: null, staffGroup: null, count: 0, timers: [], inerted: new Set(), obs: null, lastFocus: null, lastEval: 0 };

  // ---------- стили ----------
  if (!document.querySelector('link[href*="j2.css"]')) {
    const l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = SRC ? new URL('j2.css', SRC).href : 'j2.css';
    document.head.appendChild(l);
  }
  const css = document.createElement('style');
  css.id = 'j2g-style';
  css.textContent =
    '.j2g-ov{position:fixed;inset:0;z-index:2900;overflow-y:auto;overscroll-behavior:contain;color:#F2F4F8;background:#0A0C11;' +
    'background-image:radial-gradient(60% 40% at 90% 0%,rgba(198,244,50,.14),transparent 70%),radial-gradient(70% 50% at 0% 70%,rgba(110,80,220,.18),transparent 70%);' +
    "font:400 16px/1.4 'Onest',system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%;text-align:left}" +
    '.j2g-ov *{box-sizing:border-box}' +
    '.j2g-in{max-width:480px;margin:0 auto;padding:calc(var(--app-inset-top,env(safe-area-inset-top,0px)) + 28px) 16px calc(var(--app-inset-bottom,env(safe-area-inset-bottom,0px)) + 32px)}' +
    '.j2g-ov h1,.j2g-ov h2{font-family:inherit;color:#F2F4F8}.j2g-ov h1:focus{outline:none}' +
    '.j2g-ov button{font-family:inherit}.j2g-ov .j2-card h2{margin:0 0 4px}.j2g-ov .j2-msg{margin-top:8px}' +
    '.j2g-check{display:flex;align-items:center;gap:12px;min-height:44px;margin:0;font:600 16px/1.3 inherit;cursor:pointer;color:#F2F4F8}' +
    '.j2g-check input{flex:none;width:26px;height:26px;margin:0;accent-color:#C6F432}' +
    '.j2g-ov input:focus-visible,.j2g-badge:focus-visible{outline:2px solid #C6F432;outline-offset:2px}' +
    '.j2g-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;color:#9AA0AE;font-size:14px}' +
    '.j2g-bw{position:fixed;left:0;right:0;bottom:calc(var(--app-inset-bottom,env(safe-area-inset-bottom,0px)) + 104px);z-index:1100;display:flex;justify-content:center;pointer-events:none;padding:0 12px}' +
    '.j2g-bw[hidden]{display:none}' +
    '.j2g-badge{pointer-events:auto;display:flex;align-items:center;gap:10px;min-height:48px;max-width:100%;padding:8px 18px;border-radius:26px;cursor:pointer;' +
    "color:#FFE9B0;background:rgba(40,32,12,.96);border:1px solid #FFC857;font:700 15px/1.2 'Onest',system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)}" +
    '.j2g-dot{flex:none;width:10px;height:10px;border-radius:50%;background:#FFC857}' +
    '.j2g-ov .j2-row .j2-btn{margin:0}.j2g-ov .j2-card .j2-row{margin-top:12px}' +
    '.j2g-ov .j2-btn.primary{color:#0A0C11}';
  document.head.appendChild(css);

  // ---------- общее ----------
  const plural = (n, f) => { const a = n % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };
  const initials = (s) => (s && s.last_name ? s.last_name + (s.first_name ? ' ' + s.first_name.charAt(0) + '.' : '') : '');
  const fullName = (s) => [s.last_name, s.first_name].filter(Boolean).join(' ') || 'Без имени';
  function whenText(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((sod(new Date()) - sod(d)) / 864e5);
    return (diff === 0 ? 'сегодня' : diff === 1 ? 'вчера' : J2.fmtDate(d)) + ' в ' + J2.fmtTime(d);
  }
  const MAINT = (c) => c.id === 'maintScreen' || c.id === 'maintBanner';

  // Остальная страница недоступна мышью, клавиатурой и диктору. Запоминаем только то, что inert поставили мы.
  function inertOthers(keep) {
    Array.prototype.forEach.call(document.body.children, (c) => {
      if (c === keep || MAINT(c)) return;
      if (!c.inert) { c.inert = true; g.inerted.add(c); }
      if (g.obs) g.obs.observe(c, { attributes: true, attributeFilter: ['inert'] });
    });
  }
  function lock(el, watch) {
    inertOthers(el);
    if (watch) {      // maintenance.js снимает inert со всех при закрытии своей заставки: ставим обратно
      g.obs = new MutationObserver(() => inertOthers(el));
      g.obs.observe(document.body, { childList: true });
      inertOthers(el);
    }
  }
  function unlock() {
    if (g.obs) { g.obs.disconnect(); g.obs = null; }
    g.inerted.forEach((c) => { if (c.isConnected) c.inert = false; });
    g.inerted.clear();
  }
  function trap(el, onEsc) {
    // на document: после перерисовки списка фокус может уйти на body, а Esc и Tab всё равно должны работать
    const h = (e) => {
      if (e.key === 'Escape') { if (onEsc) { e.preventDefault(); onEsc(); } return; }   // обязательные экраны Esc не закрывает
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('button,[href],input,select,textarea')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) { e.preventDefault(); return; }
      const a = document.activeElement, first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (a === first || !f.includes(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !el.contains(a))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', h);
    el._off = () => document.removeEventListener('keydown', h);
  }
  function drop(el) { if (el._off) el._off(); el.remove(); }
  function overlay(kind, html, mandatory, onEsc) {
    const el = document.createElement('div');
    el.className = 'j2g-ov j2g-root'; el.dataset.kind = kind;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'j2gT');
    el.innerHTML = '<div class="j2g-in">' + html + '</div>';
    g.lastFocus = document.activeElement;
    document.body.appendChild(el);
    lock(el, mandatory); trap(el, onEsc);
    const t = el.querySelector('#j2gT'); if (t) t.focus();
    return el;
  }
  const msg = (el, t, kind) => { const m = el.querySelector('.j2-msg'); if (m) { m.textContent = t || ''; m.className = 'j2-msg' + (kind ? ' ' + kind : ''); } };
  const live = '<div class="j2-msg" role="status" aria-live="polite"></div>';
  // Блокирует все кнопки экрана на время запроса
  async function lockBtns(btn, scope, fn) {
    const all = [...scope.querySelectorAll('button')].filter((b) => !b.disabled);
    return J2.busy(btn, async () => { all.forEach((b) => { b.disabled = true; }); try { return await fn(); } finally { all.forEach((b) => { b.disabled = false; }); } });
  }
  function closeMandatory() { if (g.ov) { drop(g.ov); g.ov = null; g.kind = null; unlock(); } }
  async function leave() { try { await sb.auth.signOut(); } catch (e) { dbg('signOut', e); } try { localStorage.setItem('j2.tg_off', '1'); } catch (e) { /* без памяти вход из Telegram вернётся */ } location.reload(); }

  // ---------- «Ждём подтверждения старосты» ----------
  async function showPending(m, mode) {
    if (g.kind === 'pending' && (mode !== 'rejected' || (g.ov && g.ov.dataset.rej))) return;
    if (g.kind && g.kind !== 'pending') closeMandatory();
    if (g.kind === 'pending') closeMandatory();
    let who = '', grp = '';
    if (mode !== 'rejected') {
      try {
        const [s, gr] = await Promise.all([
          m.student_id ? sb.from('students').select('last_name,first_name').eq('id', m.student_id).maybeSingle() : null,
          sb.from('groups').select('name').eq('id', m.group_id).maybeSingle(),
        ]);
        who = initials(s && s.data); grp = (gr && gr.data && gr.data.name) || '';
      } catch (e) { dbg('pending names', e); }
    }
    const rej = mode === 'rejected';
    const step = (cls, mark, t, d) => '<li><span class="j2-dot ' + cls + '" aria-hidden="true">' + mark + '</span><div><b>' + t + '</b><span>' + d + '</span></div></li>';
    g.kind = 'pending';
    g.ov = overlay('pending',
      '<h1 class="j2-h1" id="j2gT" tabindex="-1">' + (rej ? 'Староста не подтвердил вход' : 'Ждём подтверждения старосты') + '</h1>' +
      (grp ? '<p class="j2-sub">Группа ' + esc(grp) + '</p>' : '<p class="j2-sub">Пока данные группы закрыты</p>') +
      (who ? '<div class="j2-field" style="cursor:default"><span>Вы выбрали</span><b style="font-size:17px">' + esc(who) + '</b></div>' : '') +
      '<div class="j2-card"><ol class="j2-timeline">' +
      step('done', '✓', 'Вы вошли по коду группы', 'Заявка отправлена старосте') +
      (rej ? step('', '!', 'Староста отклонил заявку', 'Выберите другую фамилию или обратитесь к старосте')
        : step('now', '', 'Староста подтверждает', 'Пока данные группы закрыты. Страница откроется сама, когда староста подтвердит.')) +
      step('', '', 'Журнал открыт', 'Расписание, пропуски и оценки появятся сразу') + '</ol></div>' +
      (rej ? '' : '<button type="button" class="j2-btn primary" data-a="remind">Напомнить старосте</button>') +
      '<button type="button" class="j2-btn' + (rej ? ' primary' : '') + '" data-a="other">Это не я, выбрать другую фамилию</button>' + live, true);
    if (rej) g.ov.dataset.rej = '1';
    g.ov.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      if (b.dataset.a === 'other') { location.href = 'join.html'; return; }
      lockBtns(b, g.ov, async () => {
        msg(g.ov, 'Отправляем…');
        const { data, error } = await sb.rpc('remind_headman');
        if (error) { msg(g.ov, J2.errText(error.message), 'err'); return; }
        if (data && data.ok === false) msg(g.ov, 'Староста уже получил напоминание. Повторить можно после ' + J2.fmtTime(data.next_at) + '.');
        else msg(g.ov, 'Напоминание отправлено старосте.', 'ok');
      });
    });
  }

  // ---------- «Ваши данные в журнале» ----------
  function showConsent(m) {
    if (g.kind === 'consent') return;
    if (g.kind) closeMandatory();
    g.kind = 'consent';
    g.ov = overlay('consent',
      '<h1 class="j2-h1" id="j2gT" tabindex="-1">Ваши данные в журнале</h1>' +
      '<p class="j2-sub">Перед первым входом прочитайте, что хранит журнал и кто это видит.</p>' +
      J2.CONSENT_TEXT.map((x) => '<div class="j2-card"><h2>' + esc(x[0]) + '</h2><p>' + esc(x[1]) + '</p></div>').join('') +
      '<div class="j2-card"><label class="j2g-check"><input type="checkbox" id="j2gOk"><span>Согласен на обработку моих данных в журнале</span></label></div>' +
      '<button type="button" class="j2-btn primary" data-a="accept" disabled>Принять и продолжить</button>' +
      '<button type="button" class="j2-btn link" data-a="leave">Не согласен, выйти</button>' + live, true);
    const ok = g.ov.querySelector('#j2gOk'), acc = g.ov.querySelector('[data-a="accept"]');
    ok.addEventListener('change', () => { acc.disabled = !ok.checked; msg(g.ov, ok.checked ? '' : 'Поставьте галочку, чтобы продолжить.'); });
    g.ov.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      if (b.dataset.a === 'leave') { lockBtns(b, g.ov, leave); return; }
      if (!ok.checked) return;
      lockBtns(b, g.ov, async () => {
        msg(g.ov, 'Сохраняем согласие…');
        try {
          const { error } = await sb.rpc('consent_accept', { p_group: m.group_id, p_version: J2.CONSENT_VERSION, p_text_hash: await J2.consentHash() });
          if (error) { msg(g.ov, J2.errText(error.message), 'err'); return; }
          location.reload();         // данные группы открылись: страница заново читает их
        } catch (err) { msg(g.ov, J2.errText('network'), 'err'); }
      });
    });
  }

  // ---------- староста: плашка и панель ----------
  let badge = null;
  function ensureBadge() {
    if (badge) return;
    badge = document.createElement('div');
    badge.className = 'j2g-bw j2g-root'; badge.hidden = true; badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
    badge.innerHTML = '<button type="button" class="j2g-badge" aria-haspopup="dialog"><span class="j2g-dot" aria-hidden="true"></span><span class="j2g-t"></span></button>';
    badge.querySelector('button').addEventListener('click', openPanel);
    document.body.appendChild(badge);
  }
  function paintBadge() {
    if (!badge) return;
    const n = g.count, hide = n < 1 || !!document.getElementById('maintScreen') || !!g.panel;
    badge.querySelector('.j2g-t').textContent = n + ' ' + plural(n, ['студент ждёт', 'студента ждут', 'студентов ждут']) + ' подтверждения';
    badge.hidden = hide;
  }
  async function refreshCount() {
    const gid = g.staffGroup; if (!gid) return;
    try {
      const { count, error } = await sb.from('students').select('id', { count: 'exact', head: true }).eq('group_id', gid).eq('claim_status', 'pending');
      if (error) { dbg('count', error.message); return; }
      g.count = count || 0; paintBadge();
    } catch (e) { dbg('count', e); }
  }
  function startStaff(gid) {
    if (g.staffGroup === gid) return;
    stopStaff(); g.staffGroup = gid; ensureBadge(); refreshCount();
    g.timers.push(setInterval(staffTick, POLL_STAFF));
  }
  function stopStaff() {
    g.staffGroup = null; g.count = 0;
    if (g.panel) closePanel(true);
    if (badge) { badge.remove(); badge = null; }
  }
  function staffTick() { if (!g.staffGroup || document.hidden) return; refreshCount(); if (g.panel) loadPanel(); }

  function openPanel() {
    if (g.panel || !g.staffGroup) return;
    g.panel = overlay('panel',
      '<div class="j2g-top"><button type="button" class="j2-back" data-a="close">‹ Закрыть</button><span id="j2gGrp"></span></div>' +
      '<h1 class="j2-h1" id="j2gT" tabindex="-1">Заявки студентов</h1><p class="j2-sub" id="j2gSub">Загрузка…</p>' +
      '<div id="j2gList"></div><div id="j2gFoot"></div>' +
      '<p class="j2-sub">Подтверждайте только тех, кого знаете. Пока вы не подтвердили, студент не видит данные группы.</p>' + live, false, () => closePanel());
    g.panel.addEventListener('click', onPanelClick);
    paintBadge(); loadPanel();
    sb.from('groups').select('name').eq('id', g.staffGroup).maybeSingle().then((r) => {
      const el = g.panel && g.panel.querySelector('#j2gGrp'); if (el && r.data) el.textContent = 'Староста, ' + r.data.name;
    }, () => {});
  }
  function closePanel(silent) {
    if (!g.panel) return;
    drop(g.panel); g.panel = null; unlock();
    if (!silent) { paintBadge(); refreshCount(); const b = badge && badge.querySelector('button'); if (b && !badge.hidden) b.focus(); }
  }
  let loadSeq = 0;
  async function loadPanel() {
    const gid = g.staffGroup, p = g.panel; if (!gid || !p) return;
    const seq = ++loadSeq;
    try {
      const [s, ms, act, all] = await Promise.all([
        sb.from('students').select('id,last_name,first_name').eq('group_id', gid).eq('claim_status', 'pending').order('sort'),
        sb.from('memberships').select('student_id,created_at').eq('group_id', gid).eq('status', 'pending'),
        sb.from('students').select('id', { count: 'exact', head: true }).eq('group_id', gid).eq('claim_status', 'active'),
        sb.from('students').select('id', { count: 'exact', head: true }).eq('group_id', gid),
      ]);
      if (seq !== loadSeq || g.panel !== p) return;
      const err = s.error || ms.error || act.error || all.error;
      if (err) { p.querySelector('#j2gSub').textContent = 'Не удалось загрузить список.'; msg(p, J2.errText(err.message), 'err'); return; }
      const at = new Map((ms.data || []).map((x) => [x.student_id, x.created_at]));
      const list = s.data || [];
      g.count = list.length;
      p.querySelector('#j2gSub').textContent = list.length ? list.length + ' ' + plural(list.length, ['ждёт', 'ждут', 'ждут']) + ' подтверждения' : 'Новых заявок нет';
      p.querySelector('#j2gList').innerHTML = list.length ? list.map((x) =>
        '<article class="j2-card warn" data-id="' + esc(x.id) + '"><h2>' + esc(fullName(x)) + '</h2>' +
        '<p>' + (at.get(x.id) ? 'Вход по коду группы: ' + esc(whenText(at.get(x.id))) : 'Вошёл(ла) по коду группы') + '</p>' +
        '<div class="j2-row"><button type="button" class="j2-btn primary" data-a="ok" aria-label="Это он: ' + esc(fullName(x)) + '">Это он</button>' +
        '<button type="button" class="j2-btn" data-a="no" aria-label="Не он: ' + esc(fullName(x)) + '">Не он</button></div></article>').join('')
        : '<div class="j2-card"><h2>Заявок нет</h2><p>Когда студент войдёт по коду группы, он появится здесь.</p></div>';
      p.querySelector('#j2gFoot').innerHTML = '<div class="j2-card"><div class="j2-grid2"><div><b>Подтверждены</b><p>вход открыт</p></div><span class="j2-num">' +
        (act.count || 0) + ' из ' + (all.count || 0) + '</span></div></div>';
      if (!p.contains(document.activeElement)) p.querySelector('#j2gT').focus();
      paintBadge();
    } catch (e) { dbg('panel', e); msg(p, J2.errText('network'), 'err'); }
  }
  function onPanelClick(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    if (b.dataset.a === 'close') { closePanel(); return; }
    const card = b.closest('article'); if (!card) return;
    const id = card.dataset.id, name = card.querySelector('h2').textContent, ok = b.dataset.a === 'ok';
    lockBtns(b, card, async () => {
      msg(g.panel, 'Отправляем…');
      const { error } = await sb.rpc(ok ? 'membership_approve' : 'membership_reject', { p_student_id: id });
      if (error) msg(g.panel, J2.errText(error.message), 'err');
      else msg(g.panel, (ok ? 'Подтверждён: ' : 'Отклонён: ') + name + '.', 'ok');
      await loadPanel(); refreshCount();
    });
  }

  // ---------- разбор членств ----------
  async function evaluate() {
    const uid = g.uid; if (!uid) return;
    g.lastEval = Date.now();
    let rows = null;
    // В кабинетах 2.0 те же членства уже читает Cab.load: первый разбор берёт их оттуда, без второго такого же запроса на старте
    if (!g.cabUsed && window.Cab && Cab.memsReady) {
      g.cabUsed = true;
      const pre = await Promise.race([Cab.memsReady, new Promise((r) => setTimeout(r, 15000, null))]);
      if (pre && pre.uid === uid) rows = pre.rows;
    }
    if (!rows) try {
      const r = await sb.from('memberships').select('group_id,student_id,status,extra_role,base_role,consent_at').eq('user_id', uid);
      if (r.error) { dbg('memberships недоступны:', r.error.message); return; }       // старая база: молчим
      rows = r.data || [];
    } catch (e) { dbg('memberships', e); return; }
    if (uid !== g.uid || !rows.length) return;
    const active = rows.filter((r) => r.status === 'active'), pend = rows.find((r) => r.status === 'pending');
    if (!active.length && pend) { await showPending(pend); return; }
    if (g.kind === 'pending') {
      if (active.length) { location.reload(); return; }                 // староста подтвердил
      await showPending(rows[0], 'rejected'); return;                    // отклонён или убран
    }
    const nc = active.find((r) => !r.consent_at);
    if (nc) { showConsent(nc); return; }
    if (g.kind === 'consent') closeMandatory();
    const staff = active.find((r) => r.extra_role === 'headman' || r.extra_role === 'deputy');
    if (staff && !window.J2_GATE_NO_STAFF) startStaff(staff.group_id); else stopStaff();   // в кабинетах 2.0 заявки живут в кабинете старосты
  }
  function reset() {
    g.timers.forEach(clearInterval); g.timers = [];
    stopStaff(); closeMandatory(); unlock(); g.uid = null;
  }
  function setUser(id) {
    if (g.uid === id) return;
    reset(); g.uid = id;
    if (!id) return;
    evaluate();
    g.timers.push(setInterval(() => { if (g.kind === 'pending' && !document.hidden) evaluate(); }, POLL_PENDING));
  }

  sb.auth.onAuthStateChange((ev, session) => {
    setTimeout(() => {          // не вызываем клиент прямо из колбэка: возможна взаимная блокировка
      if (ev === 'SIGNED_OUT') setUser(null);
      else if (session && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION')) setUser(session.user.id);
    }, 0);
  });
  // Основной сайт держит свой клиент: вход или выход на странице нас не уведомляет. Сессия лежит в localStorage, читаем её.
  async function probe() {
    try { const { data } = await sb.auth.getSession(); setUser(data && data.session ? data.session.user.id : null); } catch (e) { dbg('probe', e); }
  }
  setInterval(probe, PROBE);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { probe(); if (g.staffGroup) staffTick(); } });
})();
