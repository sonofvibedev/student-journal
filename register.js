// «Журнал 2.0»: регистрация нового старосты (4 шага и экран «Заявка отправлена»).
// Права проверяет сервер: Edge Functions и RLS. Эта страница только собирает черновик и показывает ответы.
// Ввод пользователя попадает в DOM только через textContent (функции h(), setText()).
'use strict';
(function () {
  const $ = J2.$;
  const FN = 'schedule-lookup';
  const STEP_NAMES = ['Ваша группа', 'Вы', 'Студенты', 'Расписание'];
  const H1 = { 1: 'Какая у вас группа?', 2: 'Расскажите о себе', 3: 'Добавьте студентов', 4: 'Расписание' };

  // ---------- состояние ----------
  const S = {
    step: 1, prev: 1,
    req: null,            // строка registration_requests (черновик или поданная заявка)
    owner: { name: '', email: '' },
    group: null,          // payload.group
    students: [],         // { last, first, form:'budget'|'paid', raw:null|string, me:bool }
    failLevel: -1,
    seq: [0, 0, 0, 0],
    sched: null, schedKey: '',
    codeShown: false, confirmRotate: false, code: '',
    timer: null,
  };

  // ---------- мелочи ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k] === true ? '' : props[k]);
    }
    for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const clear = (e) => { while (e.firstChild) e.removeChild(e.firstChild); };
  function say(id, text, kind) { const e = $(id); e.textContent = text || ''; e.className = 'j2-msg' + (kind ? ' ' + kind : ''); }
  const pl = (n, one, few, many) => { const m = n % 100, d = n % 10; return (m > 10 && m < 15) ? many : d === 1 ? one : (d >= 2 && d <= 4) ? few : many; };
  const normName = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const fullName = (st) => `${st.last} ${st.first}`;

  // Ошибка Supabase (REST/RPC) в понятный текст
  const DB_ERR = {
    not_draft: 'Заявка уже отправлена, править её нельзя.',
    not_found: 'Заявка не найдена. Войдите заново.',
    bad_payload: 'В заявке не хватает данных. Вернитесь на шаги назад и проверьте поля.',
    no_students: 'Добавьте хотя бы одного студента.',
    bad_student: 'У каждого студента должны быть фамилия и имя.',
    duplicate_student: 'В списке есть повторы. Уберите лишних студентов.',
    bad_owner_index: 'Проверьте, кого вы выбрали в пункте «Это я».',
  };
  function dbText(err) {
    const m = String((err && (err.message || err.code)) || '');
    for (const k in DB_ERR) if (m.includes(k)) return DB_ERR[k];
    if (/jwt|PGRST30|not authenticated/i.test(m) || (err && err.status === 401)) return 'Сессия закончилась. Нажмите «Уже начинали? Войти».';
    if (/fetch|network|load failed/i.test(m)) return J2.errText('network');
    return J2.errText('server_error');
  }

  // ---------- переходы между экранами ----------
  const SECTIONS = ['s1', 's2', 'sl', 's3', 's4', 's5'];
  function show(step) {
    if (S.timer && step !== 5) { clearInterval(S.timer); S.timer = null; }
    if (step !== 'login') S.prev = S.step;
    S.step = step;
    const sec = step === 'login' ? 'sl' : 's' + step;
    SECTIONS.forEach((id) => $(id).classList.toggle('j2-hidden', id !== sec));
    const numbered = typeof step === 'number' && step <= 4;
    $('stepsBox').classList.toggle('j2-hidden', !numbered);
    $('back').classList.toggle('j2-hidden', !(step === 'login' || (numbered && step > 1)));
    if (numbered) {
      [...$('steps').children].forEach((i, k) => i.classList.toggle('on', k < step));
      $('stepLabel').textContent = `Шаг ${step} из 4. ${STEP_NAMES[step - 1]}`;
    }
    $('h1').textContent = step === 'login' ? 'Вход для тех, кто уже начал' : step === 5 ? 'Заявка отправлена' : H1[step];
    const sub = $('h1sub');
    sub.classList.toggle('j2-hidden', step !== 5);
    if (step === 5) sub.textContent = S.group && S.group.group_name ? `Группа ${S.group.group_name}` : '';
    window.scrollTo(0, 0);
    $('h1').focus({ preventScroll: true });
    if (step === 2) fillStep2();
    if (step === 3) renderStudents();
    if (step === 4) runFind(false);
    if (step === 5) startStatus();
  }
  $('back').addEventListener('click', () => {
    if (S.step === 'login') show(S.prev);
    else if (typeof S.step === 'number' && S.step > 1) show(S.step - 1);
  });
  $('toLogin1').addEventListener('click', () => { $('lemail').value = $('email').value; say('ml', ''); show('login'); });
  $('toLogin2').addEventListener('click', () => { $('lemail').value = $('email').value; say('ml', ''); show('login'); });

  // ---------- шаг 1: группа ----------
  const SEL = ['fac', 'frm', 'crs', 'grp'].map($);
  const PARAMS = [
    () => ({ action: 'faculties' }),
    () => ({ action: 'forms', faculty: SEL[0].value }),
    () => ({ action: 'courses', faculty: SEL[0].value, form: SEL[1].value }),
    () => ({ action: 'groups', faculty: SEL[0].value, form: SEL[1].value, course: SEL[2].value }),
  ];
  function resetSel(i, text) {
    const s = SEL[i];
    clear(s);
    s.append(h('option', { value: '', text: text || 'Выберите' }));
    s.disabled = true;
  }
  async function loadLevel(i) {
    for (let k = i; k < 4; k++) resetSel(k, k === i ? 'Загрузка…' : 'Выберите');
    updNext1();
    const my = ++S.seq[i];
    const r = await J2.fn(FN, PARAMS[i](), { anon: true });
    if (my !== S.seq[i]) return false;   // пришёл устаревший ответ
    const list = r.ok && Array.isArray(r.data) ? r.data : null;
    if (!list) {
      resetSel(i, 'Не загрузилось');
      S.failLevel = i;
      $('listErr').textContent = J2.errText(r.data && r.data.error ? r.data.error : 'network');
      $('manualBox').classList.remove('j2-hidden');
      updNext1();
      return false;
    }
    resetSel(i, list.length ? 'Выберите' : 'Ничего не найдено');
    for (const o of list) SEL[i].append(h('option', { value: String(o.value), text: String(o.text) }));
    SEL[i].disabled = !list.length;
    S.failLevel = -1;
    $('manualBox').classList.toggle('j2-hidden', !$('manual').value);
    updNext1();
    return true;
  }
  SEL.forEach((s, i) => s.addEventListener('change', () => {
    for (let k = i + 1; k < 4; k++) { S.seq[k]++; resetSel(k); }
    if (s.value && i < 3) loadLevel(i + 1);
    updNext1();
  }));
  $('retry').addEventListener('click', () => J2.busy($('retry'), () => loadLevel(Math.max(S.failLevel, 0))));
  $('manual').addEventListener('input', updNext1);
  function chosenGroup() {
    if (SEL[3].value && SEL.every((s) => s.value)) return true;
    return false;
  }
  function updNext1() { $('next1').disabled = !(chosenGroup() || $('manual').value.trim().length >= 2); }
  const optText = (s) => (s.selectedOptions[0] ? s.selectedOptions[0].textContent : '');
  function groupFromForm() {
    if (chosenGroup()) {
      const course = SEL[2].value;
      const groupName = optText(SEL[3]);
      return {
        faculty_id: SEL[0].value, faculty_name: optText(SEL[0]),
        form_id: SEL[1].value, form_name: optText(SEL[1]),
        course: /^\d+$/.test(course) ? Number(course) : course,
        bseu_group_id: SEL[3].value, group_name: groupName,
        // имена полей, которые читает registration_submit / sysadmin_approve_registration
        name: groupName, group_no: groupName.split('|')[0].trim(),
        faculty: optText(SEL[0]), study_form: optText(SEL[1]),
        bseu_faculty_id: SEL[0].value, bseu_form_id: SEL[1].value,
      };
    }
    const n = $('manual').value.trim().replace(/\s+/g, ' ');
    return {
      faculty_id: null, faculty_name: null, form_id: null, form_name: null, course: null, bseu_group_id: null, group_name: n,
      name: n, group_no: n, faculty: null, study_form: null, bseu_faculty_id: null, bseu_form_id: null,
    };
  }
  $('s1').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('next1').disabled) return;
    J2.busy($('next1'), async () => {
      say('m1', '');
      S.group = groupFromForm();
      S.schedKey = '';
      if (!S.req) return show(2);
      const err = await saveDraft({ group: S.group }, 3);
      if (err) return say('m1', dbText(err), 'err');
      show(3);
    }).then(updNext1);
  });
  // Восстановить выбранное из черновика: по цепочке подгружаем списки и выбираем сохранённые значения
  async function restoreSelection(g) {
    if (!g) return;
    if (!g.bseu_group_id) { $('manual').value = g.group_name || ''; $('manualBox').classList.remove('j2-hidden'); updNext1(); return; }
    const ids = [g.faculty_id, g.form_id, String(g.course), g.bseu_group_id];
    for (let i = 0; i < 4; i++) {
      if (SEL[i].options.length < 2 && !(await loadLevel(i))) return;
      const o = [...SEL[i].options].find((x) => x.value === String(ids[i]));
      if (!o) return;
      SEL[i].value = o.value;
    }
    updNext1();
  }

  // ---------- шаг 2: вы ----------
  function fillStep2() {
    const has = !!S.req;
    $('name').value = S.owner.name || $('name').value;
    $('email').value = S.owner.email || $('email').value;
    $('email').readOnly = has;
    $('pwBox').classList.toggle('j2-hidden', has);
    $('toLogin2').classList.toggle('j2-hidden', has);
    say('m2', has ? 'Аккаунт уже создан. Почту и пароль здесь изменить нельзя.' : '');
  }
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
  $('s2').addEventListener('submit', (e) => {
    e.preventDefault();
    J2.busy($('next2'), async () => {
      const name = $('name').value.trim().replace(/\s+/g, ' ');
      const email = $('email').value.trim().toLowerCase();
      const password = $('pw').value;
      if (name.split(' ').length < 2 || name.length < 3) return say('m2', J2.errText('bad_name'), 'err');
      if (S.req) {   // аккаунт и черновик уже есть: сохраняем только имя
        const err = await saveDraft({ owner: { name, email: S.owner.email, studentIndex: ownerIndex() } }, 3);
        if (err) return say('m2', dbText(err), 'err');
        S.owner.name = name;
        return show(3);
      }
      if (!EMAIL_RE.test(email)) return say('m2', J2.errText('bad_email'), 'err');
      if (password.length < J2.PASSWORD_MIN || password.length > J2.PASSWORD_MAX) return say('m2', J2.errText('bad_password'), 'err');
      say('m2', 'Создаём заявку…');
      const r = await J2.fn('registration-start', { name, email, password }, { anon: true });
      if (!r.ok || !(r.data && r.data.ok)) return say('m2', J2.errText(r.data && r.data.error), 'err');
      const si = await J2.sb.auth.signInWithPassword({ email, password });
      if (si.error) return say('m2', 'Аккаунт создан, но войти не получилось. Нажмите «Уже начинали? Войти».', 'err');
      const row = await readLatestRequest('draft');
      if (row.error || !row.data) return say('m2', 'Заявка создана, но прочитать её не удалось. Нажмите «Уже начинали? Войти».', 'err');
      S.req = row.data;
      S.owner = { name, email };
      const err = await saveDraft({ group: S.group, owner: { name, email, studentIndex: null }, students: [] }, 3);
      if (err) return say('m2', dbText(err), 'err');
      $('pw').value = '';
      say('m2', '');
      show(3);
    });
  });

  // ---------- вход: «Уже начинали?» ----------
  $('sl').addEventListener('submit', (e) => {
    e.preventDefault();
    J2.busy($('loginBtn'), async () => {
      const email = $('lemail').value.trim().toLowerCase(), password = $('lpw').value;
      if (!EMAIL_RE.test(email)) return say('ml', J2.errText('bad_email'), 'err');
      if (!password) return say('ml', 'Введите пароль.', 'err');
      say('ml', 'Входим…');
      const si = await J2.sb.auth.signInWithPassword({ email, password });
      if (si.error) return say('ml', /network|fetch/i.test(si.error.message) ? J2.errText('network') : 'Неверная почта или пароль.', 'err');
      const found = await loadRequest();
      if (found === 'error') return say('ml', J2.errText('server_error'), 'err');
      if (!found) return say('ml', 'Вход выполнен, но заявки на этом аккаунте нет. Начните с шага 1.', 'err');
      $('lpw').value = '';
      say('ml', '');
    });
  });

  // ---------- заявка в базе ----------
  function readLatestRequest(status) {
    let q = J2.sb.from('registration_requests').select('*');
    if (status) q = q.eq('status', status);
    return q.order('created_at', { ascending: false }).limit(1).then((r) => ({ error: r.error, data: r.data && r.data[0] ? r.data[0] : null }));
  }
  // Читает свою последнюю заявку и переходит на нужный экран. Возвращает true / false / 'error'
  async function loadRequest() {
    const r = await readLatestRequest();
    if (r.error) return 'error';
    if (!r.data) return false;
    adopt(r.data);
    return true;
  }
  function adopt(row) {
    S.req = row;
    const p = row.payload || {};
    S.owner = { name: (p.owner && p.owner.name) || '', email: (p.owner && p.owner.email) || '' };
    S.group = p.group || null;
    const idx = p.owner && Number.isInteger(p.owner.studentIndex) ? p.owner.studentIndex : -1;
    S.students = (Array.isArray(p.students) ? p.students : []).map((s, i) => ({
      last: String(s.last_name || ''), first: String(s.first_name || ''), form: s.study_form === 'paid' ? 'paid' : 'budget', raw: null, me: i === idx,
    }));
    if (row.status !== 'draft') { show(5); return; }
    restoreSelection(S.group);
    if (!S.group) return show(1);
    if (!S.students.length) return show(3);
    show(row.step === 4 ? 4 : 3);
  }
  function ownerIndex() {
    const done = S.students.filter((s) => s.raw === null);
    const i = done.findIndex((s) => s.me);
    return i < 0 ? null : i;
  }
  // Сохраняет черновик: берёт текущий payload из базы и сливает с нашими полями (поле schedule пишет только сервер)
  async function saveDraft(patch, step) {
    if (!S.req) return { message: 'not_found' };
    const cur = await J2.sb.from('registration_requests').select('payload').eq('id', S.req.id).eq('status', 'draft').limit(1);
    if (cur.error) return cur.error;
    if (!cur.data || !cur.data[0]) return { message: 'not_draft' };
    const payload = { ...(cur.data[0].payload || {}), ...patch };
    const upd = await J2.sb.from('registration_requests').update({ payload, step }).eq('id', S.req.id).eq('status', 'draft').select('id');
    if (upd.error) return upd.error;
    if (!upd.data || !upd.data.length) return { message: 'not_draft' };
    S.req.payload = payload; S.req.step = step;
    return null;
  }
  function studentsPayload() {
    return S.students.filter((s) => s.raw === null).map((s) => ({ last_name: s.last, first_name: s.first, study_form: s.form }));
  }

  // ---------- шаг 3: студенты ----------
  const BUDGET_RE = /^(бюджет[а-яё]*|бюдж\.?|б\.?)$/;
  const PAID_RE = /^(платн[а-яё]*|п\.?)$/;
  // «Иванова Мария», «Петров Дмитрий, платная», «Петров Дмитрий (п.)», «3. Сидоренко Ольга»
  function parseLine(line) {
    let s = line.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
    let form = 'budget';
    const m = s.match(/\s*\(([^)]*)\)\s*$/) || s.match(/\s*[,;]\s*([^,;]*)$/);
    if (m) {
      const label = m[1].trim().toLowerCase();
      if (PAID_RE.test(label)) form = 'paid';
      else if (label && !BUDGET_RE.test(label)) return { error: `не понятна метка «${m[1].trim()}»` };
      s = s.slice(0, m.index).trim();
    }
    const w = s.split(/\s+/).filter(Boolean);
    if (w.length < 2) return { error: 'нужны фамилия и имя' };
    return { st: { last: w[0], first: w.slice(1).join(' '), form, raw: null, me: false } };
  }
  function loadPasted() {
    const lines = $('paste').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bad = [];
    let added = 0;
    for (const l of lines) {
      const r = parseLine(l);
      if (r.st) { S.students.push(r.st); added++; } else bad.push(`«${l}»: ${r.error}`);
    }
    $('paste').value = lines.filter((l) => !parseLine(l).st).join('\n');
    renderStudents();
    return { added, bad };
  }
  $('load').addEventListener('click', () => {
    if (!$('paste').value.trim()) return say('m3', 'Сначала вставьте список в поле выше.', 'err');
    const { added, bad } = loadPasted();
    if (bad.length) say('m3', `Не удалось разобрать ${bad.length} ${pl(bad.length, 'строку', 'строки', 'строк')}, они остались в поле: ${bad.join('; ')}.`, 'err');
    else say('m3', `Загружено: ${added}.`, 'ok');
  });
  $('addOne').addEventListener('click', () => {
    S.students.push({ last: '', first: '', form: 'budget', raw: '', me: false });
    say('m3', '');
    renderStudents(S.students.length - 1);
  });
  function dupSet() {
    const seen = new Map(), dup = new Set();
    S.students.forEach((s) => {
      if (s.raw !== null) return;
      const k = normName(fullName(s));
      if (seen.has(k)) { dup.add(k); } else seen.set(k, 1);
    });
    return dup;
  }
  function renderStudents(focusIdx) {
    const done = S.students.filter((s) => s.raw === null);
    const paid = done.filter((s) => s.form === 'paid').length;
    $('sumTitle').textContent = done.length ? `Добавлено ${done.length} ${pl(done.length, 'человек', 'человека', 'человек')}` : 'Пока никого не добавлено';
    $('nBudget').textContent = done.length - paid;
    $('nPaid').textContent = paid;
    const dups = dupSet();
    const ul = $('studList');
    clear(ul);
    S.students.forEach((s, i) => {
      const rm = h('button', { type: 'button', class: 'rm', 'aria-label': s.raw === null ? `Удалить: ${fullName(s)}` : 'Удалить пустую строку', title: 'Удалить', text: '✕',
        onclick: () => { S.students.splice(i, 1); renderStudents(); } });
      if (s.raw !== null) {
        const inp = h('input', { type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Иванова Мария', value: s.raw });
        inp.addEventListener('input', () => { s.raw = inp.value; });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitRow(i); } });
        inp.addEventListener('blur', () => { setTimeout(() => { if (S.students[i] === s && s.raw !== null && s.raw.trim() && document.activeElement !== rm) commitRow(i, true); }, 0); });
        ul.append(h('li', { class: 'edit' }, h('label', { class: 'j2-field' }, h('span', { text: 'Фамилия и имя' }), inp), rm));
        if (focusIdx === i) setTimeout(() => inp.focus(), 0);
        return;
      }
      const isDup = dups.has(normName(fullName(s)));
      const chip = h('button', { type: 'button', class: 'j2-chip' + (s.form === 'paid' ? ' on' : ''),
        'aria-label': `Форма обучения: ${s.form === 'paid' ? 'платная' : 'бюджет'}. Нажмите, чтобы поменять`,
        text: s.form === 'paid' ? 'Платная' : 'Бюджет',
        onclick: () => { s.form = s.form === 'paid' ? 'budget' : 'paid'; renderStudents(); } });
      ul.append(h('li', { class: isDup ? 'dup' : '' }, h('div', { class: 'nm' }, fullName(s), isDup ? h('span', { class: 'dupnote', text: 'Повтор: такой студент уже есть в списке' }) : null), chip, rm));
    });
    $('listCard').classList.toggle('j2-hidden', !S.students.length);
    // «Это я»
    const me = $('me');
    clear(me);
    me.append(h('option', { value: '', text: 'Не выбрано' }));
    done.forEach((s, k) => me.append(h('option', { value: String(k), text: fullName(s) })));
    const mi = done.findIndex((s) => s.me);
    me.value = mi < 0 ? '' : String(mi);
    $('meBox').classList.toggle('j2-hidden', !done.length);
  }
  function commitRow(i, silent) {
    const s = S.students[i];
    if (!s || s.raw === null) return true;
    const t = s.raw.trim();
    if (!t) { S.students.splice(i, 1); renderStudents(); return true; }
    const r = parseLine(t);
    if (!r.st) { if (!silent) say('m3', `«${t}»: ${r.error}.`, 'err'); return false; }
    s.last = r.st.last; s.first = r.st.first; s.raw = null;
    if (/[,;(]/.test(t)) s.form = r.st.form;
    say('m3', '');
    renderStudents();
    return true;
  }
  $('me').addEventListener('change', () => {
    const done = S.students.filter((s) => s.raw === null);
    done.forEach((s) => { s.me = false; });
    if ($('me').value !== '' && done[Number($('me').value)]) done[Number($('me').value)].me = true;
  });
  // Все ошибки списка одним сообщением; null, если можно идти дальше
  function studentsProblem() {
    for (let i = S.students.length - 1; i >= 0; i--) if (S.students[i].raw !== null && !commitRow(i, true)) return `Строка «${S.students[i].raw.trim()}»: нужны фамилия и имя (минимум два слова).`;
    const done = S.students.filter((s) => s.raw === null);
    if (!done.length) return 'Добавьте хотя бы одного студента: вставьте список или нажмите «Добавить по одному».';
    const dups = [...dupSet()];
    if (dups.length) {
      const names = done.filter((s, i) => dups.includes(normName(fullName(s))) && done.findIndex((x) => normName(fullName(x)) === normName(fullName(s))) === i).map(fullName);
      return `В списке есть повторы: ${names.join(', ')}. Оставьте каждого по одному разу, повторы подсвечены красным.`;
    }
    return null;
  }
  $('s3').addEventListener('submit', (e) => {
    e.preventDefault();
    J2.busy($('next3'), async () => {
      if ($('paste').value.trim()) {   // забыли нажать «Загрузить список»
        const { bad } = loadPasted();
        if (bad.length) return say('m3', `Не удалось разобрать: ${bad.join('; ')}.`, 'err');
      }
      const problem = studentsProblem();
      renderStudents();
      if (problem) return say('m3', problem, 'err');
      say('m3', 'Сохраняем…');
      const err = await saveDraft({ owner: { name: S.owner.name, email: S.owner.email, studentIndex: ownerIndex() }, students: studentsPayload() }, 4);
      if (err) return say('m3', dbText(err), 'err');
      say('m3', '');
      show(4);
    });
  });

  // ---------- шаг 4: расписание ----------
  async function runFind(force) {
    const box = $('schedBox');
    const g = S.group || {};
    const key = [g.faculty_id, g.form_id, g.course, g.bseu_group_id].join('|');
    say('m4', '');
    if (!force && S.sched && S.schedKey === key) return renderSched();
    if (!g.bseu_group_id) { S.sched = { found: false, manual: true }; S.schedKey = key; return renderSched(); }
    clear(box);
    box.append(h('div', { class: 'j2-card' }, h('p', { text: 'Ищем расписание на bseu.by. Это может занять до полуминуты…' })));
    $('h1').textContent = 'Расписание';
    $('submit4').disabled = true;
    const r = await J2.fn(FN, { action: 'find', faculty: g.faculty_id, form: g.form_id, course: String(g.course), group: g.bseu_group_id, request_id: S.req && S.req.id });
    if (S.step !== 4) return;
    S.schedKey = key;
    S.sched = r.ok && r.data && r.data.found ? r.data : { found: false, error: r.ok ? null : (r.data && r.data.error) || 'network' };
    $('submit4').disabled = false;
    renderSched();
  }
  function row(title, sub, right) {
    return h('li', null, h('div', null, h('b', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null), h('span', { class: 'num', text: right }));
  }
  function renderSched() {
    const box = $('schedBox'), d = S.sched;
    clear(box);
    if (d && d.found) {
      $('h1').textContent = 'Расписание нашлось';
      const subjects = Array.isArray(d.subjects) ? d.subjects : [], teachers = Array.isArray(d.teachers) ? d.teachers : [];
      const weeks = Number(d.weeks);
      box.append(
        h('div', { class: 'j2-card' },
          h('h2', null, h('span', { class: 'j2-ok', 'aria-hidden': 'true', text: '✓' }), `bseu.by, группа ${(S.group && S.group.group_name) || ''}`),
          h('ul', { class: 'j2-list' },
            row('Семестр', d.semester ? String(d.semester) : '', weeks ? `${weeks} ${pl(weeks, 'неделя', 'недели', 'недель')}` : 'не указано'),
            row('Предметы', 'лекции и практические', String(subjects.length)),
            row('Преподаватели', 'подтянуты из расписания', String(teachers.length)))),
        subjects.length ? h('div', { class: 'j2-card' }, h('h2', { text: 'Предметы' }),
          h('ul', { class: 'j2-list' }, subjects.map((s) => h('li', null, h('div', null, h('b', { text: String(s.name) }),
            Array.isArray(s.kinds) && s.kinds.length ? h('div', { class: 'sub', text: s.kinds.join(', ') }) : null))))) : null,
        h('p', { class: 'j2-hint', text: 'Расписание обновляется само каждую ночь. Предметы и преподавателей можно поправить вручную.' }));
    } else {
      $('h1').textContent = 'Расписание не найдено';
      const why = d && d.manual ? 'Группа введена вручную, поэтому искать расписание не по чему.'
        : d && d.error ? J2.errText(d.error) : 'На bseu.by для этой группы расписания нет или оно в незнакомом виде.';
      box.append(h('div', { class: 'j2-card warn' },
        h('h2', { text: 'Расписание не найдено' }),
        h('p', { style: 'color:var(--j-text)', text: 'Заявку можно отправить без расписания, статус: расписание не найдено.' }),
        h('p', { style: 'margin-top:6px', text: why })));
      if (!(d && d.manual)) box.append(h('button', { type: 'button', class: 'j2-btn', text: 'Искать ещё раз', onclick: (e) => J2.busy(e.currentTarget, () => runFind(true)) }));
    }
  }
  $('s4').addEventListener('submit', (e) => {
    e.preventDefault();
    J2.busy($('submit4'), async () => {
      say('m4', 'Отправляем…');
      const err = await saveDraft({ group: S.group, owner: { name: S.owner.name, email: S.owner.email, studentIndex: ownerIndex() }, students: studentsPayload() }, 4);
      if (err) return say('m4', dbText(err), 'err');
      const r = await J2.sb.rpc('registration_submit', { p_request: S.req.id });
      if (r.error) return say('m4', dbText(r.error), 'err');
      J2.fn('notify-registration', { kind: 'submitted', request_id: S.req.id });   // письмо и Telegram администратору; сбой не мешает заявке
      say('m4', '');
      S.req.status = 'submitted';
      show(5);
    });
  });

  // ---------- экран «Заявка отправлена» ----------
  function startStatus() {
    renderStatus();
    pollStatus();
    if (!S.timer) S.timer = setInterval(() => { if (!document.hidden) pollStatus(); }, 20000);
  }
  async function pollStatus() {
    if (!S.req || !J2.sb) return;
    const r = await J2.sb.from('registration_requests').select('status, group_id, reject_reason').eq('id', S.req.id).limit(1);
    if (r.error || !r.data || !r.data[0]) return;
    const n = r.data[0];
    const changed = n.status !== S.req.status || n.group_id !== S.req.group_id || n.reject_reason !== S.req.reject_reason;
    Object.assign(S.req, n);
    if (changed && S.step === 5) renderStatus();
    if (n.status === 'approved' || n.status === 'rejected') { clearInterval(S.timer); S.timer = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.step === 5) pollStatus(); });

  function tl(state, title, text) {
    const word = state === 'done' ? 'готово' : state === 'now' ? 'в процессе' : 'впереди';
    return h('li', null, h('span', { class: 'j2-dot ' + state, 'aria-hidden': 'true', text: state === 'done' ? '✓' : '' }),
      h('div', null, h('b', null, title, h('span', { class: 'j2-sr', text: `, ${word}` })), h('span', { text })));
  }
  function renderStatus() {
    const box = $('s5body'), st = S.req ? S.req.status : 'submitted';
    clear(box);
    const n = (S.req && S.req.payload && Array.isArray(S.req.payload.students)) ? S.req.payload.students.length : S.students.length;
    const hasSched = S.req && S.req.schedule_status === 'found';
    if (st === 'rejected') {
      box.append(h('div', { class: 'j2-card bad' }, h('h2', { text: 'Заявка отклонена' }),
        h('p', { style: 'color:var(--j-text)', text: (S.req.reject_reason && String(S.req.reject_reason).trim()) || 'Причина не указана. Уточните у администратора журнала.' })));
      return;
    }
    const approved = st === 'approved';
    box.append(h('div', { class: 'j2-card' }, h('ul', { class: 'j2-timeline' },
      tl('done', 'Заявка у администратора', `Список из ${n} ${pl(n, 'студента', 'студентов', 'студентов')}${hasSched ? ' и расписание' : ''} сохранён${hasSched ? 'ы' : ''}`),
      tl(approved ? 'done' : 'now', approved ? 'Заявка одобрена' : 'Подтверждение', approved ? 'Администратор подтвердил группу.' : 'Обычно занимает до суток. Сообщим в Telegram и на почту'),
      tl(approved ? 'now' : 'todo', 'Студенты входят', 'Вы получите код группы, студенты выберут себя в списке'))));
    if (!approved) {
      box.append(h('div', { class: 'j2-field' }, h('span', { text: 'Код группы после подтверждения' }), h('b', { style: 'font-size:17px', text: 'появится здесь' })));
      return;
    }
    const codeBox = h('div', { class: 'j2-card j2-code-box' });
    const msg = h('p', { class: 'j2-msg', id: 'm5', role: 'status', 'aria-live': 'polite' });
    const btn = h('button', { type: 'button', class: 'j2-btn primary', id: 'codeBtn', text: 'Показать код группы' });
    btn.addEventListener('click', () => J2.busy(btn, async () => {
      if (S.codeShown && !S.confirmRotate) {
        S.confirmRotate = true;
        btn.textContent = 'Да, выпустить новый код';
        msg.className = 'j2-msg err';
        msg.textContent = 'Старый код перестанет работать. Если студенты уже получили его, им придётся дать новый. Нажмите кнопку ещё раз, чтобы продолжить.';
        return;
      }
      msg.className = 'j2-msg'; msg.textContent = 'Выпускаем код…';
      const r = await J2.sb.rpc('group_code_rotate', { p_group: S.req.group_id });
      if (r.error || !r.data) { msg.className = 'j2-msg err'; msg.textContent = 'Не получилось получить код. Повторите через минуту.'; return; }
      S.codeShown = true; S.confirmRotate = false;
      showCode(String(r.data), codeBox, msg, btn);
    }));
    codeBox.append(h('h2', { text: 'Заявка одобрена' }), h('p', { text: 'Нажмите кнопку, чтобы получить код группы для студентов.' }));
    box.append(codeBox, msg, btn);
    if (S.code) showCode(S.code, codeBox, msg, btn);
  }
  function showCode(raw, codeBox, msg, btn) {
    S.code = raw;
    clear(codeBox);
    const spaced = raw.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
    const code = h('output', { class: 'j2-code', id: 'code', 'aria-label': `Код группы: ${spaced}`, text: spaced });
    const copy = h('button', { type: 'button', class: 'j2-btn', text: 'Скопировать' });
    copy.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(raw.replace(/\s+/g, '')); ok = true; } catch (e) { /* запасной вариант ниже */ }
      if (!ok) {
        try { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ok = document.execCommand('copy'); } catch (e) { ok = false; }
      }
      msg.className = 'j2-msg ' + (ok ? 'ok' : '');
      msg.textContent = ok ? 'Код скопирован.' : 'Код выделен: скопируйте его вручную.';
    });
    codeBox.append(h('h2', { text: 'Код группы' }), code, copy, h('p', { text: 'Код показывается один раз. Если потеряете, выпустите новый: старый перестанет работать.' }));
    btn.className = 'j2-btn';
    btn.textContent = 'Выпустить новый код';
    msg.className = 'j2-msg'; msg.textContent = '';
  }

  // ---------- запуск ----------
  async function boot() {
    if (!J2.sb) { show(1); say('m1', 'Страница не загрузилась полностью. Обновите её.', 'err'); return; }
    show(1);
    loadLevel(0);
    try {
      const { data } = await J2.sb.auth.getSession();
      if (data && data.session) {
        const found = await loadRequest();
        if (found === 'error') say('m1', 'Не удалось проверить, есть ли у вас начатая заявка. Можно начать заново.', 'err');
      }
    } catch (e) { /* без сессии просто начинаем с шага 1 */ }
  }
  boot();
})();
