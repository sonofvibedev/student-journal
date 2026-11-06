// Проверка работоспособности (pg_cron каждые 5 минут, заголовок x-cron-secret).
// Пингуем базу (лёгкий запрос) и сайт (GET SITE_URL/app.html, только при https), пишем в client_events kind='ping'.
// Потом пороги: много ошибок браузера или низкая доступность → алерт сисадминам, не чаще раза в час (ops_state 'last_alert') + строка kind='alert'.
// В тексте алерта только числа: ни текстов ошибок, ни адресов.
import { admin, cors, json } from '../_shared/common.ts';
import { alertSysadmins, siteUrl } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';
import { cronOk } from '../_shared/opsauth.ts';
import { alertReasons, dueSince } from '../_shared/ops-text.ts';

// ---- Пороги ----
const ERRORS_LIMIT = 20;            // ошибок браузера за ERRORS_WINDOW_MIN минут
const ERRORS_WINDOW_MIN = 10;
const AVAIL_MIN_PCT = 80;           // доступность за AVAIL_WINDOW_MIN минут ниже этого → алерт
const AVAIL_WINDOW_MIN = 30;
const AVAIL_MIN_PINGS = 3;          // меньше проверок в окне — вывод ненадёжен
const ALERT_GAP_MS = 3_600_000;     // не чаще раза в час
const SITE_TIMEOUT_MS = 10_000;

// ponytail: если база лежит, ops_state недоступен и «раз в час» не проверить; держим отметку в памяти экземпляра функции.
// Экземпляр может смениться, тогда алерт придёт чаще часа: для лежащей базы это допустимо.
let lastDownAlert = 0;

const since = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function pingDb(): Promise<{ ok: boolean; ms: number }> {
  const t = Date.now();
  try {
    const { error } = await admin.from('app_settings').select('key').eq('key', 'maintenance').limit(1);
    return { ok: !error, ms: Date.now() - t };
  } catch (_) { return { ok: false, ms: Date.now() - t }; }
}

async function pingSite(base: string): Promise<{ ok: boolean; ms: number }> {
  const t = Date.now();
  try {
    const r = await fetch(`${base}/app.html`, { signal: AbortSignal.timeout(SITE_TIMEOUT_MS) });
    await r.body?.cancel();
    return { ok: r.ok, ms: Date.now() - t };
  } catch (_) { return { ok: false, ms: Date.now() - t }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!cronOk(req)) return json({ error: 'forbidden' }, 403);

  try {
    const db = await pingDb();
    const site = siteUrl();
    const siteRes = site ? await pingSite(site) : null;
    const pings = [{ name: 'db', ...db }, ...(siteRes ? [{ name: 'site', ...siteRes }] : [])];

    if (!db.ok) {
      // База не отвечает: писать пинг и читать пороги бессмысленно. Сообщаем напрямую.
      if (Date.now() - lastDownAlert >= ALERT_GAP_MS) {
        lastDownAlert = Date.now();
        await alertSysadmins('Журнал: сбой', `База данных не отвечает (проверка заняла ${db.ms} мс).`);
      }
      return json({ ok: false, db: false });
    }

    await admin.from('client_events').insert(pings.map((p) => ({ source: 'health', kind: 'ping', name: p.name, ok: p.ok, ms: p.ms })));

    const [{ count: errors }, { data: recent }] = await Promise.all([
      admin.from('client_events').select('id', { count: 'exact', head: true }).eq('source', 'client').eq('kind', 'error').gte('at', since(ERRORS_WINDOW_MIN)),
      admin.from('client_events').select('ok').eq('kind', 'ping').gte('at', since(AVAIL_WINDOW_MIN)),
    ]);
    const reasons = alertReasons(errors ?? 0, recent ?? [], { errors: ERRORS_LIMIT, availabilityMin: AVAIL_MIN_PCT, minPings: AVAIL_MIN_PINGS });
    if (!reasons.length) return json({ ok: true, alert: false });

    const { data: st } = await admin.from('ops_state').select('value').eq('key', 'last_alert').maybeSingle();
    if (!dueSince(st?.value?.at, Date.now(), ALERT_GAP_MS)) return json({ ok: true, alert: false, throttled: true });

    const text = reasons.join('\n');
    await alertSysadmins('Журнал: сбой', text);
    const now = new Date().toISOString();
    await admin.from('ops_state').upsert({ key: 'last_alert', value: { at: now }, updated_at: now }, { onConflict: 'key' });
    await admin.from('client_events').insert({ source: 'health', kind: 'alert', name: 'threshold', message: text.slice(0, 300), ok: false });
    return json({ ok: true, alert: true });
  } catch (e) {
    await logServer('health-check', 'exception', e instanceof Error ? e.name : 'unknown');
    return json({ error: 'server_error' }, 500);
  }
});
