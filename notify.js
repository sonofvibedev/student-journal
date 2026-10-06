// Напоминания о дедлайнах и домашке.
//
// Как это работает на самом деле — три разные среды:
//   * Android и установленное PWA — обычный Web Push через сервис-воркер;
//   * iPhone — Web Push только если сайт добавлен на экран «Домой» (iOS 16.4+).
//     В обычном Safari разрешение не запрашиваем вовсе: там его просто нет,
//     вместо этого показываем, как добавить сайт на экран;
//   * внутри Telegram браузерные уведомления недоступны, поэтому просим
//     Telegram.WebApp.requestWriteAccess() и напоминания присылает бот.
//
// Системное окно запроса вызывается ТОЛЬКО по нажатию кнопки в нашем окне:
// Safari блокирует запрос, сделанный сам по себе, при загрузке страницы.
//
// Отправка по расписанию — на сервере (Supabase: Edge Function + pg_cron).
// Здесь же есть подстраховка: пока приложение открыто, оно само проверяет
// сроки и показывает напоминание, если сервер до него не достучался.

'use strict';

// Публичный ключ VAPID — он и должен лежать в коде страницы.
// Приватный хранится только в секретах Supabase.
const VAPID_PUBLIC_KEY = 'BNRe_JXPEG1N4e22RWO6Up50UGNq4TASmFWOtnqwxzgX1sAhaJfxR-BXUVe9PcHmBKfjpE6L8AscrL-3HZa1WNI';

const NOTIFY_SEEN_KEY = 'notify_prompt_seen';   // версия, на которой окно уже показывали
const NOTIFY_MODE_KEY = 'notify_mode';          // '' | 'web' | 'telegram'
const NOTIFY_SHOWN_KEY = 'notify_shown';        // какие напоминания уже показаны на этом устройстве

// --- Где мы находимся ---
function notifyTelegram() {
  const tg = window.Telegram && window.Telegram.WebApp;
  return tg && tg.initData ? tg : null;
}
function notifyIsIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS притворяется Mac
}
function notifyIsStandalone() {
  if (window.navigator.standalone) return true;                            // iOS: добавлено на «Домой»
  try { return matchMedia('(display-mode: standalone)').matches; } catch (e) { return false; }
}
function notifyEnvironment() {
  if (notifyTelegram()) return 'telegram';
  if (notifyIsIOS() && !notifyIsStandalone()) return 'ios-browser';         // Web Push недоступен
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return 'web';
}
function notifyPermission() {
  return ('Notification' in window) ? Notification.permission : 'unsupported';
}

// Человеческое описание текущего состояния — для строки настроек
function notifyStatusText() {
  const env = notifyEnvironment();
  if (env === 'telegram') return lsGet(NOTIFY_MODE_KEY) === 'telegram' ? 'Включены, присылает бот' : 'Выключены';
  if (env === 'ios-browser') return 'Нужно добавить сайт на экран «Домой»';
  if (env === 'unsupported') return 'Браузер не поддерживает';
  const p = notifyPermission();
  if (p === 'granted') return lsGet(NOTIFY_MODE_KEY) === 'web' ? 'Включены' : 'Разрешены браузером';
  if (p === 'denied') return 'Запрещены в настройках браузера';
  return 'Выключены';
}

// --- Окно с объяснением ---
// Разметку держим здесь, а не в двух страницах сразу: так текст один и тот же.
function notifyEnsureModal() {
  if (document.getElementById('notifyPromptModal')) return;
  const html = `
<div class="modal fade" id="notifyPromptModal" tabindex="-1" aria-labelledby="notifyPromptTitle">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title text-white" id="notifyPromptTitle">Напоминать о сроках?</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Закрыть"></button>
      </div>
      <div class="modal-body">
        <p class="mb-2" id="notifyPromptText"></p>
        <ul class="small text-secondary ps-3 mb-0" id="notifyPromptList"></ul>
      </div>
      <div class="modal-footer flex-column gap-2">
        <button type="button" class="btn btn-primary fw-bold w-100" id="notifyAllowBtn">Разрешить уведомления</button>
        <button type="button" class="btn btn-link w-100 text-secondary" data-bs-dismiss="modal" id="notifyLaterBtn">Не сейчас</button>
      </div>
    </div>
  </div>
</div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('notifyAllowBtn').addEventListener('click', enableNotifications);
  document.getElementById('notifyLaterBtn').addEventListener('click', () => lsSet(NOTIFY_SEEN_KEY, APP_VERSION));
}

function notifyFillModal() {
  const env = notifyEnvironment();
  const text = document.getElementById('notifyPromptText');
  const list = document.getElementById('notifyPromptList');
  const allow = document.getElementById('notifyAllowBtn');
  list.innerHTML = '';
  const add = (s) => { const li = document.createElement('li'); li.textContent = s; list.appendChild(li); };

  if (env === 'telegram') {
    text.textContent = 'Внутри Telegram браузерные уведомления не работают, зато напоминание может прислать бот — обычным сообщением.';
    add('За день до срока и в день срока, в 9:00 по Минску');
    add('Только дедлайны и домашка вашей группы');
    add('Отключить можно в кабинете в любой момент');
    allow.textContent = 'Разрешить сообщения от бота';
    allow.classList.remove('d-none');
  } else if (env === 'ios-browser') {
    text.textContent = 'На iPhone уведомления приходят только если сайт добавлен на экран «Домой». Это занимает полминуты:';
    add('Нажмите «Поделиться» внизу Safari');
    add('Выберите «На экран „Домой“»');
    add('Откройте журнал с экрана «Домой» и включите уведомления в кабинете');
    allow.classList.add('d-none');
  } else if (env === 'unsupported') {
    text.textContent = 'Этот браузер не умеет показывать уведомления. Откройте журнал в Chrome или Safari либо добавьте его на экран «Домой».';
    allow.classList.add('d-none');
  } else {
    text.textContent = 'Журнал может напоминать о дедлайнах и домашке, чтобы ничего не потерялось.';
    add('За день до срока и в день срока, в 9:00 по Минску');
    add('Только дедлайны и домашка вашей группы — ничего лишнего');
    add('Отключить можно в кабинете в любой момент');
    allow.textContent = 'Разрешить уведомления';
    allow.classList.remove('d-none');
  }
}

// Показать окно. force = true — открыли вручную из настроек.
function openNotifyPrompt(force) {
  if (typeof bootstrap === 'undefined') return;
  notifyEnsureModal();
  notifyFillModal();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('notifyPromptModal')).show();
  if (!force) lsSet(NOTIFY_SEEN_KEY, APP_VERSION);
}

// Первый вход после обновления: показываем окно один раз на версию
function maybeShowNotifyPrompt() {
  if (lsGet(NOTIFY_SEEN_KEY) === APP_VERSION) return;
  if (lsGet(NOTIFY_MODE_KEY)) { lsSet(NOTIFY_SEEN_KEY, APP_VERSION); return; }   // уже включены
  if (notifyPermission() === 'denied') { lsSet(NOTIFY_SEEN_KEY, APP_VERSION); return; }
  openNotifyPrompt(false);
}

// --- Включение. Системный запрос — только отсюда, из обработчика нажатия ---
async function enableNotifications() {
  const env = notifyEnvironment();
  const close = () => {
    const el = document.getElementById('notifyPromptModal');
    if (el && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(el).hide();
  };

  if (env === 'telegram') {
    const tg = notifyTelegram();
    if (!tg.requestWriteAccess) { showNotifyAlert('Эта версия Telegram не умеет присылать сообщения от бота. Обновите приложение.'); return; }
    tg.requestWriteAccess(async (granted) => {
      if (!granted) { showNotifyAlert('Без разрешения бот не сможет прислать напоминание.'); return; }
      const ok = await notifySubscribeTelegram(tg.initData);
      lsSet(NOTIFY_MODE_KEY, ok ? 'telegram' : '');
      if (ok && typeof achLogEvent === 'function') achLogEvent('notifications_on');   // достижение «Всегда в курсе»
      lsSet(NOTIFY_SEEN_KEY, APP_VERSION);
      renderNotifySettings();
      close();
      showNotifyAlert(ok ? 'Готово. Напоминания придут сообщением от бота.' : 'Разрешение получено, но подписку сохранить не удалось. Попробуйте позже.');
    });
    return;
  }

  if (env === 'ios-browser' || env === 'unsupported') { close(); return; }

  let permission;
  try { permission = await Notification.requestPermission(); } catch (e) { permission = 'denied'; }
  lsSet(NOTIFY_SEEN_KEY, APP_VERSION);
  if (permission !== 'granted') {
    renderNotifySettings();
    close();
    showNotifyAlert('Уведомления не разрешены. Включить их можно в настройках браузера или позже в кабинете.');
    return;
  }

  const ok = await notifySubscribePush();
  lsSet(NOTIFY_MODE_KEY, ok ? 'web' : '');
  if (ok && typeof achLogEvent === 'function') achLogEvent('notifications_on');       // достижение «Всегда в курсе»
  renderNotifySettings();
  close();
  showNotifyAlert(ok
    ? 'Готово. Напомним за день до срока и в день срока.'
    : 'Разрешение получено, но подписку сохранить не удалось — напоминания будут приходить, пока журнал открыт.');
  checkLocalReminders();
}

function showNotifyAlert(text) {
  if (typeof showAlert === 'function') showAlert(text);
  else alert(text);
}

// base64url → Uint8Array (так ключ ждёт pushManager)
function notifyUrlBase64ToBytes(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Сохранить подписку в Supabase. Без входа в кабинет сохранять некуда:
// напоминания тогда работают только пока журнал открыт.
async function notifySaveSubscription(subscription) {
  const client = typeof sb !== 'undefined' ? sb : null;
  if (!client) return false;
  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session) return false;
    const json = subscription.toJSON();
    const { error } = await client.from('push_subscriptions').upsert({
      user_id: session.user.id,
      endpoint: json.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 300)
    }, { onConflict: 'endpoint' });
    if (error) { console.warn('Подписка не сохранена:', error.message); return false; }
    return true;
  } catch (e) { console.warn('Подписка не сохранена:', e); return false; }
}

async function notifySubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: notifyUrlBase64ToBytes(VAPID_PUBLIC_KEY)
      });
    }
    return await notifySaveSubscription(subscription);
  } catch (e) { console.warn('Push недоступен:', e); return false; }
}

// Telegram: initData проверяет сервер (подпись бота), поэтому chat_id из него брать безопасно
async function notifySubscribeTelegram(initData) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/subscribe-telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ initData })
    });
    return res.ok;
  } catch (e) { console.warn('Телеграм-подписка не сохранена:', e); return false; }
}

async function disableNotifications() {
  lsSet(NOTIFY_MODE_KEY, '');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      const client = typeof sb !== 'undefined' ? sb : null;
      if (client) await client.from('push_subscriptions').delete().eq('endpoint', endpoint);
    }
  } catch (e) { console.warn('Отписка:', e); }
  renderNotifySettings();
}

// --- Строка «Уведомления» в кабинете ---
function renderNotifySettings() {
  const value = document.getElementById('notifyStateValue');
  if (value) value.textContent = notifyStatusText();
  const btn = document.getElementById('notifyToggleBtn');
  if (btn) {
    const on = !!lsGet(NOTIFY_MODE_KEY);
    btn.textContent = on ? 'Выключить' : 'Включить';
    btn.onclick = on ? disableNotifications : () => openNotifyPrompt(true);
  }
}

// --- Подстраховка: пока журнал открыт, он сам проверяет сроки ---
// Сервер шлёт напоминания в 9:00; это — на случай, если до устройства они не дошли.
function notifyShownMap() {
  try { return JSON.parse(lsGet(NOTIFY_SHOWN_KEY) || '{}'); } catch (e) { return {}; }
}
function notifyMarkShown(key) {
  const map = notifyShownMap();
  map[key] = Date.now();
  // Чистим записи старше месяца, чтобы ключ не рос без конца
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
  Object.keys(map).forEach((k) => { if (map[k] < monthAgo) delete map[k]; });
  lsSet(NOTIFY_SHOWN_KEY, JSON.stringify(map));
}

// Что напомнить сегодня: срок сегодня или завтра
function notifyDueToday() {
  if (typeof appData === 'undefined' || !appData) return [];
  const items = [];
  (appData.deadlines || []).forEach((d) => items.push({ id: d.id, kind: 'Дедлайн', subject: d.subject, text: d.text, dueDate: d.dueDate }));
  (appData.homework || []).forEach((h) => items.push({ id: h.id, kind: 'Домашка', subject: h.subject, text: h.text, dueDate: h.dueDate }));
  return items.filter((i) => {
    const left = deadlineDaysLeft(i.dueDate);
    return left === 0 || left === 1;
  });
}

function checkLocalReminders() {
  if (notifyPermission() !== 'granted') return;
  const shown = notifyShownMap();
  notifyDueToday().forEach((item) => {
    const left = deadlineDaysLeft(item.dueDate);
    const key = `${item.id}:${left}`;
    if (shown[key]) return;
    const title = left === 0 ? `${item.kind}: сегодня` : `${item.kind}: завтра`;
    const body = [item.subject, item.text].filter(Boolean).join(' — ');
    try {
      new Notification(title, { body, tag: key, icon: 'icons/icon-192.png' });
      notifyMarkShown(key);
    } catch (e) { console.warn('Уведомление не показано:', e); }
  });
}

// ============================================================================
// Уведомления: красный кружок на колокольчике и лист «Уведомления».
//
// Непрочитанным считается то, что появилось после последнего просмотра листа.
// Событий четыре вида: добавлен новый дедлайн, добавлена новая домашка, вышла
// новая версия приложения (по CHANGELOG из changelog.js) и получен новый
// значок (их держит achievements.js).
//
// Просмотренное лежит в localStorage: id записей и номера версий. При самом
// первом запуске всё текущее сразу помечается прочитанным — иначе студент
// увидел бы «новым» весь журнал сразу.
// ============================================================================

const NOTIFY_READ_KEY = 'notifications_read';   // { deadlines: [id], homework: [id], versions: ['1.3'], achievements: [code] }

// null — ключа ещё нет, то есть лист ни разу не открывали на этом устройстве
function notificationsRead() {
  let saved = null;
  try { saved = JSON.parse(lsGet(NOTIFY_READ_KEY) || 'null'); } catch (e) {}
  if (!saved || typeof saved !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    deadlines: list(saved.deadlines),
    homework: list(saved.homework),
    versions: list(saved.versions),
    achievements: list(saved.achievements)
  };
}
function writeNotificationsRead(read) {
  try { lsSet(NOTIFY_READ_KEY, JSON.stringify(read)); } catch (e) {}
}

// Дата события приходит в трёх видах: ISO от createdAt, «ГГГГ-ММ-ДД» от срока
// и «ДД.ММ.ГГГГ[, ЧЧ:ММ]» из changelog.js. Сравнивать их как строки нельзя.
function notifyTimeOf(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:,\s*(\d{2}):(\d{2}))?$/);
  if (ru) return new Date(+ru[3], +ru[2] - 1, +ru[1], +(ru[4] || 0), +(ru[5] || 0)).getTime();
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

// Все события, которые вообще могут попасть в лист, — новые сверху
function notificationItems() {
  if (typeof appData === 'undefined' || !appData) return [];
  const out = [];
  (appData.deadlines || []).forEach((d) => out.push({
    group: 'deadlines',
    id: String(d.id),
    at: notifyTimeOf(d.createdAt || d.dueDate),
    kind: typeof deadlineKindName === 'function' ? deadlineKindName(d) : 'Дедлайн',
    title: d.text || d.subject,
    sub: d.subject,
    day: d.dueDate
  }));
  (appData.homework || []).forEach((h) => out.push({
    group: 'homework',
    id: String(h.id),
    at: notifyTimeOf(h.createdAt || h.dueDate),
    kind: 'Домашка',
    title: h.text || h.subject,
    sub: h.subject,
    day: h.dueDate
  }));
  // Значки: их считает и хранит achievements.js
  if (typeof achState !== 'undefined' && achState.earned) {
    achState.earned.forEach((row, code) => {
      const a = (typeof ACH_BY_CODE !== 'undefined' && ACH_BY_CODE[code]) || null;
      if (!a || a.anti) return;                 // антидостижения в уведомления не идут
      out.push({
        group: 'achievements',
        id: String(code),
        at: notifyTimeOf(row.earned_at),
        kind: 'Достижение',
        title: a.title,
        sub: 'новый значок',
        day: null
      });
    });
  }
  (typeof CHANGELOG === 'undefined' ? [] : CHANGELOG).forEach((e) => out.push({
    group: 'versions',
    id: String(e.version),
    at: notifyTimeOf(changelogDate(e)),
    kind: 'Обновление',
    title: e.title || ('Версия ' + e.version),
    sub: 'Версия ' + e.version,
    day: null
  }));
  return out.sort((a, b) => b.at - a.at);
}

function unreadNotifications() {
  const read = notificationsRead();
  if (!read) return [];                        // первый запуск: нового нет по определению
  return notificationItems().filter((i) => read[i.group].indexOf(i.id) === -1);
}

// Всё текущее — прочитано. Вызывается при открытии листа и один раз при
// самом первом запуске, чтобы старые записи не считались новыми.
function markNotificationsRead() {
  const read = { deadlines: [], homework: [], versions: [], achievements: [] };
  notificationItems().forEach((i) => read[i.group].push(i.id));
  writeNotificationsRead(read);
}
function primeNotificationsRead() {
  if (!notificationsRead()) markNotificationsRead();
}

// Окно про уведомления показываем после «Что нового», а не поверх него
function startNotifyFlow(whatsNewShown) {
  const el = document.getElementById('whatsNewModal');
  if (whatsNewShown && el) el.addEventListener('hidden.bs.modal', () => maybeShowNotifyPrompt(), { once: true });
  else maybeShowNotifyPrompt();
}

// Проверяем при возвращении на страницу — как в приложениях с напоминаниями
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkLocalReminders(); });
