// 2.1 п.13: алгоритм слияния старых справок-в-пропусках (tools/certs-merge.mjs) и его SQL-двойник в миграции
// 20261122100000_journal21_certificates.sql.
//   node tests/unit/certs-merge.mjs
// Часть 1 — чистый JS, без сети. Часть 2 — если найден PGlite (tools/test/pglite.mjs: npm i --no-save @electric-sql/pglite@0.2.17
// или PGLITE_DIR=…): миграция на тех же данных даёт те же справки (и с исключением v_join), повторный запуск ничего не меняет,
// откат возвращает пропуски как были. Часть 3 — то же на резервной копии прода, если она есть (CERTS_BACKUP=<папка> или путь по умолчанию).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mergeCerts, certKind, certId, mixedNote, JOIN } from '../../tools/certs-merge.mjs';
import { boot, applyFile } from '../../tools/test/pglite.mjs';

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('OK     ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); } };

const G = '00000000-0000-4000-8000-000000000024';
// учебные дни 24ДММ-2 вокруг тестовых дат: суббота 10.10 учебная, суббота 07.11 — праздник (не учебная)
const DAYS = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22',
  '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'];
let n = 0;
const ab = (sid, date, type, sub = true, due = null, extra = {}) => ({ id: `t-ab-${String(++n).padStart(3, '0')}`, group_id: G, student_id: sid, date, subject: 'Предмет ' + (n % 3), hours: 2,
  is_excused: true, cert_type: type, cert_submitted: sub, cert_due_date: due, certificate_id: null, ...extra });
const ROWS = [
  ab('t-s1', '2026-11-06', 'Больничный', true, '2026-11-12'), ab('t-s1', '2026-11-06', 'Больничный', false, '2026-11-14'), ab('t-s1', '2026-11-09', 'Больничный', true, '2026-11-13'),
  ab('t-s2', '2026-10-09', 'Больничный'), ab('t-s2', '2026-10-12', 'Больничный'),
  ab('t-s3', '2026-11-10', 'Освобождение'), ab('t-s3', '2026-11-10', 'Освобождение', false, '2026-11-20'), ab('t-s3', '2026-11-10', 'Заявление'),
  ab('t-s3', '2026-11-11', 'Справка'), ab('t-s3', '2026-11-11', 'Другое'),
  ab('t-s4', '2026-11-05', null, false), ab('t-s4', '2026-11-05', 'Больничный', false, null, { is_excused: false }),
  ab('t-s5', '2026-10-20', 'Больничный'), ab('t-s5', '2026-10-22', 'Больничный'),
];

// ---------- 1. чистый JS ----------
await t('вид справки по причине', () => {
  assert.equal(certKind('Больничный'), 'sick'); assert.equal(certKind(' Освобождение '), 'exemption'); assert.equal(certKind('Заявление'), 'statement');
  assert.equal(certKind('Справка'), 'other'); assert.equal(certKind('Другое'), 'other'); assert.equal(certKind(null), null); assert.equal(certKind('  '), null);
});
const R = mergeCerts(ROWS, new Map([[G, DAYS]]));
const of = (sid) => R.certs.filter((c) => c.student_id === sid);
await t('больничный через праздничные выходные (07.11 не учебный) — одна справка', () => {
  const c = of('t-s1');
  assert.equal(c.length, 1); assert.equal(c[0].date_from, '2026-11-06'); assert.equal(c[0].date_to, '2026-11-09'); assert.equal(c[0].absence_ids.length, 3);
  assert.equal(c[0].hours, 6);
});
await t('часть сдана, часть нет — «Не сдана» и даты в примечании; срок — самый поздний', () => {
  const c = of('t-s1')[0];
  assert.equal(c.status, 'waiting'); assert.equal(c.note, 'Объединено из пропусков: сдано за 06.11, 09.11; не сдано за 06.11');
  assert.equal(c.due_date, '2026-11-14'); assert.ok(c.mixedSubmitted && c.mixedDue);
});
await t('учебная суббота между больничными — разрыв, две справки', () => {
  const c = of('t-s2');
  assert.deepEqual(c.map((x) => [x.date_from, x.date_to, x.status]), [['2026-10-09', '2026-10-09', 'received'], ['2026-10-12', '2026-10-12', 'received']]);
  assert.ok(R.gaps.some((g) => g.student_id === 't-s2' && g.between.join() === '2026-10-10'));
});
await t('однодневные: одна справка на вид и день; «Справка» и «Другое» — один вид other', () => {
  const c = of('t-s3').map((x) => `${x.kind} ${x.date_from} ${x.absence_ids.length} ${x.status}`).sort();
  assert.deepEqual(c, ['exemption 2026-11-10 2 waiting', 'other 2026-11-11 2 received', 'statement 2026-11-10 1 received']);
});
await t('без причины — без справки (no_type); неуважительный — не учитывается', () => {
  assert.equal(of('t-s4').length, 0);
  assert.deepEqual(R.skipped.map((x) => `${x.a.student_id} ${x.why}`), ['t-s4 no_type']);
});
await t('уже привязанные и без даты — не трогаются', () => {
  const r = mergeCerts([ab('t-x', '2026-11-05', 'Больничный', true, null, { certificate_id: 'ce-1' }), ab('t-x', null, 'Заявление')], new Map());
  assert.deepEqual(r.skipped.map((x) => x.why), ['already', 'no_date']); assert.equal(r.certs.length, 0);
});
await t('исключение (студент, день) из JOIN не разрывает больничный только этому студенту', () => {
  assert.equal(of('t-s5').length, 2);
  const r = mergeCerts(ROWS, new Map([[G, DAYS]]), [{ student_id: 't-s5', day: '2026-10-21' }]);
  assert.deepEqual(r.certs.filter((c) => c.student_id === 't-s5').map((c) => [c.date_from, c.date_to]), [['2026-10-20', '2026-10-22']]);
});
await t('id детерминированный: ce-m13- + md5(студент|вид|начало)', () => {
  assert.equal(certId('t-s1', 'sick', '2026-11-06'), of('t-s1')[0].id);
  assert.match(of('t-s1')[0].id, /^ce-m13-[0-9a-f]{32}$/);
  assert.equal(mixedNote([{ date: '2026-11-02', cert_submitted: true }, { date: '2026-10-30', cert_submitted: true }, { date: '2026-11-01', cert_submitted: false }]),
    'Объединено из пропусков: сдано за 30.10, 02.11; не сдано за 01.11');
});

// ---------- 2. SQL == JS (PGlite) ----------
const UP = 'supabase/migrations/20261122100000_journal21_certificates.sql';
const DOWN = 'supabase/migrations_down/20261122100000_journal21_certificates.down.sql';
const certsSql = async (db) => (await db.query(`select c.id, c.student_id, c.kind, c.date_from::text f, c.date_to::text t, c.status, c.due_date::text due, c.note, c.open,
  (select string_agg(a.id, ',' order by a.id) from public.absences a where a.certificate_id = c.id) ids from public.certificates c order by c.id`)).rows;
const certsJs = (r) => r.certs.map((c) => ({ id: c.id, student_id: c.student_id, kind: c.kind, f: c.date_from, t: c.date_to, status: c.status, due: c.due_date, note: c.note, open: false,
  ids: [...c.absence_ids].sort().join(',') })).sort((a, b) => a.id.localeCompare(b.id));
const fp = async (db) => (await db.query(`select count(*)::int n, sum(hours)::text h, count(*) filter (where is_excused)::int e,
  md5(string_agg(concat_ws('|', id, date, hours, is_excused, cert_type, cert_submitted, cert_due_date, comment, subject), ',' order by id)) s from public.absences`)).rows[0];
const daysOf = async (db) => (await db.query(`select distinct lesson_date::text d from public.schedule_lessons where group_id = $1`, [G])).rows.map((r) => r.d);
// учебные дни тестовых данных — пары в расписании (study_days перенос не читает)
const lessons = (db) => db.query(`insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject) select $1, x::date, 1, 'Пара' from json_array_elements_text($2) x`, [G, JSON.stringify(DAYS)]);
async function fresh(absences, students) {
  const db = await boot('.', { before: '20261122100000' });
  if (!db) return null;
  const uids = [...new Set([...students.map((s) => s.claimed_by), ...absences.map((a) => a.created_by)].filter(Boolean))];
  await db.query('insert into auth.users (id) select x::uuid from json_array_elements_text($1) x', [JSON.stringify(uids)]);
  await load(db, 'students', students);
  await load(db, 'absences', absences);
  return db;
}
// вставка строк JSON: только переданные колонки (остальным — значения по умолчанию)
async function load(db, table, rows) {
  const cols = Object.keys(rows[0]).map((c) => `"${c}"`).join(', ');
  await db.query(`insert into public.${table} (${cols}) select ${cols} from json_populate_recordset(null::public.${table}, $1)`, [JSON.stringify(rows)]);
}
const V_JOIN = "v_join text[] := array['st-1758300000013|2026-10-21', 'st-1758300000024|2026-10-21'];";
const migrated = async (db, join) => {
  if (!join) return applyFile(db, UP);
  const src = readFileSync(UP, 'utf8');
  assert.ok(src.includes(V_JOIN), 'в миграции нет строки v_join');
  await db.exec('set check_function_bodies = off;\n' + src.replace(V_JOIN, `v_join text[] := array['${join}'];`));
};

const stu = [...new Set(ROWS.map((a) => a.student_id))].map((id) => ({ id, group_id: G, last_name: 'Тест', first_name: id, claim_status: 'free' }));
let probe = null;
try { probe = await fresh(ROWS, stu); if (probe) await lessons(probe); } catch (e) { failed++; console.log('ПРОВАЛ подготовка PGlite — ' + e.message); }
if (!probe) console.log('ПРОПУСК SQL == JS: PGlite не найден (npm i --no-save @electric-sql/pglite@0.2.17 или PGLITE_DIR=…)');
else {
  await t('SQL == JS на тестовых данных; пропуски не изменились', async () => {
    const days = await daysOf(probe);
    for (const d of ['2026-10-10', '2026-10-21', '2026-11-09']) assert.ok(days.includes(d), 'учебный день ' + d);
    assert.ok(!days.includes('2026-11-07'), '07.11 не учебный');
    assert.deepEqual(JOIN.map((j) => j.student_id + '|' + j.day), V_JOIN.match(/'([^']+)'/g).map((x) => x.slice(1, -1)), 'JOIN в JS = v_join в SQL');
    const before = await fp(probe);
    await migrated(probe);
    assert.deepEqual(await certsSql(probe), certsJs(mergeCerts(ROWS, new Map([[G, days]]))));
    assert.deepEqual(await fp(probe), before);
  });
  await t('повторный запуск миграции ничего не меняет; откат и снова вперёд', async () => {
    const c1 = await certsSql(probe), f1 = await fp(probe);
    await applyFile(probe, UP);
    assert.deepEqual(await certsSql(probe), c1);
    await applyFile(probe, DOWN);
    const r = (await probe.query(`select (select count(*)::int from public.certificates) c, (select count(*)::int from public.absences where certificate_id is not null) l,
      (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'certificates' and column_name = 'open') col`)).rows[0];
    assert.deepEqual(r, { c: 0, l: 0, col: 0 });
    assert.deepEqual(await fp(probe), f1);
    await applyFile(probe, UP);
    assert.deepEqual(await certsSql(probe), c1);
  });
  await t('SQL == JS с исключением v_join (t-s5, 21.10)', async () => {
    const db = await fresh(ROWS, stu); await lessons(db);
    const days = await daysOf(db);
    await migrated(db, 't-s5|2026-10-21');
    const sql = await certsSql(db);
    assert.deepEqual(sql, certsJs(mergeCerts(ROWS, new Map([[G, days]]), [{ student_id: 't-s5', day: '2026-10-21' }])));
    assert.ok(sql.some((c) => c.student_id === 't-s5' && c.f === '2026-10-20' && c.t === '2026-10-22'));
  });

  // ---------- 3. резервная копия прода ----------
  const B = process.env.CERTS_BACKUP || 'C:\\Users\\dimpo\\backups\\journal-pre-certs-2026-11-14-2026-11-14';
  if (!existsSync(join(B, 'absences.json'))) console.log('ПРОПУСК копия прода: нет ' + join(B, 'absences.json'));
  else await t('копия прода: SQL == JS, числа и поля пропусков те же', async () => {
    const rd = (f) => JSON.parse(readFileSync(join(B, f), 'utf8'));
    const db = await fresh(rd('absences.json'), rd('students.json'));
    await load(db, 'schedule_lessons', rd('schedule_lessons.json'));
    const days = await daysOf(db), before = await fp(db);
    await migrated(db);
    const sql = await certsSql(db), js = certsJs(mergeCerts(rd('absences.json'), new Map([[G, days]])));
    assert.deepEqual(sql, js);
    assert.deepEqual(await fp(db), before);
    console.log(`       копия: пропусков ${before.n}, часов ${before.h}, уважительных ${before.e}; справок ${sql.length}`);
    // итог, согласованный с владельцем 2026-11-14 (копия от того же дня; на другой копии числа могут отличаться)
    const r = (await db.query(`select s.last_name, c.kind, c.date_from::text f, c.date_to::text t, c.status, c.received_at is not null rcv,
        count(a.id)::int n, sum(a.hours)::int h from public.certificates c join public.students s on s.id = c.student_id
        join public.absences a on a.certificate_id = c.id group by 1, 2, 3, 4, 5, 6 order by c.kind <> 'sick', 1, 3`)).rows;
    r.forEach((x) => console.log(`       ${x.last_name} ${x.kind} ${x.f}–${x.t}: ${x.n} проп., ${x.h} ч, ${x.status}`));
    const sick = r.filter((x) => x.kind === 'sick').map((x) => `${x.last_name} ${x.f.slice(5)}–${x.t.slice(5)} ${x.n}/${x.h}`);
    assert.deepEqual(sick.sort(), ['Мороз 10-29–10-31 6/12', 'Мозоль 10-23–10-31 14/28', 'Ракитская 10-19–10-24 10/20', 'Шпакова 10-09–10-13 6/14',
      'Щигло 10-19–10-24 10/20', 'Янголь 09-23–09-30 16/34'].sort());
    assert.equal(r.length, 16); assert.equal(r.filter((x) => x.kind !== 'sick').length, 10);
    assert.equal(r.reduce((n, x) => n + x.n, 0), 74); assert.equal(r.reduce((n, x) => n + x.h, 0), 152);
    assert.ok(r.every((x) => x.status === 'received' && x.rcv), 'все сданы, received_at стоит');
    const old = rd('absences.json').filter((a) => a.cert_type);
    assert.equal(old.length, 74); assert.equal(old.reduce((n, a) => n + Number(a.hours), 0), 152);
  });
}

if (failed) { console.log(`\nПровалено: ${failed}`); process.exit(1); }
console.log('\nВсе проверки прошли');
