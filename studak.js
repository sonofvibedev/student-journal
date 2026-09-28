// Studak — внутренний пропуск группы 24ДММ-2 (вариант «Аврора»). Общий код для cabinet.html (владелец:
// лицевая сторона + QR на обороте) и pass.html (тот, кто сканирует: только лицевая сторона).
// На пропуске только ФИО, роль, номер в списке, логин, фото, вуз, факультет, группа и учебный год —
// никаких пропусков занятий, часов, формы обучения и Telegram-username.
// Анимации — только transform и opacity; при prefers-reduced-motion карточка статичная.

const STUDAK_UNI = 'Белорусский государственный экономический университет';
const STUDAK_FAC = 'Факультет маркетинга и логистики';
const STUDAK_GROUP = '24ДММ-2';

// Учебный год: с сентября — «2026/27»
function studakYear(d = new Date()) {
  const y = d.getFullYear(), s = d.getMonth() >= 8 ? y : y - 1;
  return `${s}/${String(s + 1).slice(2)}`;
}
// Номер в списке — как в журнале на главной: по алфавиту (фамилия, имя)
function studakNumber(students, id) {
  const ordered = [...(students || [])].sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'ru'));
  const i = ordered.findIndex(s => s.id === id);
  return i < 0 ? null : i + 1;
}

// Разметка карты. back: true — с оборотом (QR и отсчёт), false — только лицевая сторона
function studakCardHTML({ back = true } = {}) {
  const aurora = '<div class="sk-aurora" aria-hidden="true"><i></i><i></i><i></i></div>';
  return `<div class="sk-tilt" data-sk="tilt">
    <div class="sk-pass${back ? '' : ' is-static'}" data-sk="pass"${back ? ' tabindex="0" role="button" aria-label="Пропуск Studak. Нажмите, чтобы перевернуть и показать QR-код"' : ' role="img" aria-label="Пропуск Studak"'}>
      <div class="sk-face sk-front">${aurora}
        <div class="sk-in">
          <div class="sk-top"><span class="sk-logo">Studak</span><span class="sk-yr" data-sk="year"></span></div>
          <div class="sk-uni"><span>${STUDAK_UNI}</span><span>${STUDAK_FAC}</span></div>
          <div class="sk-mid">
            <div class="sk-photo" data-sk="photo"></div>
            <div class="sk-who">
              <div class="sk-nm" data-sk="name"></div>
              <div class="sk-role" data-sk="role"></div>
              <div class="sk-tags"><span data-sk="num-wrap">№ <b data-sk="num"></b> в списке</span><span data-sk="login-wrap">логин <b data-sk="login"></b></span></div>
            </div>
            <span aria-hidden="true"></span>
          </div>
          <div class="sk-bottom"><span class="sk-grp">Группа <b>${STUDAK_GROUP}</b> · <span data-sk="year2"></span></span><span class="sk-ok" data-sk="status"><i></i><span data-sk="status-text">Действителен</span></span></div>
        </div>
        <div class="sk-fine">Внутренний пропуск группы, не является официальным документом</div>
      </div>
      ${back ? `<div class="sk-face sk-back">${aurora}
        <div class="sk-qr" data-sk="qr" aria-label="QR-код для проверки пропуска"></div>
        <div class="sk-bk">
          <b class="sk-logo">Studak</b>
          <span data-sk="bk-text">Отсканируйте камерой телефона, чтобы проверить пропуск</span>
          <div class="sk-bar"><i data-sk="bar"></i></div>
          <span class="sk-left" data-sk="left">Получаем код…</span>
        </div>
      </div>` : ''}
    </div>
  </div>`;
}

const skEl = (root, key) => root.querySelector(`[data-sk="${key}"]`);

// Заполнить лицевую сторону. d: { lastName, firstName, role, number, login, photo, initials }
function studakFill(root, d) {
  skEl(root, 'name').textContent = `${d.lastName || ''} ${d.firstName || ''}`.trim() || '—';
  const role = (d.role || '').trim();
  skEl(root, 'role').textContent = role || 'Студент';
  skEl(root, 'num').textContent = d.number ? String(d.number).padStart(2, '0') : '—';
  skEl(root, 'num-wrap').hidden = !d.number;
  skEl(root, 'login').textContent = d.login || '';
  skEl(root, 'login-wrap').hidden = !d.login;
  skEl(root, 'year').textContent = skEl(root, 'year2').textContent = studakYear();
  studakSetPhoto(root, d.photo, d.initials || ((d.firstName || '?')[0] + (d.lastName || '')[0] || '').toUpperCase());
}
// Фото: своё → из Telegram → инициалы (если картинка не загрузилась — тоже инициалы)
function studakSetPhoto(root, url, initials) {
  const box = skEl(root, 'photo');
  box.textContent = initials || '?';
  box.classList.add('is-initials');
  if (!url || !/^(https:|data:image\/|blob:)/i.test(url)) return;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => { box.textContent = ''; box.appendChild(img); box.classList.remove('is-initials'); };
  img.src = url;
}
function studakSetStatus(root, ok, text) {
  const st = skEl(root, 'status');
  st.classList.toggle('is-bad', !ok);
  skEl(root, 'status-text').textContent = text || (ok ? 'Действителен' : 'Недействителен');
}

// QR-код со ссылкой (библиотека qrcode-generator@1.4.4 с CDN, глобальная функция qrcode)
function studakSetQr(root, url) {
  const box = skEl(root, 'qr');
  if (!box) return;
  if (!url) { box.innerHTML = ''; box.classList.add('is-empty'); return; }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  box.classList.remove('is-empty');
  box.dataset.url = url;
}
// Обратный отсчёт на обороте: left — сколько секунд осталось, total — срок кода
function studakSetLeft(root, left, total, text) {
  const l = skEl(root, 'left'), bar = skEl(root, 'bar');
  if (!l) return;
  if (text) { l.textContent = text; bar.style.transform = 'scaleX(0)'; return; }
  const s = Math.max(0, Math.round(left));
  l.innerHTML = `Код обновится через <b>${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</b>`;
  bar.style.transform = `scaleX(${total ? Math.max(0, Math.min(1, left / total)) : 0})`;
}

// Переворот по нажатию и клавишей
function studakBindFlip(root, onFlip) {
  const pass = skEl(root, 'pass');
  if (!pass || pass.classList.contains('is-static')) return;
  const flip = () => { pass.classList.toggle('is-flipped'); if (onFlip) onFlip(pass.classList.contains('is-flipped')); };
  pass.addEventListener('click', (e) => { if (pass.dataset.dragged) { delete pass.dataset.dragged; return; } flip(); });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
}

// Наклон: DeviceOrientation (на iPhone — по разрешению, кнопкой askBtn), мышь на компьютере;
// без датчика или без разрешения — плавная автоанимация. Возвращает функцию остановки.
function studakTilt(root, askBtn) {
  const tilt = skEl(root, 'tilt');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!tilt || reduce) { if (askBtn) askBtn.hidden = true; return () => {}; }
  let got = false;
  const set = (x, y) => { tilt.style.setProperty('--tx', x.toFixed(3)); tilt.style.setProperty('--ty', y.toFixed(3)); };
  const onOrient = (e) => {
    if (e.gamma == null) return;
    got = true; tilt.classList.remove('is-auto');
    set(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 30)));
  };
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = tilt.getBoundingClientRect();
    got = true; tilt.classList.remove('is-auto');
    set(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
  };
  tilt.classList.add('is-auto');
  tilt.addEventListener('pointermove', onMove);
  const needsAsk = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  if (!needsAsk) window.addEventListener('deviceorientation', onOrient);
  if (askBtn) {
    askBtn.hidden = !needsAsk;
    askBtn.onclick = async () => {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') { askBtn.textContent = 'Наклон не разрешён — показываем автоанимацию'; return; }
        window.addEventListener('deviceorientation', onOrient);
        askBtn.hidden = true;
      } catch (e) { askBtn.textContent = 'Наклон недоступен — показываем автоанимацию'; }
    };
  }
  return () => { window.removeEventListener('deviceorientation', onOrient); tilt.removeEventListener('pointermove', onMove); };
}
