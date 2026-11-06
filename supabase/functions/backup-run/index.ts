// Резервная копия данных журнала (pg_cron 03:30 по Минску, x-cron-secret: kind 'nightly'; кнопка сисадмина, JWT: kind 'manual').
// Таблицы выгружаются по одной постранично (по 1000 строк, стабильный порядок по ключу) в один JSON { taken_at, tables: { имя: [строки] } },
// сжимаются gzip и кладутся в закрытое хранилище `backups` по пути <YYYY-MM-DD>/<HHMMSS>-<kind>.json.gz; запись в таблицу backups.
// Чата (chat_*), Telegram (tg_*) и auth в копии нет. Любой сбой: строка status='failed' и алерт сисадминам.
// Хранение 14 дней: старые файлы и записи удаляются после каждой копии.
// Содержимое копии (оценки, справки, ФИО) в логи и алерты не попадает: только размеры и счётчики.
import { admin, cors, json } from '../_shared/common.ts';
import { alertSysadmins } from '../_shared/notify.ts';
import { logServer } from '../_shared/oplog.ts';
import { cronOk, sysadminId } from '../_shared/opsauth.ts';
import { backupPath, cleanField, RETENTION_DAYS } from '../_shared/ops-text.ts';

const PAGE = 1000;
const BUCKET = 'backups';
// Порядок выгрузки: ключ каждой таблицы (первичный), иначе страницы могут дублировать или терять строки
const TABLES: [string, string[]][] = [
  ['groups', ['id']], ['students', ['id']], ['memberships', ['user_id', 'group_id']],
  ['teacher_assignments', ['user_id', 'group_id', 'subject', 'lesson_kind']], ['absences', ['id']], ['certificates', ['id']],
  ['grades', ['id']], ['tasks', ['id']], ['lesson_notes', ['group_id', 'lesson_date', 'pair_no', 'subject']],
  ['schedule_meta', ['group_id']], ['consents', ['id']], ['notification_prefs', ['user_id', 'kind']],
];

async function dump(table: string, order: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select('*');
    for (const c of order) q = q.order(c);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table}: ${error.code ?? 'error'}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Старые копии: сначала файлы, и только если они удалены, строки (иначе файл осиротеет и его уже не найти)
async function prune(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: old } = await admin.from('backups').select('id, path').lt('at', cutoff);
  if (!old?.length) return;
  const paths = old.map((b) => b.path).filter((p): p is string => !!p);
  if (paths.length) {
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    if (error) { await logServer('backup-run', 'prune_failed'); return; }
  }
  await admin.from('backups').delete().in('id', old.map((b) => b.id)).lt('at', cutoff);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let kind: 'nightly' | 'manual' = 'nightly';
  let actor: string | null = null;
  if (!cronOk(req)) {
    actor = await sysadminId(req).catch(() => null);
    if (!actor) return req.headers.get('Authorization') ? json({ error: 'forbidden' }, 403) : json({ error: 'unauthorized' }, 401);
    kind = 'manual';
  }

  try {
    // ponytail: все таблицы собираются в памяти одной строкой, затем сжимаются. При ~десятках тысяч строк это единицы мегабайт;
    // потолок памяти Edge Function ~256 МБ, т.е. порядка 100 тысяч строк. Дальше: сжимать потоком по таблицам или выгружать в несколько файлов.
    const now = new Date();
    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (const [t, order] of TABLES) { tables[t] = await dump(t, order); counts[t] = tables[t].length; }
    const bytes = await gzip(JSON.stringify({ taken_at: now.toISOString(), tables }));

    const path = backupPath(now, kind);
    const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/gzip', upsert: false });
    if (up.error) throw new Error('upload');
    const { data: row, error } = await admin.from('backups').insert({ kind, path, size_bytes: bytes.length, tables: counts, status: 'ok' }).select('id').single();
    if (error) { await admin.storage.from(BUCKET).remove([path]); throw new Error(`record ${error.code ?? 'error'}`); }

    await prune().catch(() => logServer('backup-run', 'prune_exception'));
    if (actor) await admin.from('audit_log').insert({ actor, action: 'backup_manual', details: { id: row.id, size_bytes: bytes.length } });
    return json({ ok: true, id: row.id, size_bytes: bytes.length, tables: counts });
  } catch (e) {
    const why = cleanField(e instanceof Error ? e.message : 'unknown', 200);   // коды и имена таблиц, строк данных там нет
    await admin.from('backups').insert({ kind, path: null, status: 'failed', error: why }).then(() => {}, () => {});
    await logServer('backup-run', 'failed', why);
    await alertSysadmins('Журнал: сбой резервной копии', `Копия (${kind === 'nightly' ? 'ночная' : 'ручная'}) не создана: ${why}`);
    return json({ error: 'backup_failed' }, 500);
  }
});
