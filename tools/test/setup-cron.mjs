// Секрет расписания для ТЕСТОВОГО проекта: одна случайная строка кладётся и в секреты Edge Functions (CRON_SECRET),
// и в Vault под именем cron_secret (его читают pg_cron-задания). Прод-секрет сюда не копируется и не читается.
// Запуск: node tools/test/setup-cron.mjs   (повторный запуск ставит новую строку в оба места)
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestTarget } from './guard.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args) => execFileSync(npx, ['--yes', 'supabase@latest', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });

const secret = randomBytes(24).toString('hex');
run(['secrets', 'set', '--project-ref', TEST, '--yes', `CRON_SECRET=${secret}`]);

const f = join(tmpdir(), `cron-secret-${Date.now()}.sql`);
writeFileSync(f, `do $$ begin
  delete from vault.secrets where name = 'cron_secret';
  perform vault.create_secret('${secret}', 'cron_secret', 'Заголовок x-cron-secret для заданий pg_cron (тест)');
end $$;`);
try { run(['db', 'query', `--remote=${TEST}`, '--yes', '--file', f]); } finally { unlinkSync(f); }
// копия в .env.test (в git не попадает): тестам и ручным проверкам нужно вызывать функции по расписанию
// копия в .env.test (в git не попадает): тестам и ручным проверкам нужно вызывать функции по расписанию
const keep = readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('TEST_CRON_SECRET='));
writeFileSync('.env.test', keep.join('\n') + `\nTEST_CRON_SECRET=${secret}\n`);
console.log('CRON_SECRET обновлён в секретах функций и в Vault тестового проекта', TEST);
