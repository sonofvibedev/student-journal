// Импорт расписания группы с bseu.by в schedule_lessons (кнопка «Обновить» у старосты и сисадмина).
//   { group_id }  → { ok, added, removed, changed, lessons, week1_monday, semester_end, notified }
// Кто может: сисадмин, староста или заместитель этой группы, либо вызов по расписанию (x-cron-secret = CRON_SECRET) или секретным ключом.
// Сам импорт и защита от сбоев разбора — в _shared/schedule.ts (его же использует ночной запуск); здесь только вход и лимит частоты.
import { admin, cors, json, secretKey } from '../_shared/common.ts';
import { importGroup, notifySchedule } from '../_shared/schedule.ts';

const MIN_GAP_MIN = 10;          // чаще раза в 10 минут руками не обновляем (нагрузка на bseu.by)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  const groupId = String(body.group_id ?? '');
  if (!/^[0-9a-f-]{36}$/.test(groupId)) return json({ error: 'bad_request' }, 400);

  // Кто звонит
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const cronSecret = Deno.env.get('CRON_SECRET');
  const isService = (!!token && token === secretKey()) || (!!cronSecret && req.headers.get('x-cron-secret') === cronSecret);
  let actor: string | null = null;
  if (!isService) {
    const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
    if (!auth?.user) return json({ error: 'unauthorized' }, 401);
    actor = auth.user.id;
    const [{ data: sa }, { data: m }] = await Promise.all([
      admin.from('sysadmins').select('user_id').eq('user_id', actor).maybeSingle(),
      admin.from('memberships').select('extra_role').eq('user_id', actor).eq('group_id', groupId).eq('status', 'active').maybeSingle(),
    ]);
    if (!sa && !(m && (m.extra_role === 'headman' || m.extra_role === 'deputy'))) return json({ error: 'forbidden' }, 403);
  }

  const { data: meta } = await admin.from('schedule_meta').select('last_import_at').eq('group_id', groupId).maybeSingle();
  if (!isService && meta?.last_import_at && Date.now() - new Date(meta.last_import_at).getTime() < MIN_GAP_MIN * 60_000) return json({ error: 'too_soon' }, 429);

  const r = await importGroup(groupId, actor);
  if (!r.ok) return json({ error: r.error }, r.status);
  const { changes, ...diff } = r;
  const notified = await notifySchedule(groupId, changes);
  return json({ ...diff, notified });
});
