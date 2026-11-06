-- Тесты этапа 6 (закрытие и открытие семестра: semester_tick, права, режим «только просмотр»).
-- Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 7 сисадмин, 8 староста B, 9 студент B.
-- Группы: A (aaaa…0a), B (bbbb…0b), C (cccc…0c). Даты — от «сегодня по Минску».

create temp table d as select (now() at time zone 'Europe/Minsk')::date as today;
grant select on d to public;
create temp table kv (k text primary key, v jsonb);
grant all on kv to public;

insert into public.groups (id, name, status) values ('cccccccc-0000-4000-8000-00000000000c', 'ТЕСТ-3', 'closed');

-- A: семестр кончился вчера; B: кончится через 5 дней; C: закрыта вручную, семестр идёт
delete from public.schedule_meta where group_id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'cccccccc-0000-4000-8000-00000000000c');
insert into public.schedule_meta (group_id, semester_end)
select x.g::uuid, d.today + x.plus from d, (values
  ('aaaaaaaa-0000-4000-8000-00000000000a', -1), ('bbbbbbbb-0000-4000-8000-00000000000b', 5),
  ('cccccccc-0000-4000-8000-00000000000c', 60)) as x(g, plus);
update public.groups set status = 'active', semester_closed_for = null where id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b');
update public.groups set status = 'closed', semester_closed_for = null where id = 'cccccccc-0000-4000-8000-00000000000c';

-- ===== 1. Закрытие =====
insert into pg_temp.kv select 't1', public.semester_tick();
insert into pg_temp.kv select 't2', public.semester_tick();
insert into pg_temp.res select 'закрытие: первый запуск закрыл одну группу', (v ->> 'closed')::int = 1 and (v ->> 'opened')::int = 0, v::text from pg_temp.kv where k = 't1';
insert into pg_temp.res select 'закрытие: повторный запуск ничего не меняет', (v ->> 'closed')::int = 0 and (v ->> 'opened')::int = 0, v::text from pg_temp.kv where k = 't2';
insert into pg_temp.res select 'закрытие: A closed и помнит конец семестра',
  exists (select 1 from public.groups g, d where g.id = 'aaaaaaaa-0000-4000-8000-00000000000a' and g.status = 'closed' and g.semester_closed_for = d.today - 1), '';
insert into pg_temp.res select 'закрытие: B (семестр идёт) осталась открытой',
  (select status from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b') = 'active', '';
insert into pg_temp.res select 'закрытие: C (закрыта вручную) не тронута',
  (select status from public.groups where id = 'cccccccc-0000-4000-8000-00000000000c') = 'closed', '';
insert into pg_temp.res select 'закрытие: group_open(A) ложно', not public.group_open('aaaaaaaa-0000-4000-8000-00000000000a'), '';
insert into pg_temp.res select 'закрытие: староста и зам A получили по уведомлению, студенты нет',
  (select count(*) from public.notifications where kind = 'semester' and ref ->> 'state' = 'closed' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
      and user_id in (pg_temp.u(1), pg_temp.u(2))) = 2
  and not exists (select 1 from public.notifications where kind = 'semester' and ref ->> 'state' = 'closed' and user_id in (pg_temp.u(3), pg_temp.u(9))), '';
insert into pg_temp.res select 'закрытие: запись в audit_log с причиной',
  exists (select 1 from public.audit_log where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and action = 'group_status' and details ->> 'reason' = 'semester_end'), '';
select pg_temp.expect_denied('закрытие: староста A не вносит пропуск в закрытый журнал', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours, is_excused) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', current_date, 'Статистика', 2, false)$$);
select pg_temp.expect_denied('права: клиент не вызывает semester_tick', pg_temp.u(1), $$select public.semester_tick()$$);
select pg_temp.expect_denied('права: сисадмин тоже не вызывает semester_tick', pg_temp.u(7), $$select public.semester_tick()$$);

-- ===== 2. Ручное открытие после автозакрытия не закрывается снова тем же семестром =====
select pg_temp.as_user(pg_temp.u(7));
select public.sysadmin_set_group_status('aaaaaaaa-0000-4000-8000-00000000000a', 'active');
reset role;
insert into pg_temp.kv select 't3', public.semester_tick();
insert into pg_temp.res select 'ручное открытие: тот же конец семестра — группа остаётся открытой',
  (select status from public.groups where id = 'aaaaaaaa-0000-4000-8000-00000000000a') = 'active' and (v ->> 'closed')::int = 0, v::text from pg_temp.kv where k = 't3';

-- ===== 3. Новый семестр открывает группу =====
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
update public.groups set semester_closed_for = (select today - 1 from d) where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
update public.schedule_meta set semester_end = (select today + 100 from d) where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
insert into pg_temp.kv select 't4', public.semester_tick();
insert into pg_temp.kv select 't5', public.semester_tick();
insert into pg_temp.res select 'открытие: новый семестр открыл A и снял отметку', (v ->> 'opened')::int = 1
  and (select status = 'active' and semester_closed_for is null from public.groups where id = 'aaaaaaaa-0000-4000-8000-00000000000a'), v::text from pg_temp.kv where k = 't4';
insert into pg_temp.res select 'открытие: повтор ничего не меняет', (v ->> 'opened')::int = 0 and (v ->> 'closed')::int = 0, v::text from pg_temp.kv where k = 't5';
insert into pg_temp.res select 'открытие: староста и зам получили уведомление «открыт»',
  (select count(*) from public.notifications where kind = 'semester' and ref ->> 'state' = 'open' and user_id in (pg_temp.u(1), pg_temp.u(2))) = 2, '';
insert into pg_temp.res select 'открытие: C (закрыта вручную) не открылась сама',
  (select status from public.groups where id = 'cccccccc-0000-4000-8000-00000000000c') = 'closed', '';
select pg_temp.expect_allowed('открытие: староста A снова вносит пропуск', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours, is_excused) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', current_date, 'Статистика', 2, false)$$);

-- ===== 4. Ручное «Отключить» сбрасывает отметку: новый семестр группу не откроет =====
update public.groups set semester_closed_for = (select today - 10 from d) where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
select pg_temp.as_user(pg_temp.u(7));
select public.sysadmin_set_group_status('bbbbbbbb-0000-4000-8000-00000000000b', 'closed');
reset role;
insert into pg_temp.kv select 't6', public.semester_tick();
insert into pg_temp.res select 'ручное закрытие: отметка снята, группа остаётся закрытой',
  (select status = 'closed' and semester_closed_for is null from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b'), '';

-- ===== 5. Предупреждение за 14/7 дней говорит о закрытии и отчёте =====
update public.schedule_meta set semester_end = (select today + 10 from d) where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
insert into pg_temp.kv select 'nd', public.notify_daily();
insert into pg_temp.res select 'предупреждение: текст про закрытие и отчёт для деканата',
  exists (select 1 from public.notifications where kind = 'semester' and dedupe_key like 'semester:%' and body like '%закроется до начала следующего семестра%отчёт для деканата%'), '';

-- ===== 6. cron =====
insert into pg_temp.res select 'cron: задание journal-semester создано',
  to_regclass('cron.job') is null or exists (select 1 from cron.job where jobname = 'journal-semester' and schedule = '5 1 * * *'), '';
