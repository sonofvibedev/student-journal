// Проверка синтаксиса: все .js проекта и каждый inline <script> в .html.
// Запуск: node tools/check-inline-scripts.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['.git', 'node_modules', 'design-previews', 'supabase', 'icons', 'fonts']);
let checked = 0;
const errors = [];

function check(code, where) {
  checked++;
  try {
    new vm.Script(code, { filename: where });
  } catch (e) {
    errors.push(where + ': ' + e.message);
  }
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) {
      if (!skipDirs.has(name)) walk(full);
      continue;
    }
    if (name.endsWith('.bak')) continue;
    const src = fs.readFileSync(full, 'utf8').replace(/^﻿/, '');
    if (name.endsWith('.js')) {
      check(src, rel);
    } else if (name.endsWith('.html')) {
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let m, i = 0;
      while ((m = re.exec(src))) {
        i++;
        if (/\bsrc\s*=/.test(m[1])) continue;                      // внешний файл
        if (/type\s*=\s*"(?!text\/javascript|module)/i.test(m[1])) continue;  // шаблон, не код
        const line = src.slice(0, m.index).split('\n').length;
        check(m[2], rel + ' inline #' + i + ' (строка ' + line + ')');
      }
    }
  }
}

walk(root);
if (errors.length) {
  console.error('Ошибки синтаксиса:\n' + errors.map(e => '  ' + e).join('\n'));
  process.exit(1);
}
console.log('Синтаксис в порядке: проверено ' + checked + ' скриптов.');
