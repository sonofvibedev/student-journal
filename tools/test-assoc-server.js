// Проверки серверной части «Ассоциаций». Запуск: node tools/test-assoc-server.js
//
// Edge Function целиком здесь не поднять (ей нужны Deno и база), поэтому
// проверяется то, на чём держится честность игры:
//   — слово не из словаря и повтор не считаются попыткой;
//   — подсказка всегда ближе лучшего результата;
//   — в ответе клиенту нет ни загаданного слова, ни рейтинга, пока игра идёт;
//   — стоп-слова не попадают ни в подсказки, ни в список ближайших.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assocNormalize, assocPoints, assocHintRank, ASSOC } from '../games-core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

// Стоп-лист читаем тот же, что и скрипт подготовки словаря
const stopRoots = fs.readFileSync(path.join(root, 'tools/assoc/stopwords.txt'), 'utf8')
  .replace(/^﻿/, '')
  .split(/\r?\n/)
  .map((l) => l.trim().toLowerCase().replace(/ё/g, 'е'))
  .filter((l) => l && !l.startsWith('#'));

const stopped = (word) => stopRoots.some((r) => word.startsWith(r));

// Небольшой игрушечный рейтинг: слово, его соседи и пара грубых слов,
// которые в настоящем словаре отфильтрованы, — проверяем, что они не всплывут
const RANK = ['цель', 'мишень', 'задача', 'план', 'замысел', 'идея', 'мысль',
  'стол', 'стул', 'дом', 'лес', 'море', 'идиот', 'дебил'];
const place = new Map(RANK.map((w, i) => [w, i + 1]));

// Повторяет то, что делает Edge Function на действие guess
function guess(state, raw) {
  const word = assocNormalize(raw);
  const rank = place.get(word);
  if (!rank) return { state, unknown: word };            // нет в словаре
  if (state.guesses.some((g) => g.w === word)) return { state, repeat: word };
  const guesses = state.guesses.concat([{ w: word, r: rank }]);
  const tries = state.tries + 1;
  const solved = rank === 1;
  return {
    state: {
      ...state, guesses, tries, solved, finished: solved,
      points: solved ? assocPoints(tries, state.hints) : 0,
    },
    last: word,
  };
}

// Повторяет view() из Edge Function: что уходит клиенту
function view(state) {
  const done = state.finished;
  return {
    ok: true, tries: state.tries, hints: state.hints, guesses: state.guesses,
    solved: state.solved, gaveUp: state.gaveUp, finished: done, points: state.points,
    total: RANK.length,
    word: done ? RANK[0] : null,
    near: done ? RANK.slice(0, ASSOC.top).filter((w) => !stopped(w)) : null,
  };
}

const fresh = () => ({ tries: 0, hints: 0, guesses: [], solved: false, gaveUp: false, finished: false, points: 0 });

console.log('Попытки');

test('слово не из словаря попыткой не считается', () => {
  const res = guess(fresh(), 'абырвалг');
  assert.equal(res.unknown, 'абырвалг');
  assert.equal(res.state.tries, 0);
  assert.equal(res.state.guesses.length, 0);
});

test('повтор уже названного слова попыткой не считается', () => {
  const first = guess(fresh(), 'дом').state;
  assert.equal(first.tries, 1);
  const again = guess(first, 'ДОМ');
  assert.equal(again.repeat, 'дом');
  assert.equal(again.state.tries, 1, 'повтор прибавил попытку');
  assert.equal(again.state.guesses.length, 1);
});

test('угаданное слово заканчивает игру и даёт очки', () => {
  let s = guess(fresh(), 'лес').state;
  s = guess(s, 'задача').state;
  const win = guess(s, 'Цель').state;
  assert.equal(win.solved, true);
  assert.equal(win.finished, true);
  assert.equal(win.tries, 3);
  assert.equal(win.points, assocPoints(3, 0));
});

console.log('Подсказки');

test('подсказка ближе лучшего результата и не повторяется', () => {
  const s = guess(fresh(), 'море').state;      // место 12
  const used = new Set(s.guesses.map((g) => g.w));
  const best = Math.min(...s.guesses.map((g) => g.r));
  const hint = assocHintRank(RANK, best, used);
  assert.ok(hint, 'подсказка не нашлась');
  assert.ok(hint.rank < best, 'подсказка не ближе лучшего результата');
  assert.equal(used.has(hint.word), false);
});

test('подсказка никогда не выдаёт само загаданное слово', () => {
  for (let best = 3; best <= RANK.length; best++) {
    const hint = assocHintRank(RANK, best, new Set());
    if (hint) assert.ok(hint.rank >= 2, 'подсказкой выдано загаданное слово');
  }
});

test('стоп-слов нет в подсказках', () => {
  const clean = RANK.filter((w) => !stopped(w));
  for (let best = 3; best <= clean.length; best++) {
    const hint = assocHintRank(clean, best, new Set());
    if (hint) assert.equal(stopped(hint.word), false, hint.word + ': грубое слово в подсказке');
  }
});

console.log('Что уходит клиенту');

test('пока игра идёт, в ответе нет ни слова, ни списка ближайших', () => {
  let s = guess(fresh(), 'дом').state;
  s = guess(s, 'лес').state;
  const out = view(s);
  assert.equal(out.word, null, 'загаданное слово ушло клиенту до конца игры');
  assert.equal(out.near, null, 'список ближайших ушёл клиенту до конца игры');
  const text = JSON.stringify(out);
  assert.equal(text.includes('цель'), false, 'загаданное слово нашлось в ответе');
  assert.equal(text.includes('мишень'), false, 'соседнее слово утекло в ответ');
});

test('после победы приходит слово и сто ближайших', () => {
  const s = guess(guess(fresh(), 'дом').state, 'цель').state;
  const out = view(s);
  assert.equal(out.word, 'цель');
  assert.ok(Array.isArray(out.near) && out.near.length > 0);
  assert.ok(out.near.length <= ASSOC.top);
  assert.equal(out.near[0], 'цель');
});

test('после сдачи приходит слово, очков нет', () => {
  const s = { ...guess(fresh(), 'дом').state, finished: true, gaveUp: true, solved: false, points: 0 };
  const out = view(s);
  assert.equal(out.word, 'цель');
  assert.equal(out.points, 0);
  assert.equal(out.gaveUp, true);
});

test('стоп-слов нет в списке ста ближайших', () => {
  const s = guess(fresh(), 'цель').state;
  const out = view(s);
  out.near.forEach((w) => assert.equal(stopped(w), false, w + ': грубое слово в списке'));
});

console.log('Стоп-лист и загаданные слова');

test('стоп-лист ловит грубые слова и их формы', () => {
  assert.ok(stopRoots.length >= 40, 'стоп-лист подозрительно короткий');
  ['идиот', 'идиотка', 'дебил', 'сволочь', 'урод', 'уродец'].forEach((w) => {
    assert.equal(stopped(assocNormalize(w)), true, w + ': не попал в стоп-лист');
  });
  ['цель', 'дом', 'студент', 'книга', 'идея'].forEach((w) => {
    assert.equal(stopped(assocNormalize(w)), false, w + ': обычное слово попало в стоп-лист');
  });
});

test('загаданных слов не меньше 120, без повторов и грубых', () => {
  const targets = fs.readFileSync(path.join(root, 'tools/assoc/targets.txt'), 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => (l.trim().startsWith('#') ? '' : assocNormalize(l)))
    .filter(Boolean);
  assert.ok(targets.length >= 120, 'загаданных слов должно быть не меньше 120, сейчас ' + targets.length);
  assert.equal(new Set(targets).size, targets.length, 'в списке есть повторы');
  targets.forEach((w) => assert.equal(stopped(w), false, w + ': грубое слово среди загаданных'));
});

console.log(`\nПроверок пройдено: ${passed}`);
