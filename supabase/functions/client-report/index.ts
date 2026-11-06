// Приём отчётов браузера (monitor.js): ошибки и замеры загрузки без входа, с любой страницы (CORS).
//   POST { events: [{ kind: 'error'|'perf', name, message, detail, ms }] } → 204
// Защита: до 10 событий за запрос и до 60 за 10 минут с одного адреса (хэш адреса в join_attempts, ключ client-report).
// Каждое принятое событие = одна строка попытки (ok=false: failsInWindow считает именно их). Лишнее молча отбрасываем.
// Из message и detail вырезаются токены, длинные ключи и строки запроса из URL (stripSecrets). Идентификаторов пользователей нет.
// Монитор не должен ломать страницу: что бы ни случилось внутри, клиент получает 204 (кроме битого JSON — 400).
import { admin, cors } from '../_shared/common.ts';
import { ipHashOf, failsInWindow } from '../_shared/join.ts';
import { cleanField, clip, LIM } from '../_shared/ops-text.ts';

const MAX_PER_REQUEST = 10;
const MAX_PER_WINDOW = 60;
const WINDOW_MIN = 10;
const MAX_BODY = 64 * 1024;   // отчёт пачкой из 10 событий намного меньше

const noContent = () => new Response(null, { status: 204, headers: cors });
const bad = () => new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return noContent();
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });

  // Читаем как текст: sendBeacon шлёт Blob с любым типом, а не только application/json
  let body: { events?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return bad();
    body = JSON.parse(text);
  } catch (_) { return bad(); }
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return bad();

  try {
    const ua = clip(req.headers.get('user-agent'), LIM.ua);
    const rows = [];
    for (const e of body.events.slice(0, MAX_PER_REQUEST)) {
      if (!e || typeof e !== 'object') continue;
      const kind = (e as { kind?: unknown }).kind;
      if (kind !== 'error' && kind !== 'perf') continue;
      const ev = e as { name?: unknown; message?: unknown; detail?: unknown; ms?: unknown };
      const ms = Number(ev.ms);
      rows.push({
        source: 'client', kind,
        name: cleanField(ev.name, LIM.name) || kind,
        message: cleanField(ev.message, LIM.message) || null,
        detail: cleanField(ev.detail, LIM.detail) || null,
        ms: Number.isFinite(ms) ? Math.min(3_600_000, Math.max(0, Math.round(ms))) : null,
        ua,
      });
    }
    if (!rows.length) return noContent();

    const ipHash = await ipHashOf(req, 'journal2-report');
    const room = Math.max(0, MAX_PER_WINDOW - (await failsInWindow(ipHash, 'client-report', WINDOW_MIN)));
    const take = rows.slice(0, room);
    if (!take.length) return noContent();
    await admin.from('join_attempts').insert(take.map(() => ({ ip_hash: ipHash, group_key: 'client-report', ok: false })));
    await admin.from('client_events').insert(take);
  } catch (_) { /* см. шапку: клиенту ошибку не показываем */ }
  return noContent();
});
