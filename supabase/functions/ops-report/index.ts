// Ежедневная сводка сисадминам (pg_cron 09:00 по Минску, x-cron-secret) и кнопка «Отправить сводку сейчас» (JWT сисадмина).
// RPC ops_summary только для вошедшего сисадмина (auth.uid), из функции под секретным ключом её не вызвать,
// поэтому нужные числа считаем здесь напрямую по client_events, schedule_meta, registration_requests, backups.
// Cron-вызов не чаще раза в 20 часов (ops_state 'last_digest'): повтор расписания или ручной запуск cron не засыпает сообщениями.
// Вызов сисадмина это ограничение игнорирует. Текст: только числа, имена событий и группы (buildDigest).
import { admin, cors, json } from '../_shared/common.ts';
import { alertSysadmins } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';
import { cronOk, sysadminId } from '../_shared/opsauth.ts';
import { availabilityPct, buildDigest, dueSince, percentile, topCounts } from '../_shared/ops-text.ts';

const HOURS = 24;
const CRON_GAP_MS = 20 * 3_600_000;
const ROW_LIMIT = 1000;   // потолок PostgREST по умолчанию. ponytail: пингов за сутки ~580 (база и сайт каждые 5 минут) влезают; топ ошибок считается по первым 1000 строкам, числа ошибок — точными count-запросами

const channelsConfigured = () =>
  (!!Deno.env.get('TELEGRAM_BOT_TOKEN') && !!(Deno.env.get('TG_ADMIN_IDS') ?? '').trim()) || (!!Deno.env.get('RESEND_API_KEY') && !!Deno.env.get('ADMIN_EMAIL'));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const cron = cronOk(req);
  let actor: string | null = null;
  try {
    if (!cron) {
      actor = await sysadminId(req);
      if (!actor) return req.headers.get('Authorization') ? json({ error: 'forbidden' }, 403) : json({ error: 'unauthorized' }, 401);
    }

    if (cron) {
      const { data: st } = await admin.from('ops_state').select('value').eq('key', 'last_digest').maybeSingle();
      if (!dueSince(st?.value?.at, Date.now(), CRON_GAP_MS)) return json({ ok: true, skipped: true });
    }

    const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
    const errCount = (source: string) =>
      admin.from('client_events').select('id', { count: 'exact', head: true }).eq('kind', 'error').eq('source', source).gte('at', since);
    const [pingsQ, errorsQ, metaQ, reqQ, backupQ, clientQ, serverQ] = await Promise.all([
      admin.from('client_events').select('name, ok, ms').eq('kind', 'ping').gte('at', since).limit(ROW_LIMIT),
      admin.from('client_events').select('name').eq('kind', 'error').gte('at', since).limit(ROW_LIMIT),
      admin.from('schedule_meta').select('group_id, last_status').neq('last_status', 'ok'),
      admin.from('registration_requests').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
      admin.from('backups').select('at, status, size_bytes').order('at', { ascending: false }).limit(1),
      errCount('client'), errCount('server'),
    ]);
    if (pingsQ.error || errorsQ.error || metaQ.error || reqQ.error || backupQ.error || clientQ.error || serverQ.error) {
      await logServer('ops-report', 'read_failed');
      return json({ error: 'server_error' }, 500);
    }

    const pings = pingsQ.data ?? [];
    const errs = errorsQ.data ?? [];
    const failing = (metaQ.data ?? []).filter((m) => m.last_status);
    const { data: groups } = failing.length
      ? await admin.from('groups').select('id, name').eq('status', 'active').in('id', failing.map((m) => m.group_id))
      : { data: [] as { id: string; name: string }[] };
    const gname = new Map((groups ?? []).map((g) => [g.id, g.name]));

    const text = buildDigest({
      hours: HOURS,
      availability_pct: availabilityPct(pings), pings: pings.length,
      resp_p95_ms: percentile(pings.filter((p) => p.name === 'db' && p.ok === true && p.ms != null).map((p) => p.ms as number), 95),
      client_errors: clientQ.count ?? 0,
      server_errors: serverQ.count ?? 0,
      top_errors: topCounts(errs.map((e) => e.name), 3),
      import_failures: failing.filter((m) => gname.has(m.group_id)).map((m) => ({ name: gname.get(m.group_id)!, status: m.last_status })),
      pending_requests: reqQ.count ?? 0,
      backup_last: backupQ.data?.[0] ?? null,
    });

    await alertSysadmins('Журнал: сводка за сутки', text);
    const now = new Date().toISOString();
    await admin.from('ops_state').upsert({ key: 'last_digest', value: { at: now }, updated_at: now }, { onConflict: 'key' });
    if (actor) await admin.from('audit_log').insert({ actor, action: 'ops_report_sent', details: {} });
    return json({ ok: true, sent: channelsConfigured() });
  } catch (e) {
    await logServer('ops-report', 'exception', e instanceof Error ? e.name : 'unknown');
    return json({ error: 'server_error' }, 500);
  }
});
