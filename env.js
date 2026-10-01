// ===== ОКРУЖЕНИЕ: РАБОЧАЯ ВЕРСИЯ =====
// Единственный файл, которым рабочий сайт отличается от тестового стенда
// (sonofvibedev/student-journal-test). Переносите изменения из теста —
// копируйте всё, КРОМЕ этого файла.
//
// Загружается в <head> ПЕРВЫМ, до app.css и остальных скриптов.

'use strict';

const IS_TEST = false;

// Приставка ко всем ключам localStorage. В рабочей версии её нет, поэтому
// всё, что уже сохранено у студентов (вход, зачётка, рейтинг), остаётся на месте.
const LS_PREFIX = '';

// Куда админ сохраняет data.json (saveDataToGitHub)
const GITHUB_OWNER = 'sonofvibedev';
const GITHUB_REPO = 'student-journal';
const DATA_PATH = 'data.json';

// Рабочий проект Supabase. Ключ publishable — открытый по назначению,
// что можно читать и менять, решают правила RLS в базе.
const SUPABASE_URL = 'https://woiqekpuoddxixlrbvkp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_I1jhpJqVFBcd_ceZ-hYmGg_-MdIiZ1k';

// Имя ключа сессии — ровно то, которое supabase-js использует по умолчанию.
// Менять его нельзя: иначе все вошедшие студенты разом окажутся разлогинены.
const SB_STORAGE_KEY = 'sb-woiqekpuoddxixlrbvkp-auth-token';

// --- Обёртки над localStorage: единственное место, где добавляется приставка ---
// Браузер может запретить хранилище (приватный режим), поэтому всё в try/catch.
function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v === null ? fallback : v;
  } catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, value); return true; } catch (e) { return false; }
}
function lsRemove(key) {
  try { localStorage.removeItem(LS_PREFIX + key); return true; } catch (e) { return false; }
}
function lsGetJSON(key, fallback) {
  try {
    const v = lsGet(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
function lsSetJSON(key, value) {
  try { return lsSet(key, JSON.stringify(value)); } catch (e) { return false; }
}

// Плашки «ТЕСТОВАЯ ВЕРСИЯ» и мета-тега noindex здесь нет: это рабочий сайт.
