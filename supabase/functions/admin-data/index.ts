// Запись открытой части журнала (data.json) в GitHub от имени сервера: админу токен GitHub не нужен.
//   { action: 'read' }                              → { sha, content }   (content — base64, как отдаёт GitHub)
//   { action: 'write', message, content, sha }      → { ok }             (409 — файл успели изменить)
// Только админ (см. _shared/admin.ts). Токен сервера — секрет GITHUB_TOKEN, тот же, что у бота.
import { json, cors } from '../_shared/common.ts';
import { jwtAdmin } from '../_shared/admin.ts';

const TOKEN = Deno.env.get('GITHUB_TOKEN');
const REPO = Deno.env.get('GITHUB_REPO') ?? 'sonofvibedev/student-journal';
const BRANCH = Deno.env.get('GITHUB_BRANCH') ?? 'main';
const URL_ = `https://api.github.com/repos/${REPO}/contents/data.json`;
const MAX_BYTES = 4_000_000;

const gh = (init: RequestInit = {}) => fetch(init.method === 'PUT' ? URL_ : `${URL_}?ref=${encodeURIComponent(BRANCH)}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
    'User-Agent': 'journal-24dmm2-admin', 'X-GitHub-Api-Version': '2022-11-28',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!TOKEN) return json({ error: 'github_not_configured' }, 500);

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: 'too_large' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await jwtAdmin(req)) return json({ error: 'not_admin' }, 403);

  try {
    if (body.action === 'read') {
      const res = await gh();
      if (!res.ok) return json({ error: `github_${res.status}` }, 502);
      const j = await res.json();
      return json({ sha: j.sha, content: j.content ?? '' });
    }
    if (body.action === 'write') {
      const { message, content, sha } = body;
      if (typeof message !== 'string' || !message || message.length > 300 ||
          typeof content !== 'string' || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        return json({ error: 'bad_request' }, 400);
      }
      // Файл должен остаться корректным JSON: битая запись сломала бы сайт для всех
      try { JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)))); }
      catch (_) { return json({ error: 'bad_json' }, 400); }
      const res = await gh({ method: 'PUT', body: JSON.stringify({ message, content, sha, branch: BRANCH }) });
      if (res.ok) return json({ ok: true });
      return json({ error: res.status === 409 || res.status === 422 ? 'conflict' : `github_${res.status}` }, res.status === 409 || res.status === 422 ? 409 : 502);
    }
  } catch (_) {
    return json({ error: 'network' }, 502);
  }
  return json({ error: 'bad_request' }, 400);
});
