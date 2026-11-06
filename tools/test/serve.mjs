// Локальный просмотр сайта на ТЕСТОВОЙ базе (не прод): node tools/test/serve.mjs [порт]
// Отдаёт файлы репозитория, подменяя env.js на тестовый проект. Вход без пароля, только на этом компьютере:
//   /__login?as=student   — тестовый студент (student02)
//   /__login?as=headman   — староста 24ДММ-2
// Адрес слушает только 127.0.0.1. Тестовые аккаунты и данные маскированные, прод не затрагивается (guard).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { assertTestTarget, PROD_REF } from './guard.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL_SB = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL_SB);
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY, KEY = `sb-${TEST}-auth-token`;
const G = '00000000-0000-4000-8000-000000000024';
const ENV_JS = readFileSync('env.js', 'utf8')
  .replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${URL_SB}'`)
  .replace(/const SUPABASE_KEY = '[^']*'/, `const SUPABASE_KEY = '${ANON}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`)
  .replace(/const TG_APP_KEY = '[^']*'/, "const TG_APP_KEY = ''")
  .replace("const LS_PREFIX = ''", "const LS_PREFIX = 't_'");
if (ENV_JS.includes(PROD_REF)) { console.error('СТОП: в подменённом env.js остался прод'); process.exit(2); }

const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function session(email) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: env.TEST_PASSWORD }) })).json();
  return r.access_token ? r : null;
}
async function emailFor(as) {
  if (as === 'student') return 'student02@journal-test.example';
  const heads = await (await fetch(`${URL_SB}/rest/v1/memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id`, { headers: svc })).json();
  return (await (await fetch(`${URL_SB}/auth/v1/admin/users/${heads[0].user_id}`, { headers: svc })).json()).email;
}
// Согласие на данные принято заранее, чтобы экран согласия не закрывал кабинет при просмотре
async function accept(userId) {
  await fetch(`${URL_SB}/rest/v1/memberships?user_id=eq.${userId}`, { method: 'PATCH', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
}

const ROOT = resolve('.');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/__login') {
    const as = u.searchParams.get('as') === 'headman' ? 'headman' : 'student';
    const s = await session(await emailFor(as));
    if (!s) { res.writeHead(500).end('вход не удался: запустите npm run test:reset'); return; }
    await accept(s.user.id);
    const to = as === 'headman' ? 'headman.html' : 'app.html';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(`<!doctype html><meta charset=utf-8><script>localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(s))}); location.replace(${JSON.stringify(to)});</script>`);
    return;
  }
  if (p.endsWith('/env.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(ENV_JS); return; }
  const f = resolve(join(ROOT, p === '/' ? 'index.html' : p));
  if (!f.startsWith(ROOT) || /[\\/]\.env/.test(f)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(readFileSync(f)); } catch (_) { res.writeHead(404).end(); }
});
const port = Number(process.argv[2]) || 8765;
server.listen(port, '127.0.0.1', () => console.log(`Тестовый сайт: http://127.0.0.1:${port}/__login?as=student  |  ...?as=headman`));
