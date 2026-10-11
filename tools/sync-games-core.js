// Копирует games-core.js в папку Edge Function.
//
// Правила игр должны быть ровно одни: страница и сервер обязаны считать
// партию одинаково, иначе честный рекорд не пройдёт проверку. Исходник —
// games-core.js в корне (его грузит страница), копия лежит рядом с функцией,
// потому что Edge Function собирается только из supabase/functions.
//
// Запуск: node tools/sync-games-core.js (деплой-скрипты зовут его сами).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'games-core.js');
const dst = join(root, 'supabase', 'functions', '_shared', 'games-core.js');

const code = readFileSync(src, 'utf8');
writeFileSync(dst, code);
console.log('games-core.js скопирован в supabase/functions/_shared');
