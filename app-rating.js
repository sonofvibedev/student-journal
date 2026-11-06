// «Журнал 2.0»: калькулятор рейтинга внутри кабинета студента (#/study/rating).
// Формулы и формат хранения те же, что в старом журнале (profile.js: avgOf, recalcRating, ratingFinalOf; shared.js: ratingStore*),
// поэтому расчёты, начатые в старом калькуляторе, открываются здесь как есть. Старые ключи localStorage не удаляются.
// Семинарские = ср(контрольные) × k1 + ср(устные) × (1 − k1); итог = семинарские × w1 + экзамен × (1 − w1);
// у зачётного предмета без экзамена итог = семинарские. Оценки живут только в браузере студента (rating_calc_subjects).
'use strict';
(function (root) {
  // ---------- хранилище (перенос из shared.js) ----------
  const EMPTY = { control: [], oral: [], exam: '', k1: 0.5, w1: 0.6 };
  const grades = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);   // мусор отбрасываем, а не роняем калькулятор
  const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const shape = (raw) => (!raw || typeof raw !== 'object' ? { ...EMPTY, control: [], oral: [] } : {
    control: grades(raw.control), oral: grades(raw.oral), exam: raw.exam == null || raw.exam === '' ? '' : String(raw.exam),
    k1: numOr(raw.k1, EMPTY.k1), w1: numOr(raw.w1, EMPTY.w1) });
  const storeRead = (text) => {
    if (!text) return {};
    try { const p = JSON.parse(text); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch (e) { return {}; }
  };
  const storeFor = (store, subject) => shape(store && store[subject]);
  const storeWrite = (store, subject, calc) => ({ ...(store || {}), [subject]: shape(calc) });
  const subjectsDone = (store) => Object.keys(store || {}).filter((s) => { const c = storeFor(store, s); return c.control.length > 0 || c.oral.length > 0; });

  // ---------- расчёт ----------
  // Коэффициенты как у прежних ползунков: k1 из 0.5 / 0.6 / 0.7, w1 из 0.4 / 0.5. Сохранённое значение вне набора (например, w1 = 0.6 по умолчанию) прижимается к ближайшему
  const K1 = [0.5, 0.6, 0.7], W1 = [0.4, 0.5];
  const snap = (v, list) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  const fit = (calc) => ({ ...calc, k1: snap(calc.k1, K1), w1: snap(calc.w1, W1) });
  const avgOf = (arr) => (arr.length ? arr.reduce((s, v) => s + Number(v), 0) / arr.length : 0);
  const seminarOf = (c) => avgOf(c.control) * c.k1 + avgOf(c.oral) * (1 - c.k1);
  const finalOf = (c, hasExam) => {
    if (!c.control.length && !c.oral.length) return null;
    const sem = seminarOf(c);
    if (!hasExam) return sem;
    const exam = parseFloat(c.exam);
    return isNaN(exam) ? null : sem * c.w1 + exam * (1 - c.w1);
  };
  // Есть ли экзамен: по заданиям предмета с типом exam/zachet. Известны только зачёты → экзамена нет; ничего не известно → считаем, что есть
  const hasExamOf = (tasks) => { const rows = tasks.filter((t) => t.type === 'zachet' || t.type === 'exam'); return !rows.length || rows.some((t) => t.type === 'exam'); };
  const band = (v) => (v == null ? '' : v < 4 ? 'low' : v < 7 ? 'mid' : 'high');
  const BAND_TEXT = { low: 'меньше 4', mid: 'от 4 до 7', high: '7 и выше' };
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const f2 = (v) => v.toFixed(2).replace('.', ',');

  const R = { EMPTY, shape, storeRead, storeFor, storeWrite, subjectsDone, K1, W1, snap, fit, avgOf, seminarOf, finalOf, hasExamOf, band, BAND_TEXT, norm };
  root.Rating = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
  if (!root.Cab) return;

  // ---------- экран ----------
  const { h, raw, str, sb } = Cab;
  const STORE_KEY = 'rating_calc_subjects', SUBJECT_KEY = 'rating_calc_subject';
  const pair = (k) => `${k.toFixed(1).replace('.', ',')} / ${(1 - k).toFixed(1).replace('.', ',')}`;

  Cab.ratingScreen = async function (el, ctx, nav) {
    const sg = Number(ctx.student.subgroup) || 0;
    const [lessons, tasks] = await Promise.all([
      Cab.q(sb.from('schedule_lessons').select('subject,subgroup').eq('group_id', ctx.group.id).limit(2000)),
      Cab.q(sb.from('tasks').select('id,kind,rec,created_by').eq('group_id', ctx.group.id)).then((r) => r.map(Cab.task)).catch(() => []),
    ]);
    if (!nav.isCurrent()) return;
    let store = storeRead(lsGet(STORE_KEY));
    // предметы: расписание группы + задания + те, где расчёт уже начат; без повторов с точностью до регистра и пробелов
    const names = new Map();
    const add = (s) => { const n = String(s || '').replace(/\s+/g, ' ').trim(); if (n && !names.has(norm(n))) names.set(norm(n), n); };
    lessons.filter((l) => !l.subgroup || !sg || Number(l.subgroup) === sg).forEach((l) => add(l.subject));
    tasks.forEach((t) => add(t.subject));
    subjectsDone(store).forEach(add);
    const list = [...names.values()].sort((a, b) => a.localeCompare(b, 'ru'));
    const examOf = (name) => hasExamOf(tasks.filter((t) => norm(t.subject) === norm(name) && Cab.taskVisible(t, sg)));

    let subject = lsGet(SUBJECT_KEY) || '';
    if (!list.includes(subject)) subject = list[0] || '';
    let calc, examVal, notYet;
    const load = () => { calc = fit(storeFor(store, subject)); const e = parseFloat(calc.exam); notYet = isNaN(e); examVal = isNaN(e) ? 8 : e; };
    const save = () => { calc.exam = notYet ? '' : String(examVal); store = storeWrite(store, subject, calc); lsSet(STORE_KEY, JSON.stringify(store)); };
    load();

    if (!list.length) {
      el.innerHTML = str(h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Рейтинг</h1><p class="cab-sub">Калькулятор по предметам</p>
        <div class="cab-empty">Предметов пока нет: они появятся после загрузки расписания.</div>`);
      return;
    }

    const keys = (type) => h`<div class="rc-keys" role="group" aria-label="${type === 'control' ? 'Добавить оценку за контрольную' : 'Добавить устную оценку'}">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => h`<button type="button" data-add="${type}" data-v="${n}" aria-label="Добавить ${n}">${n}</button>`)}</div>`;
    const block = (type, title) => h`<h2 class="cab-h2"><span>${title}</span><span class="c-mute rc-avg" id="rcAvg-${type}"></span></h2>${keys(type)}<div class="rc-pills" id="rcPills-${type}"></div>`;
    const seg = (attr, vals, label) => h`<div class="cab-seg2" role="group" aria-label="${label}">${vals.map((v) => h`<button type="button" ${raw('data-' + attr)}="${v}" aria-pressed="false">${pair(v)}</button>`)}</div>`;

    el.innerHTML = str(h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Рейтинг</h1><p class="cab-sub">Калькулятор по предметам. Оценки хранятся только на этом устройстве.</p>
      <label class="j2-field"><span>Предмет</span><select id="rcSubj">${list.map((n) => h`<option value="${n}"${n === subject ? raw(' selected') : ''}>${n}</option>`)}</select></label>
      <div id="rcDoneWrap"><h2 class="cab-h2"><span>Уже посчитано</span></h2><div class="rc-done" id="rcDone"></div></div>
      <div class="cab-card rc-final" id="rcFinal" role="status" aria-live="polite"></div>
      ${block('control', 'Контрольные')}${block('oral', 'Устные')}
      <h2 class="cab-h2"><span>Коэффициенты</span></h2>
      <p class="cab-note rc-lab">Контрольные / устные</p>${seg('k1', K1, 'Доля контрольных и устных в семинарских')}
      <div id="rcExamBox"><p class="cab-note rc-lab">Семестр / экзамен</p>${seg('w1', W1, 'Доля семестра и экзамена в итоге')}
        <h2 class="cab-h2"><span>Оценка на экзамене</span></h2>
        <div class="hm-step" id="rcStep"><span id="rcExamLbl">Экзамен</span><div><button type="button" id="rcMinus" aria-label="Меньше на 0,5">−</button><output id="rcExam" aria-live="polite"></output><button type="button" id="rcPlus" aria-label="Больше на 0,5">+</button></div></div>
        <label class="cab-chk"><input type="checkbox" id="rcNot"><span>Экзамен ещё не сдан</span></label></div>
      <button class="j2-btn danger" id="rcClear" type="button">Очистить расчёт</button>`);

    const $ = (s) => el.querySelector(s), $$ = (s) => [...el.querySelectorAll(s)];
    function paint() {
      const has = examOf(subject), fin = finalOf(calc, has), b = band(fin), sem = calc.control.length || calc.oral.length ? seminarOf(calc) : null;
      ['control', 'oral'].forEach((t) => {
        $('#rcPills-' + t).innerHTML = str(calc[t].length ? calc[t].map((g, i) => h`<button type="button" class="rc-pill" data-rm="${t}" data-i="${i}" aria-label="Убрать оценку ${g}">${g}</button>`) : h`<span class="cab-note">Пока нет оценок</span>`);
        $('#rcAvg-' + t).textContent = calc[t].length ? `средний балл ${f2(avgOf(calc[t]))}` : '';
      });
      $$('[data-k1]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.k1 === calc.k1)));
      $$('[data-w1]').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.w1 === calc.w1)));
      $('#rcExamBox').classList.toggle('j2-hidden', !has);
      $('#rcExam').textContent = notYet ? '—' : String(examVal).replace('.', ',');
      $('#rcNot').checked = notYet;
      const formula = sem == null ? 'Добавьте оценки за семинары'
        : !has ? 'Зачёт без экзамена: итог — рейтинг за семестр'
        : fin == null ? 'Укажите оценку на экзамене'
        : `${f2(sem)} × ${calc.w1.toFixed(1).replace('.', ',')} + ${String(examVal).replace('.', ',')} × ${(1 - calc.w1).toFixed(1).replace('.', ',')} = ${f2(fin)}`;
      $('#rcFinal').className = 'cab-card rc-final' + (b ? ' rc-' + b : '');
      $('#rcFinal').innerHTML = str(h`<p>Итоговый рейтинг</p><div class="rc-line"><b class="rc-big">${fin == null ? '—' : f2(fin)}</b>${b ? h`<span class="rc-band">${BAND_TEXT[b]}</span>` : ''}</div>
        <p class="rc-formula">${formula}</p>${sem != null ? h`<p class="rc-formula">Семинарские: ${f2(sem)}</p>` : ''}`);
      const done = subjectsDone(store);
      $('#rcDoneWrap').classList.toggle('j2-hidden', !done.length);
      $('#rcDone').innerHTML = str(done.map((n) => { const v = finalOf(fit(storeFor(store, n)), examOf(n)), bb = band(v);
        return h`<button type="button" class="rc-done-item${n === subject ? ' now' : ''}" data-done="${n}"><span>${n}</span><b class="${bb ? 'rc-t-' + bb : ''}">${v == null ? '—' : f2(v)}</b></button>`; }));
    }
    const switchTo = (name) => { subject = name; lsSet(SUBJECT_KEY, subject); load(); $('#rcSubj').value = subject; paint(); };

    el.onclick = async (e) => {
      const add1 = e.target.closest('button[data-add]'), rm = e.target.closest('button[data-rm]');
      if (add1) { calc[add1.dataset.add].push(+add1.dataset.v); save(); paint(); return; }
      if (rm) { calc[rm.dataset.rm].splice(+rm.dataset.i, 1); save(); paint(); return; }
      const k = e.target.closest('button[data-k1]'), w = e.target.closest('button[data-w1]'), d = e.target.closest('button[data-done]');
      if (k) { calc.k1 = +k.dataset.k1; save(); paint(); return; }
      if (w) { calc.w1 = +w.dataset.w1; save(); paint(); return; }
      if (d) { switchTo(d.dataset.done); return; }
      const step = e.target.closest('#rcMinus, #rcPlus');
      if (step) { examVal = Math.max(0, Math.min(10, examVal + (step.id === 'rcPlus' ? 0.5 : -0.5))); notYet = false; save(); paint(); return; }
      if (e.target.closest('#rcClear')) {
        if (!(await Cab.ask('Очистить расчёт?', `Оценки по предмету «${subject}» будут удалены. Расчёты по другим предметам останутся.`, 'Очистить'))) return;
        calc = { control: [], oral: [], exam: '', k1: calc.k1, w1: calc.w1 }; notYet = true; examVal = 8; save(); paint();
      }
    };
    el.onchange = (e) => {
      if (e.target.id === 'rcSubj') switchTo(e.target.value);
      else if (e.target.id === 'rcNot') { notYet = e.target.checked; save(); paint(); }
    };
    paint();
  };
})(typeof window !== 'undefined' ? window : globalThis);
