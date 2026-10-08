// Проверка разметки: баланс тегов и уникальность id.
// Запуск: node tools/check-dom.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);
const errors = [];

function checkFile(file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  let src = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  // Комментарии, <script> и <style> не разбираем как разметку
  src = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  src = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));

  const stack = [];
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tag.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = m[4] === '/';
    if (VOID.has(name) || selfClosed) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!closing) {
      stack.push({ name, line });
    } else {
      const open = stack.pop();
      if (!open) errors.push(rel + ':' + line + ': лишний </' + name + '>');
      else if (open.name !== name) errors.push(rel + ':' + line + ': </' + name + '> закрывает <' + open.name + '> со строки ' + open.line);
    }
  }
  stack.forEach((o) => errors.push(rel + ':' + o.line + ': <' + o.name + '> не закрыт'));

  // id: уникальность в файле и наличие всех, к кому обращается getElementById
  const raw = fs.readFileSync(file, 'utf8');
  const ids = {};
  let i;
  const idRe = /\sid="([^"]+)"/g;
  while ((i = idRe.exec(raw))) ids[i[1]] = (ids[i[1]] || 0) + 1;
  Object.keys(ids).forEach((id) => {
    if (ids[id] > 1) errors.push(rel + ': id="' + id + '" встречается ' + ids[id] + ' раз');
  });
  return ids;
}

const htmlFiles = fs.readdirSync(root).filter((f) => f.endsWith('.html') && !f.endsWith('.bak'));
const idsByFile = {};
htmlFiles.forEach((f) => { idsByFile[f] = checkFile(path.join(root, f)); });

// getElementById('x') во всех скриптах — id должен быть хоть в одной странице
// или собираться скриптом (notify.js создаёт своё окно сам)
const allIds = new Set();
Object.values(idsByFile).forEach((ids) => Object.keys(ids).forEach((id) => allIds.add(id)));
const jsFiles = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
jsFiles.forEach((f) => {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const re = /\sid="([^"${}]+)"/g;
  let m;
  while ((m = re.exec(src))) allIds.add(m[1]);
});
const sources = jsFiles.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')])
  .concat(htmlFiles.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
const missing = new Map();
sources.forEach(([name, src]) => {
  const re = /getElementById\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (!allIds.has(m[1])) {
      const line = src.slice(0, m.index).split('\n').length;
      missing.set(m[1], name + ':' + line);
    }
  }
});
missing.forEach((where, id) => errors.push(where + ": getElementById('" + id + "') — такого id в разметке нет"));

if (errors.length) {
  console.error('Проблемы в разметке:\n' + errors.map((e) => '  ' + e).join('\n'));
  process.exit(1);
}
console.log('Разметка в порядке: ' + htmlFiles.length + ' страниц, ' + allIds.size + ' уникальных id.');
