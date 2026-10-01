// Версия приложения и история изменений — одно место для index.html и cabinet.html.
//
// Нумерация: крупное обновление — 1.1, 1.2, 1.3; мелкие правки — 1.1.1, 1.1.2.
// APP_VERSION_DATE проставляет скрипт деплоя (deploy-fix.ps1 / deploy-test.ps1) —
// руками её трогать не нужно.
//
// Окно «Что нового» показывается один раз на каждую новую версию: в localStorage
// лежит версия, которую пользователь уже видел (ключ whats_new_seen).

'use strict';

const APP_VERSION = '1.2';
const APP_VERSION_DATE = '02.10.2026, 02:08';

// Сверху — самая новая версия. date у прошлых версий фиксированная;
// у текущей берётся APP_VERSION_DATE, которую ставит деплой.
const CHANGELOG = [
  {
    version: '1.2',
    title: 'Расписание, которое показывает, что происходит сейчас',
    items: [
      'В «Домашке» видно, какая пара идёт прямо сейчас: полоса прогресса и «Идёт · ещё N мин», а у ближайшей — «Через N мин»',
      'Нажмите на занятие — откроется карточка с аудиторией, преподавателем, домашкой и отметкой «Сделано»',
      'Свайп по списку листает дни, по строке недели — недели; кнопка «Сегодня» возвращает к текущей',
      'Переключатель подгрупп убран: виден весь день группы, а занятия одной подгруппы помечены «1 пгр.» и «2 пгр.»',
      'Пять цветовых гамм на выбор: Синий, Изумруд, Индиго, Янтарь и Мягкий бордо — в кабинете, раздел «Оформление»',
      'Новая иконка «Домашки» в нижней панели, подписи выровнены на узких экранах'
    ]
  },
  {
    version: '1.1',
    date: '01.10.2026, 21:39',
    title: 'Домашка, темы оформления и напоминания',
    items: [
      'Новый раздел «Домашка»: расписание группы 24ДММ-2 на семестр и домашние задания, привязанные к занятиям',
      'Статистика на главной теперь по умолчанию за текущий месяц — период подписан рядом с заголовком',
      'Светлая и тёмная темы плюс шесть цветовых гамм на выбор — в личном кабинете, раздел «Оформление»',
      'Тема «Системная» следует настройке телефона, а в Telegram — теме Telegram',
      'Напоминания о дедлайнах и домашке: за день до срока и в день срока',
      'В кабинете внизу — номер версии и полная история изменений'
    ]
  },
  {
    version: '1.0',
    date: '28.09.2026, 15:40',
    title: 'Всё, что было до перехода на новую нумерацию',
    items: [
      'Studak — электронный пропуск группы: кнопка «Studak» в шапке личного кабинета открывает его на весь экран',
      'Нажмите на пропуск — на обороте QR-код. Он одноразовый, живёт 5 минут и сам обновляется, пока пропуск открыт',
      'QR проверяется камерой любого телефона без входа: видно только ФИО, роль, номер в списке, логин и фото',
      'В Telegram в кабинете появилась строка «Сканировать пропуск» — проверка QR прямо в мини-приложении',
      'Пропуск закрывается крестиком или свайпом вниз, наклоняется вслед за телефоном',
      'Личный кабинет с входом по логину и паролю, зачётка, калькулятор рейтинга, дедлайны и объявления старосты'
    ]
  }
];

// Дата версии: у текущей — та, что проставил деплой
function changelogDate(entry) {
  return entry.version === APP_VERSION ? APP_VERSION_DATE : (entry.date || '');
}

function changelogEntry(version) {
  return CHANGELOG.find((e) => e.version === version) || CHANGELOG[0];
}

// --- «Что нового»: показываем один раз на версию ---
function whatsNewSeen() {
  return String(lsGet('whats_new_seen') || '');
}
function markWhatsNewSeen() {
  lsSet('whats_new_seen', APP_VERSION);
}

// Заполняет окно и показывает его. force = true — открыть вручную, даже если уже видели.
function showWhatsNew(force) {
  const modalEl = document.getElementById('whatsNewModal');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  const entry = changelogEntry(APP_VERSION);

  const head = document.getElementById('whatsNewDate');
  if (head) head.textContent = `Версия ${APP_VERSION} · ${changelogDate(entry)}`;
  const list = document.getElementById('whatsNewList');
  if (list) {
    list.innerHTML = '';
    entry.items.forEach((text) => {
      const li = document.createElement('li');
      li.className = 'mb-1';
      li.textContent = text;
      list.appendChild(li);
    });
  }
  modalEl.addEventListener('hidden.bs.modal', markWhatsNewSeen, { once: true });
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  if (force) markWhatsNewSeen();
}

// Вызывается при запуске страницы: показать, если этой версии ещё не видели.
// Прошлые версии хранились числом (10) — оно не совпадёт с «1.1», и окно покажется один раз.
// Возвращает true, если окно показали: следом за ним странице нужно
// показать окно про уведомления, а не поверх него.
function checkWhatsNew() {
  if (whatsNewSeen() === APP_VERSION) return false;
  showWhatsNew(false);
  return true;
}

// --- Окно «История изменений» (кнопка внизу личного кабинета) ---
function openChangelogModal() {
  const modalEl = document.getElementById('changelogModal');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  renderChangelogHistory('changelogList');
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

// Подпись с номером версии внизу кабинета
function renderAppVersionLabel(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = APP_VERSION;
}

// --- Полная история: заполняет контейнер по id ---
function renderChangelogHistory(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  CHANGELOG.forEach((entry) => {
    const block = document.createElement('div');
    block.className = 'cl-entry';

    const head = document.createElement('div');
    head.className = 'cl-head';
    const ver = document.createElement('span');
    ver.className = 'cl-ver';
    ver.textContent = 'Версия ' + entry.version;
    head.appendChild(ver);
    const when = document.createElement('span');
    when.className = 'cl-date';
    when.textContent = changelogDate(entry);
    head.appendChild(when);
    block.appendChild(head);

    if (entry.title) {
      const t = document.createElement('div');
      t.className = 'cl-title';
      t.textContent = entry.title;
      block.appendChild(t);
    }

    const ul = document.createElement('ul');
    ul.className = 'cl-list';
    entry.items.forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
    block.appendChild(ul);
    box.appendChild(block);
  });
}
