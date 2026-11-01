// Сохранение открытой части журнала из админки. Домашка и дедлайны живут в таблице tasks,
// data.json в GitHub пересобирается из неё сервером (_shared/taskstore.ts): токен GitHub админу не нужен.
//   { message, patch?, upserts?, deletes? } → { ok, homework, deadlines, mirror }
//     upserts — [{ kind: 'homework' | 'deadline', rec }] только изменённые и новые записи,
//     deletes — id удалённых записей, patch — предметы, преподаватели, объявления (заменяются целиком).
//     homework и deadlines в ответе — свежие списки из таблицы (там же записи бота).
//     mirror: false — таблица сохранена, а data.json обновить не вышло: догонит следующая запись.
// Только админ (см. _shared/admin.ts).
import { json, cors } from '../_shared/common.ts';
import { jwtAdmin } from '../_shared/admin.ts';
import { applyOps, loadLists, syncMirrorQuietly } from '../_shared/taskstore.ts';
import type { Kind, Rec } from '../_shared/taskdiff.ts';

const MAX_BYTES = 1_000_000;
const PATCH_KEYS = ['subjects', 'teachers', 'announcements'];
const ID_RE = /^(hw|dl)-[0-9a-z-]{1,40}$/;

const isRec = (v: unknown): v is Rec =>
  !!v && typeof v === 'object' && !Array.isArray(v) && ID_RE.test(String((v as Rec).id)) && JSON.stringify(v).length <= 5000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: 'too_large' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch (_) { return json({ error: 'bad_request' }, 400); }

  if (!await jwtAdmin(req)) return json({ error: 'not_admin' }, 403);

  const message = body.message;
  const upserts = body.upserts ?? [];
  const deletes = body.deletes ?? [];
  const patch = (body.patch ?? {}) as Record<string, unknown>;
  const kindOk = (u: { kind?: unknown; rec?: unknown }) =>
    (u.kind === 'homework' || u.kind === 'deadline') && isRec(u.rec) &&
    String(u.rec.id).startsWith(u.kind === 'homework' ? 'hw-' : 'dl-');
  if (typeof message !== 'string' || !message || message.length > 300 ||
      !Array.isArray(upserts) || upserts.length > 200 || !upserts.every(kindOk) ||
      !Array.isArray(deletes) || deletes.length > 200 || !deletes.every((d) => typeof d === 'string' && ID_RE.test(d)) ||
      !patch || typeof patch !== 'object' || Array.isArray(patch) ||
      !Object.entries(patch).every(([k, v]) => PATCH_KEYS.includes(k) && Array.isArray(v))) {
    return json({ error: 'bad_request' }, 400);
  }

  try {
    await applyOps({ upserts: upserts as Array<{ kind: Kind; rec: Rec }>, deletes: deletes as string[] });
    const mirror = await syncMirrorQuietly(message, patch);
    // Предметы и преподаватели живут только в data.json: не записались — это ошибка, а не «догонит позже»
    if (!mirror && Object.keys(patch).length) return json({ error: 'github_failed' }, 502);
    return json({ ok: true, mirror, ...(await loadLists()) });
  } catch (_) {
    return json({ error: 'server_error' }, 500);
  }
});
