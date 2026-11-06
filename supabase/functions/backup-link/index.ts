// Ссылка на скачивание резервной копии для сисадмина (JWT): { id } → { url }, подписанная на 5 минут.
// Только для записи из таблицы backups: произвольный путь в хранилище клиент передать не может.
// Копия содержит личные данные, поэтому каждая выдача ссылки пишется в audit_log (без самой ссылки).
import { admin, cors, json } from '../_shared/common.ts';
import { logServer } from '../_shared/oplog.ts';
import { sysadminId } from '../_shared/opsauth.ts';

const TTL_SEC = 300;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const actor = await sysadminId(req);
    if (!actor) return req.headers.get('Authorization') ? json({ error: 'forbidden' }, 403) : json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
    const id = String(body?.id ?? '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'bad_request' }, 400);

    const { data: b } = await admin.from('backups').select('path, status').eq('id', id).maybeSingle();
    if (!b?.path || b.status !== 'ok') return json({ error: 'not_found' }, 404);

    const { data, error } = await admin.storage.from('backups').createSignedUrl(b.path, TTL_SEC);
    if (error || !data?.signedUrl) { await logServer('backup-link', 'sign_failed'); return json({ error: 'server_error' }, 500); }
    await admin.from('audit_log').insert({ actor, action: 'backup_download', details: { id } });
    return json({ url: data.signedUrl, expires_in: TTL_SEC });
  } catch (e) {
    await logServer('backup-link', 'exception', e instanceof Error ? e.name : 'unknown');
    return json({ error: 'server_error' }, 500);
  }
});
