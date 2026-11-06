-- Тесты этапа 5 (утилита сисадмина). Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A («Маркетинг услуг»),
-- 6 препод ПЗ A («Маркетинг услуг»), 7 сисадмин, 8 староста B, 9 студент B, 10 студент 24ДММ-2, 11 без групп.
-- Здесь же: 12 — второй сисадмин (добавляется через RPC), 13 — владелец заявки.
-- Внутри транзакции now() постоянен: «окна» по времени задаются явными сдвигами at.

-- ===== помощники этого набора =====
create function pg_temp.val_as(u uuid, q text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(u);
  begin execute 'select (' || q || ')::text' into v; exception when others then v := 'ERR:' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.expect_err(t text, u uuid, q text, code text) returns void language plpgsql as $$
declare got text := pg_temp.val_as(u, q);
begin
  insert into pg_temp.res values (t, got = 'ERR:' || code, 'ожидалось ERR:' || code || ', получено ' || coalesce(got, 'null'));
end $$;
create function pg_temp.expect_val(t text, u uuid, q text, want text) returns void language plpgsql as $$
declare got text := pg_temp.val_as(u, q);
begin
  insert into pg_temp.res values (t, got is not distinct from want, 'ожидалось ' || coalesce(want, 'null') || ', получено ' || coalesce(got, 'null'));
end $$;
-- под сисадмином 7
create function pg_temp.sys(q text) returns text language sql as $$ select pg_temp.val_as(pg_temp.u(7), q) $$;
create function pg_temp.ok(t text, c boolean, d text default '') returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(c, false), coalesce(d, 'null')) $$;
-- событие с возрастом p_ago
create function pg_temp.ev(p_source text, p_kind text, p_name text, p_msg text, p_ms int, p_ok boolean, p_ago interval default '1 minute')
returns void language sql as
$$ insert into public.client_events (at, source, kind, name, message, ms, ok) values (now() - p_ago, p_source, p_kind, p_name, p_msg, p_ms, p_ok) $$;

-- ===== фикстуры этапа 5 (владелец) =====
-- данные прошлых прогонов и Edge Functions не должны влиять на счётчики (всё откатится)
delete from public.client_events e where e.id is not null;
delete from public.backups b where b.id is not null;
delete from public.ops_state o where o.key is not null;
delete from public.sysadmins s where s.user_id <> pg_temp.u(7);
delete from public.registration_requests r where r.owner_user_id in (pg_temp.u(11), pg_temp.u(13));
-- 13 после импорта привязан к студенту 24ДММ-2: освобождаем (как prelude для 1–11)
update public.students set claimed_by = null, claim_status = 'free' where claimed_by in (pg_temp.u(12), pg_temp.u(13));
delete from public.memberships where user_id in (pg_temp.u(12), pg_temp.u(13));
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===================================================================================================
-- 1. Таблицы и права
-- ===================================================================================================
select pg_temp.ok('права: anon и authenticated не вставляют в client_events, ops_state, backups',
  not has_table_privilege('anon', 'public.client_events', 'insert') and not has_table_privilege('authenticated', 'public.client_events', 'insert')
  and not has_table_privilege('anon', 'public.ops_state', 'insert') and not has_table_privilege('authenticated', 'public.ops_state', 'insert')
  and not has_table_privilege('anon', 'public.backups', 'insert') and not has_table_privilege('authenticated', 'public.backups', 'insert')
  and not has_table_privilege('authenticated', 'public.client_events', 'update') and not has_table_privilege('authenticated', 'public.client_events', 'delete'));
select pg_temp.ok('права: ops_state клиентам не читается вовсе, anon не читает client_events/backups',
  not has_table_privilege('authenticated', 'public.ops_state', 'select') and not has_table_privilege('anon', 'public.ops_state', 'select')
  and not has_table_privilege('anon', 'public.client_events', 'select') and not has_table_privilege('anon', 'public.backups', 'select'));

select pg_temp.ev('client', 'error', 'TypeError', 'x is undefined', null, null);
insert into public.backups (at, kind, path, size_bytes, tables, status) values (now() - interval '2 days', 'nightly', 'b/1.json.gz', 100, '{}', 'ok');
insert into public.ops_state (key, value, updated_at) values ('last_alert', '{"why":"test"}', '2000-01-01');

select pg_temp.expect_count('client_events: сисадмин читает', pg_temp.u(7), 'select 1 from public.client_events', 1);
select pg_temp.expect_count('client_events: студент не читает', pg_temp.u(3), 'select 1 from public.client_events', 0);
select pg_temp.expect_count('client_events: староста не читает', pg_temp.u(1), 'select 1 from public.client_events', 0);
select pg_temp.expect_count('client_events: преподаватель не читает', pg_temp.u(5), 'select 1 from public.client_events', 0);
select pg_temp.expect_count('backups: сисадмин читает', pg_temp.u(7), 'select 1 from public.backups', 1);
select pg_temp.expect_count('backups: староста не читает', pg_temp.u(1), 'select 1 from public.backups', 0);
select pg_temp.ok('ops_state: сисадмин напрямую не читает (нет права)', pg_temp.count_as(pg_temp.u(7), 'select 1 from public.ops_state') is null);
select pg_temp.expect_denied('client_events: сисадмин не вставляет', pg_temp.u(7),
  $$insert into public.client_events (source, kind, name) values ('client', 'error', 'x')$$);
select pg_temp.expect_denied('client_events: студент не вставляет', pg_temp.u(3),
  $$insert into public.client_events (source, kind, name) values ('client', 'error', 'x')$$);
select pg_temp.expect_denied('client_events: сисадмин не удаляет', pg_temp.u(7), 'delete from public.client_events where id is not null');
select pg_temp.expect_denied('ops_state: сисадмин не пишет', pg_temp.u(7), $$insert into public.ops_state (key) values ('last_alert2')$$);
select pg_temp.expect_denied('backups: сисадмин не пишет', pg_temp.u(7), $$insert into public.backups (kind, status) values ('manual', 'ok')$$);
select pg_temp.expect_denied('backups: сисадмин не правит', pg_temp.u(7), $$update public.backups set status = 'failed' where id is not null$$);
select pg_temp.ok('ops_state: updated_at ставит триггер (переданное время игнорируется)',
  (select updated_at = now() from public.ops_state where key = 'last_alert'));
select pg_temp.expect_error('client_events: message > 300 отклоняется',
  $$insert into public.client_events (source, kind, message) values ('client', 'error', repeat('x', 301))$$);
select pg_temp.expect_error('client_events: неизвестный kind отклоняется',
  $$insert into public.client_events (source, kind) values ('client', 'debug')$$);
select pg_temp.expect_error('client_events: неизвестный source отклоняется',
  $$insert into public.client_events (source, kind) values ('browser', 'error')$$);
select pg_temp.ok('client_events: колонок пользователя нет',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_events'
                 and column_name in ('user_id', 'student_id', 'email', 'ip')));
select pg_temp.ok('права: «Техработы» на трёх новых таблицах',
  (select count(*) from pg_policies where schemaname = 'public' and policyname = 'Техработы' and permissive = 'RESTRICTIVE'
      and tablename in ('client_events', 'ops_state', 'backups')) = 3);
select pg_temp.ok('Storage: хранилище backups закрытое и без политик',
  (select not public from storage.buckets where id = 'backups')
  and not exists (select 1 from pg_policies where schemaname = 'storage'
                   and (coalesce(qual, '') || coalesce(with_check, '')) like '%backups%'));

select pg_temp.ok('права: RPC этапа 5 — security definer с пустым search_path',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 15
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('ops_summary', 'ops_events', 'sysadmin_find_user', 'sysadmin_assign_teacher', 'sysadmin_remove_teacher',
                        'sysadmin_teachers', 'sysadmin_add_sysadmin', 'sysadmin_remove_sysadmin', 'sysadmin_list_sysadmins',
                        'sysadmin_create_group', 'sysadmin_set_group_status', 'sysadmin_group_subjects', 'ops_cleanup',
                        '_group_create', '_assert_sysadmin')));
select pg_temp.ok('права: внутренние и служебные функции закрыты для клиентов',
  not has_function_privilege('authenticated', 'public._group_create(jsonb, jsonb, text)', 'execute')
  and not has_function_privilege('authenticated', 'public._group_payload_check(jsonb, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public._assert_sysadmin(boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.ops_cleanup()', 'execute')
  and has_function_privilege('service_role', 'public.ops_cleanup()', 'execute'));
select pg_temp.ok('права: аноним не вызывает RPC этапа 5',
  not has_function_privilege('anon', 'public.ops_summary(int)', 'execute')
  and not has_function_privilege('anon', 'public.ops_events(text, text, int, int, bigint)', 'execute')
  and not has_function_privilege('anon', 'public.sysadmin_find_user(text)', 'execute')
  and not has_function_privilege('anon', 'public.sysadmin_create_group(jsonb, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.sysadmin_add_sysadmin(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.sysadmin_assign_teacher(uuid, uuid, text, text[])', 'execute'));
select pg_temp.ok('права: RPC этапа 5 не трогают chat_* и tg_*',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('ops_summary', 'ops_events', 'sysadmin_find_user', 'sysadmin_assign_teacher', 'sysadmin_remove_teacher',
                                   'sysadmin_teachers', 'sysadmin_add_sysadmin', 'sysadmin_remove_sysadmin', 'sysadmin_list_sysadmins',
                                   'sysadmin_create_group', 'sysadmin_set_group_status', 'sysadmin_group_subjects', 'ops_cleanup',
                                   '_group_create', '_group_payload_check', '_assert_sysadmin')
                 and p.prosrc ~* '(chat_|tg_)'));
-- pg-safeupdate (PostgREST) отклоняет update/delete без where; CLI-тесты этого не видят
select pg_temp.ok('права: в функциях этапа 5 нет update/delete без where',
  not exists (select 1 from pg_proc p, regexp_split_to_table(p.prosrc, ';') stmt
               where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('sysadmin_assign_teacher', 'sysadmin_remove_teacher', 'sysadmin_remove_sysadmin',
                                   'sysadmin_set_group_status', 'ops_cleanup', 'sysadmin_approve_registration',
                                   'sysadmin_create_group', 'sysadmin_add_sysadmin', '_group_create')
                 and stmt ~* '\m(update\s+public\.|delete\s+from\s+public\.)'
                 and stmt !~* '\mwhere\M'));

-- Каждый RPC закрыт студенту, старосте и преподавателю
do $$
declare q text; u int;
begin
  foreach u in array array[3, 1, 5] loop
    foreach q in array array[
      'public.ops_summary(24)',
      '(select count(*) from public.ops_events())',
      $q$public.sysadmin_find_user('x@y')$q$,
      format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика}'),
      format('public.sysadmin_remove_teacher(%L, %L)', pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a'),
      $q$(select count(*) from public.sysadmin_teachers('aaaaaaaa-0000-4000-8000-00000000000a'))$q$,
      format('public.sysadmin_add_sysadmin(%L)', pg_temp.u(u)),
      format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(7)),
      '(select count(*) from public.sysadmin_list_sysadmins())',
      $q$public.sysadmin_create_group('{"name":"ВЗЛОМ"}', '[{"last_name":"А","first_name":"Б"}]')$q$,
      $q$public.sysadmin_set_group_status('aaaaaaaa-0000-4000-8000-00000000000a', 'closed')$q$,
      $q$public.sysadmin_group_subjects('aaaaaaaa-0000-4000-8000-00000000000a')$q$] loop
      perform pg_temp.expect_err('отказ: пользователь ' || u || ' → ' || left(q, 45), pg_temp.u(u), q, 'forbidden');
    end loop;
  end loop;
end $$;
select pg_temp.ok('отказы не изменили данные', (select count(*) from public.sysadmins) = 1
  and (select status from public.groups where id = 'aaaaaaaa-0000-4000-8000-00000000000a') = 'active'
  and not exists (select 1 from public.groups where name = 'ВЗЛОМ'));

-- cron (если есть pg_cron в тестовом проекте)
do $$
begin
  if to_regclass('cron.job') is not null then
    insert into pg_temp.res select 'cron: четыре задания этапа 5, адрес не прод, очистка через ops_cleanup',
      (select count(*) from cron.job where jobname in ('journal-health', 'journal-ops-report', 'journal-backup', 'journal-ops-cleanup')) = 4
      and (select schedule from cron.job where jobname = 'journal-health') = '*/5 * * * *'
      and (select schedule from cron.job where jobname = 'journal-ops-report') = '0 6 * * *'
      and (select schedule from cron.job where jobname = 'journal-backup') = '30 0 * * *'
      and (select schedule from cron.job where jobname = 'journal-ops-cleanup') = '15 1 * * *'
      and (select command from cron.job where jobname = 'journal-health') like '%/functions/v1/health-check%'
      and (select command from cron.job where jobname = 'journal-backup') like '%/functions/v1/backup-run%'
      and (select command from cron.job where jobname = 'journal-ops-report') like '%/functions/v1/ops-report%cron_secret%'
      and not exists (select 1 from cron.job where command like '%woiqekpuoddxixlrbvkp%')
      and (select command from cron.job where jobname = 'journal-ops-cleanup') = 'select public.ops_cleanup()', '';
  end if;
end $$;

-- ===================================================================================================
-- 2. ops_summary
-- ===================================================================================================
delete from public.client_events e where e.id is not null;
delete from public.backups b where b.id is not null;
delete from public.ops_state o where o.key is not null;

-- 0 строк
select pg_temp.expect_val('сводка (пусто): доступность null', pg_temp.u(7), $$public.ops_summary(24) -> 'availability_pct'$$, 'null');
select pg_temp.expect_val('сводка (пусто): пингов 0', pg_temp.u(7), $$public.ops_summary(24) ->> 'pings'$$, '0');
select pg_temp.expect_val('сводка (пусто): p50/p95 ответа и страницы null', pg_temp.u(7),
  $$(select string_agg(coalesce(s -> k, '"x"'::jsonb)::text, ',') from (select public.ops_summary(24) s) x, unnest(array['resp_p50_ms','resp_p95_ms','page_p50_ms','page_p95_ms']) k)$$,
  'null,null,null,null');
select pg_temp.expect_val('сводка (пусто): ошибок 0, топ пуст', pg_temp.u(7),
  $$(select (s ->> 'client_errors') || '/' || (s ->> 'server_errors') || '/' || (s -> 'top_errors')::text from (select public.ops_summary(24) s) x)$$, '0/0/[]');
select pg_temp.expect_val('сводка (пусто): копии и алерта нет', pg_temp.u(7),
  $$(select (s -> 'backup_last')::text || '/' || (s -> 'last_alert_at')::text || '/' || (s -> 'last_digest_at')::text from (select public.ops_summary(24) s) x)$$,
  'null/null/null');
select pg_temp.expect_val('сводка: техработ нет → false', pg_temp.u(7), $$public.ops_summary(24) ->> 'maintenance'$$, 'false');

-- 1 строка
select pg_temp.ev('health', 'ping', 'db', null, 100, true);
select pg_temp.expect_val('сводка (1 пинг): 100 %, p50 = p95 = 100', pg_temp.u(7),
  $$(select concat_ws('/', s ->> 'availability_pct', s ->> 'pings', s ->> 'resp_p50_ms', s ->> 'resp_p95_ms') from (select public.ops_summary(24) s) x)$$,
  '100.0/1/100/100');

-- много строк
delete from public.client_events e where e.id is not null;
select pg_temp.ev('health', 'ping', 'db', null, ms, ms <> 50) from unnest(array[10, 20, 30, 40, 50]) ms;
select pg_temp.ev('health', 'ping', 'site', null, 999, true);
select pg_temp.ev('health', 'ping', 'db', null, 5, false, '30 hours');                  -- вне 24 ч
select pg_temp.ev('client', 'perf', 'page', null, ms, null) from unnest(array[100, 300, 200]) ms;
select pg_temp.ev('client', 'perf', 'api', null, 9999, null);                            -- не страница
select pg_temp.ev('client', 'error', 'TypeError', 'x is undefined', null, null) from generate_series(1, 3);
select pg_temp.ev('client', 'error', 'E' || i, 'm', null, null) from generate_series(1, 5) i;
select pg_temp.ev('server', 'error', 'schedule-import', 'fail', null, null) from generate_series(1, 2);
select pg_temp.ev('client', 'error', 'Old', 'старая', null, null, '25 hours');
select pg_temp.expect_val('сводка 24 ч: доступность 5/6 = 83.3, пингов 6', pg_temp.u(7),
  $$(select (s ->> 'availability_pct') || '/' || (s ->> 'pings') from (select public.ops_summary(24) s) x)$$, '83.3/6');
select pg_temp.expect_val('сводка 24 ч: ответ БД p50 30, p95 48 (интерполяция, только name=db)', pg_temp.u(7),
  $$(select (s ->> 'resp_p50_ms') || '/' || (s ->> 'resp_p95_ms') from (select public.ops_summary(24) s) x)$$, '30/48');
select pg_temp.expect_val('сводка 24 ч: страница p50 200, p95 290 (только perf page)', pg_temp.u(7),
  $$(select (s ->> 'page_p50_ms') || '/' || (s ->> 'page_p95_ms') from (select public.ops_summary(24) s) x)$$, '200/290');
select pg_temp.expect_val('сводка 24 ч: ошибок браузера 8, сервера 2', pg_temp.u(7),
  $$(select (s ->> 'client_errors') || '/' || (s ->> 'server_errors') from (select public.ops_summary(24) s) x)$$, '8/2');
select pg_temp.expect_val('сводка 24 ч: топ ошибок — 5 строк, первые TypeError×3 и schedule-import×2', pg_temp.u(7),
  $$(select jsonb_array_length(t) || '|' || (t -> 0 ->> 'name') || ':' || (t -> 0 ->> 'message') || ':' || (t -> 0 ->> 'count')
            || '|' || (t -> 1 ->> 'name') || ':' || (t -> 1 ->> 'count') from (select public.ops_summary(24) -> 'top_errors' t) x)$$,
  '5|TypeError:x is undefined:3|schedule-import:2');
select pg_temp.expect_val('сводка 48 ч: старый пинг входит (5/7 = 71.4), p50 25, p95 48', pg_temp.u(7),
  $$(select concat_ws('/', s ->> 'availability_pct', s ->> 'pings', s ->> 'resp_p50_ms', s ->> 'resp_p95_ms') from (select public.ops_summary(48) s) x)$$,
  '71.4/7/25/48');
select pg_temp.expect_val('сводка 1 ч: окно 1 час работает', pg_temp.u(7), $$public.ops_summary(1) ->> 'pings'$$, '6');
select pg_temp.expect_call_ok('сводка: 720 ч допустимо', pg_temp.u(7), 'select public.ops_summary(720)');
select pg_temp.expect_err('сводка: 0 ч → bad_hours', pg_temp.u(7), 'public.ops_summary(0)', 'bad_hours');
select pg_temp.expect_err('сводка: 721 ч → bad_hours', pg_temp.u(7), 'public.ops_summary(721)', 'bad_hours');
select pg_temp.expect_err('сводка: null → bad_hours', pg_temp.u(7), 'public.ops_summary(null)', 'bad_hours');

-- импорт, заявки, состояние, копии, техработы
insert into public.schedule_meta (group_id, last_import_at, last_status, last_error, lessons_count)
  values ('aaaaaaaa-0000-4000-8000-00000000000a', now(), 'ok', null, 12)
  on conflict (group_id) do update set last_status = 'ok', lessons_count = 12, last_error = null;
insert into public.groups (id, name, status) values ('cccccccc-0000-4000-8000-00000000000c', 'ТЕСТ-ВЫПУСК', 'graduated');
select pg_temp.expect_val('сводка: импорт группы A (статус и число занятий)', pg_temp.u(7),
  $$(select e ->> 'last_status' || '/' || (e ->> 'lessons_count') || '/' || (e ->> 'name')
       from jsonb_array_elements(public.ops_summary(24) -> 'imports') e where e ->> 'group_id' = 'aaaaaaaa-0000-4000-8000-00000000000a')$$,
  'ok/12/ТЕСТ-1');
select pg_temp.expect_val('сводка: выпустившаяся группа в импорте не показывается', pg_temp.u(7),
  $$(select count(*) from jsonb_array_elements(public.ops_summary(24) -> 'imports') e where e ->> 'group_id' = 'cccccccc-0000-4000-8000-00000000000c')$$, '0');
select pg_temp.expect_val('сводка: заявки и ожидающие студенты = счётчики таблиц', pg_temp.u(7),
  $$(select (s ->> 'pending_requests') || '/' || (s ->> 'pending_students') from (select public.ops_summary(24) s) x)$$,
  (select (select count(*) from public.registration_requests where status = 'submitted') || '/'
          || (select count(*) from public.students where claim_status = 'pending')));
insert into public.ops_state (key, value) values ('last_alert', '{}'), ('last_digest', '{"n":1}');
insert into public.backups (at, kind, path, size_bytes, status) values
  (now() - interval '2 days', 'nightly', 'a.json.gz', 100, 'ok'),
  (now() - interval '1 hour', 'manual', null, null, 'failed');
select pg_temp.expect_val('сводка: last_alert_at и last_digest_at из ops_state', pg_temp.u(7),
  $$(select ((s ->> 'last_alert_at')::timestamptz = now() and (s ->> 'last_digest_at')::timestamptz = now())::text from (select public.ops_summary(24) s) x)$$, 'true');
select pg_temp.expect_val('сводка: backup_last — самая новая копия (даже failed)', pg_temp.u(7),
  $$(select (b ->> 'status') || '/' || coalesce(b ->> 'size_bytes', 'null') || '/' || ((b ->> 'at')::timestamptz = now() - interval '1 hour')
       from (select public.ops_summary(24) -> 'backup_last' b) x)$$, 'failed/null/true');
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_val('сводка: при техработах сисадмин видит maintenance = true', pg_temp.u(7), $$public.ops_summary(24) ->> 'maintenance'$$, 'true');
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===================================================================================================
-- 3. ops_events и очистка
-- ===================================================================================================
select pg_temp.expect_val('события: все за 24 ч (без старых)', pg_temp.u(7), '(select count(*) from public.ops_events())', '20');
select pg_temp.expect_val('события: от новых к старым (id убывает)', pg_temp.u(7),
  $$(select bool_and(x.id > x.nid) from (select e.id, lead(e.id) over () as nid from public.ops_events() e) x where x.nid is not null)$$, 'true');
select pg_temp.expect_val('события: фильтр source=server', pg_temp.u(7), $$(select count(*) from public.ops_events('server'))$$, '2');
select pg_temp.expect_val('события: фильтр kind=ping', pg_temp.u(7), $$(select count(*) from public.ops_events(null, 'ping'))$$, '6');
select pg_temp.expect_val('события: client + error', pg_temp.u(7), $$(select count(*) from public.ops_events('client', 'error'))$$, '8');
select pg_temp.expect_val('события: 48 ч включают старые', pg_temp.u(7), $$(select count(*) from public.ops_events(null, null, 48))$$, '22');
select pg_temp.expect_val('события: лимит 3', pg_temp.u(7), $$(select count(*) from public.ops_events(null, null, 24, 3))$$, '3');
select pg_temp.expect_val('события: курсор p_before — следующая страница без повторов', pg_temp.u(7),
  $$(select count(*) from public.ops_events(null, null, 24, 100, (select min(id) from public.ops_events(null, null, 24, 3))))$$, '17');
select pg_temp.ev('client', 'perf', 'api', null, 1, null) from generate_series(1, 250);
select pg_temp.expect_val('события: лимит не больше 200', pg_temp.u(7), $$(select count(*) from public.ops_events(null, null, 24, 1000))$$, '200');
select pg_temp.expect_val('события: лимит 0 → 1', pg_temp.u(7), $$(select count(*) from public.ops_events(null, null, 24, 0))$$, '1');
select pg_temp.expect_err('события: 0 ч → bad_hours', pg_temp.u(7), '(select count(*) from public.ops_events(null, null, 0))', 'bad_hours');

select pg_temp.ev('client', 'error', 'Очень старое', null, null, null, '31 days');
select pg_temp.ev('client', 'error', 'Почти старое', null, null, null, '29 days');
create temp table cl as select public.ops_cleanup() as n;
select pg_temp.ok('очистка: удаляет только старше 30 дней', (select n from cl) = 1
  and not exists (select 1 from public.client_events where name = 'Очень старое')
  and exists (select 1 from public.client_events where name = 'Почти старое')
  and (select count(*) from public.client_events) = 273,
  (select n from cl) || '/' || (select count(*) from public.client_events));
select pg_temp.expect_err('очистка: клиенту закрыта', pg_temp.u(7), 'public.ops_cleanup()', 'permission denied for function ops_cleanup');

-- ===================================================================================================
-- 4. sysadmin_find_user
-- ===================================================================================================
select pg_temp.expect_val('поиск: по почте без учёта регистра и пробелов', pg_temp.u(7),
  format('public.sysadmin_find_user(%L)', '  ' || upper((select email from auth.users where id = pg_temp.u(3))) || ' '), pg_temp.u(3)::text);
select pg_temp.expect_val('поиск: нет такого → null', pg_temp.u(7), $$public.sysadmin_find_user('nobody-ops@nowhere.example')$$, null);
select pg_temp.expect_val('поиск: null → null', pg_temp.u(7), 'public.sysadmin_find_user(null)', null);

-- ===================================================================================================
-- 5. Преподаватели
-- ===================================================================================================
select pg_temp.expect_val('преподаватель: назначение пользователя без групп (ПЗ, дубли и пробелы схлопываются)', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_practice',
         '{Статистика," Статистика ",Эконометрика}'), '{"ok": true}');
select pg_temp.ok('преподаватель: active-членство ПЗ без согласия, 2 назначения practice',
  (select status = 'active' and base_role = 'teacher_practice' and consent_at is null and student_id is null
     from public.memberships where user_id = pg_temp.u(11) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a')
  and (select array_agg(subject || ':' || lesson_kind order by subject) from public.teacher_assignments
        where user_id = pg_temp.u(11) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a') = '{Статистика:practice,Эконометрика:practice}');
select pg_temp.expect_count('преподаватель: пропуски чужих дисциплин и видов не видит', pg_temp.u(11),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_count('преподаватель: teaches(Статистика, practice) истинно', pg_temp.u(11),
  $$select 1 where public.teaches('aaaaaaaa-0000-4000-8000-00000000000a', 'Статистика', 'practice')$$, 1);
select pg_temp.expect_val('преподаватель: повторное назначение заменяет набор и вид', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L) ->> %L', pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture',
         '{Статистика}', 'ok'), 'true');
select pg_temp.ok('преподаватель: после замены — одна лекция «Статистика», роль лекций',
  (select array_agg(subject || ':' || lesson_kind) from public.teacher_assignments
    where user_id = pg_temp.u(11) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a') = '{Статистика:lecture}'
  and (select base_role from public.memberships where user_id = pg_temp.u(11) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a') = 'teacher_lecture');
select pg_temp.expect_count('преподаватель: теперь видит лекционный пропуск «Статистики»', pg_temp.u(11),
  $$select 1 from public.absences where id = 'abs-a3'$$, 1);
select pg_temp.ok('преподаватель: audit_log teacher_assign с предметами',
  exists (select 1 from public.audit_log where action = 'teacher_assign' and actor = pg_temp.u(7)
           and details ->> 'user_id' = pg_temp.u(11)::text and details -> 'subjects' = '["Статистика"]'::jsonb));

select pg_temp.expect_err('преподаватель: active-студент группы → is_student', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика}'), 'is_student');
select pg_temp.expect_err('преподаватель: староста группы → is_student', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика}'), 'is_student');
select pg_temp.expect_err('преподаватель: ожидающий студент группы → is_student', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(4), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика}'), 'is_student');
select pg_temp.ok('преподаватель: отказ is_student не изменил членство студента',
  (select base_role = 'student' and extra_role is null and status = 'active' from public.memberships
    where user_id = pg_temp.u(3) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.teacher_assignments where user_id = pg_temp.u(3)));
select pg_temp.expect_val('преподаватель: студент группы A может преподавать в группе B', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L) ->> %L', pg_temp.u(3), 'bbbbbbbb-0000-4000-8000-00000000000b', 'teacher_lecture', '{Логистика}', 'ok'), 'true');
select pg_temp.expect_err('преподаватель: пустой список → bad_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{}'), 'bad_subjects');
select pg_temp.expect_err('преподаватель: null вместо списка → bad_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, null)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture'), 'bad_subjects');
select pg_temp.expect_err('преподаватель: пустой предмет → bad_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика,"  "}'), 'bad_subjects');
select pg_temp.expect_err('преподаватель: предмет null в массиве → bad_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, array[%L, null])', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', 'Статистика'), 'bad_subjects');
select pg_temp.expect_err('преподаватель: предмет длиннее 200 → bad_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, array[%L])', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', repeat('я', 201)), 'bad_subjects');
select pg_temp.expect_err('преподаватель: 21 предмет → too_many_subjects', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, (select array_agg(%L || i) from generate_series(1, 21) i))',
         pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', 'Предмет '), 'too_many_subjects');
select pg_temp.expect_val('преподаватель: 20 предметов можно', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, (select array_agg(%L || i) from generate_series(1, 20) i)) ->> %L',
         pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', 'Предмет ', 'ok'), 'true');
select pg_temp.expect_err('преподаватель: роль teacher → bad_role', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher', '{Статистика}'), 'bad_role');
select pg_temp.expect_err('преподаватель: роль headman → bad_role', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', 'headman', '{Статистика}'), 'bad_role');
select pg_temp.expect_err('преподаватель: роль null → bad_role', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, null, %L)', pg_temp.u(12), 'aaaaaaaa-0000-4000-8000-00000000000a', '{Статистика}'), 'bad_role');
select pg_temp.expect_err('преподаватель: неизвестная группа → not_found', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', pg_temp.u(12), 'dddddddd-0000-4000-8000-00000000000d', 'teacher_lecture', '{Статистика}'), 'not_found');
select pg_temp.expect_err('преподаватель: неизвестный пользователь → user_not_found', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L)', 'dddddddd-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Статистика}'), 'user_not_found');

select pg_temp.expect_val('список преподавателей A: лектор, практик, 11 и 12 — с почтой, ролью и предметами', pg_temp.u(7),
  $$(select count(*) || '/' || bool_and(email is not null and status = 'active')
       || '/' || (select array_to_string(subjects, ',') || ':' || role from public.sysadmin_teachers('aaaaaaaa-0000-4000-8000-00000000000a') t
                   where t.user_id = '$$ || pg_temp.u(5) || $$')
       from public.sysadmin_teachers('aaaaaaaa-0000-4000-8000-00000000000a'))$$,
  '4/true/Маркетинг услуг:teacher_lecture');

-- снятие: лектор 5 с тредом старосты → тред пропадает
insert into public.chat_threads (group_id, student_user_id, teacher_user_id, kind)
  values ('aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(1), pg_temp.u(5), 'lecture');
select pg_temp.expect_count('снятие: до — староста видит тред с лектором', pg_temp.u(1), 'select 1 from public.chat_threads', 1);
select pg_temp.expect_val('снятие: лектор снят', pg_temp.u(7),
  format('public.sysadmin_remove_teacher(%L, %L)', pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a'), '{"ok": true, "assignments": 1}');
select pg_temp.ok('снятие: членство removed, назначений нет',
  (select status from public.memberships where user_id = pg_temp.u(5) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a') = 'removed'
  and not exists (select 1 from public.teacher_assignments where user_id = pg_temp.u(5) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_count('снятие: тред пропал у старосты', pg_temp.u(1), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('снятие: тред пропал у бывшего лектора', pg_temp.u(5), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('снятие: бывший лектор не видит пропуски группы', pg_temp.u(5),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.ok('снятие: audit_log teacher_remove',
  exists (select 1 from public.audit_log where action = 'teacher_remove' and details ->> 'user_id' = pg_temp.u(5)::text));
select pg_temp.expect_val('снятие: в списке со статусом removed и без предметов', pg_temp.u(7),
  format($$(select status || ':' || cardinality(subjects) from public.sysadmin_teachers('aaaaaaaa-0000-4000-8000-00000000000a') where user_id = %L)$$, pg_temp.u(5)),
  'removed:0');
select pg_temp.expect_err('снятие: студент (не преподаватель) → not_teacher', pg_temp.u(7),
  format('public.sysadmin_remove_teacher(%L, %L)', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a'), 'not_teacher');
select pg_temp.ok('снятие: студент после отказа остался active-студентом',
  (select status = 'active' and base_role = 'student' from public.memberships
    where user_id = pg_temp.u(3) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_err('снятие: нет членства → not_teacher', pg_temp.u(7),
  format('public.sysadmin_remove_teacher(%L, %L)', pg_temp.u(11), 'bbbbbbbb-0000-4000-8000-00000000000b'), 'not_teacher');
select pg_temp.expect_val('снятие: повторное назначение возвращает тред', pg_temp.u(7),
  format('public.sysadmin_assign_teacher(%L, %L, %L, %L) ->> %L', pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', 'teacher_lecture', '{Маркетинг услуг}', 'ok'), 'true');
select pg_temp.expect_count('снятие: после возврата староста снова видит тред', pg_temp.u(1), 'select 1 from public.chat_threads', 1);
select pg_temp.expect_count('сисадмин: чат по-прежнему не виден', pg_temp.u(7), 'select 1 from public.chat_threads', 0);

-- ===================================================================================================
-- 6. Группы: создание, статус, предметы
-- ===================================================================================================
create temp table cg0 as
  select pg_temp.sys($$public.sysadmin_create_group(
    '{"name":"ТЕСТ-НОВАЯ","group_no":"ТЕСТ-НОВАЯ","faculty":"ФМк","study_form":"Дневная","course":"2","bseu_faculty_id":"13","bseu_form_id":"10","bseu_group_id":"9999"}',
    '[{"last_name":" Иванов ","first_name":"Иван","study_form":"budget"},{"lastName":"Петров","firstName":"Пётр"},{"last_name":"Сидоров","first_name":"Сидор","study_form":"paid"}]')$$) as t;
create temp table cg as select case when t like 'ERR:%' then '{}'::jsonb else t::jsonb end as r, t from cg0;
select pg_temp.ok('группа: создана, ответ {group_id, code}, код XXXX-XXXX',
  (select (select array_agg(k order by k) from jsonb_object_keys(r) k) = '{code,group_id}' and r ->> 'code' ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$' from cg),
  (select t from cg));
select pg_temp.ok('группа: поля группы из payload, status active',
  (select g.name = 'ТЕСТ-НОВАЯ' and g.status = 'active' and g.course = 2 and g.faculty = 'ФМк' and g.bseu_group_id = '9999'
          and g.university = 'БГЭУ' and g.schedule_status is null
     from public.groups g, cg where g.id = (cg.r ->> 'group_id')::uuid));
select pg_temp.ok('группа: студенты в порядке списка, ФИО обрезаны, формы budget/null/paid',
  (select string_agg(s.sort || ':' || s.last_name || ':' || coalesce(s.study_form, '-') || ':' || s.claim_status, ',' order by s.sort)
     from public.students s, cg where s.group_id = (cg.r ->> 'group_id')::uuid)
  = '1:Иванов:budget:free,2:Петров:-:free,3:Сидоров:paid:free');
select pg_temp.ok('группа: в базе только хэш кода (sha-256 без дефиса)',
  (select i.code_hash = encode(extensions.digest(replace(cg.r ->> 'code', '-', ''), 'sha256'), 'hex')
     from public.group_invites i, cg where i.group_id = (cg.r ->> 'group_id')::uuid));
select pg_temp.ok('группа: членств не создано (старосты нет)',
  not exists (select 1 from public.memberships m, cg where m.group_id = (cg.r ->> 'group_id')::uuid));
select pg_temp.ok('группа: audit_log group_create без кода',
  (select count(*) = 1 and bool_and(a.actor = pg_temp.u(7) and a.details ->> 'students' = '3'
                                     and a.details::text not like '%' || (cg.r ->> 'code') || '%'
                                     and a.details::text not like '%' || replace(cg.r ->> 'code', '-', '') || '%'
                                     and not a.details ? 'code')
     from public.audit_log a, cg where a.action = 'group_create' and a.group_id = (cg.r ->> 'group_id')::uuid));
select pg_temp.expect_err('группа: то же имя (регистр, пробелы) → duplicate_group', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"  тест-новая "}', '[{"last_name":"А","first_name":"Б"}]')$$, 'duplicate_group');
update public.groups set status = 'closed' where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
select pg_temp.expect_err('группа: имя закрытой группы тоже занято', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-2"}', '[{"last_name":"А","first_name":"Б"}]')$$, 'duplicate_group');
update public.groups set status = 'active' where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
select pg_temp.expect_val('группа: имя выпустившейся группы можно взять', pg_temp.u(7),
  $$public.sysadmin_create_group('{"group_no":"ТЕСТ-ВЫПУСК"}', '[{"last_name":"А","first_name":"Б"}]') ? 'code'$$, 'true');
select pg_temp.expect_err('группа: одинаковые ФИО (регистр) → duplicate_student', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д1"}', '[{"last_name":"Иванов","first_name":"Иван"},{"lastName":"иванов ","firstName":" ИВАН"}]')$$, 'duplicate_student');
select pg_temp.expect_err('группа: форма обучения free → bad_student', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д2"}', '[{"last_name":"А","first_name":"Б","study_form":"free"}]')$$, 'bad_student');
select pg_temp.expect_err('группа: пустая форма обучения → bad_student', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д2"}', '[{"last_name":"А","first_name":"Б","study_form":""}]')$$, 'bad_student');
select pg_temp.expect_err('группа: пустая фамилия → bad_student', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д3"}', '[{"last_name":"  ","first_name":"Б"}]')$$, 'bad_student');
select pg_temp.expect_err('группа: студент не объект → bad_student', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д3"}', '["Иванов Иван"]')$$, 'bad_student');
select pg_temp.expect_err('группа: имя студента > 100 → bad_student', pg_temp.u(7),
  format('public.sysadmin_create_group(%L, %L)', '{"name":"ТЕСТ-Д3"}', jsonb_build_array(jsonb_build_object('last_name', repeat('я', 101), 'first_name', 'Б'))), 'bad_student');
select pg_temp.expect_err('группа: без студентов → no_students', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д4"}', '[]')$$, 'no_students');
select pg_temp.expect_err('группа: 301 студент → too_many_students', pg_temp.u(7),
  format('public.sysadmin_create_group(%L, %L)', '{"name":"ТЕСТ-Д4"}',
         (select jsonb_agg(jsonb_build_object('last_name', 'Ф' || i, 'first_name', 'И')) from generate_series(1, 301) i)), 'too_many_students');
select pg_temp.expect_err('группа: пустое имя → bad_payload', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":" "}', '[{"last_name":"А","first_name":"Б"}]')$$, 'bad_payload');
select pg_temp.expect_err('группа: имя > 60 → bad_payload', pg_temp.u(7),
  format('public.sysadmin_create_group(%L, %L)', jsonb_build_object('name', repeat('Г', 61)), '[{"last_name":"А","first_name":"Б"}]'), 'bad_payload');
select pg_temp.expect_err('группа: payload не объект → bad_payload', pg_temp.u(7),
  $$public.sysadmin_create_group('"ТЕСТ"', '[{"last_name":"А","first_name":"Б"}]')$$, 'bad_payload');
select pg_temp.expect_err('группа: студенты не массив → bad_payload', pg_temp.u(7),
  $$public.sysadmin_create_group('{"name":"ТЕСТ-Д5"}', '{"last_name":"А"}')$$, 'bad_payload');
select pg_temp.ok('группа: отказы не создали групп',
  not exists (select 1 from public.groups where name like 'ТЕСТ-Д%'));

-- статус: закрыть и открыть
select pg_temp.expect_val('статус: закрыть группу A', pg_temp.u(7),
  $$public.sysadmin_set_group_status('aaaaaaaa-0000-4000-8000-00000000000a', 'closed')$$, '{"ok": true, "status": "closed"}');
select pg_temp.expect_denied('статус: в закрытой группе староста не вносит пропуск', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2)$$);
select pg_temp.expect_count('статус: в закрытой группе студент по-прежнему читает', pg_temp.u(3),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 3);
select pg_temp.expect_val('статус: включить группу A', pg_temp.u(7),
  $$public.sysadmin_set_group_status('aaaaaaaa-0000-4000-8000-00000000000a', 'active') ->> 'status'$$, 'active');
select pg_temp.expect_allowed('статус: после включения староста снова вносит пропуск', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2)$$);
select pg_temp.ok('статус: audit_log group_status в обе стороны',
  (select count(*) from public.audit_log where action = 'group_status' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
      and ((details ->> 'from' = 'active' and details ->> 'to' = 'closed') or (details ->> 'from' = 'closed' and details ->> 'to' = 'active'))) = 2);
select pg_temp.expect_err('статус: неизвестный статус → bad_status', pg_temp.u(7),
  $$public.sysadmin_set_group_status('aaaaaaaa-0000-4000-8000-00000000000a', 'archived')$$, 'bad_status');
select pg_temp.expect_err('статус: неизвестная группа → not_found', pg_temp.u(7),
  $$public.sysadmin_set_group_status('dddddddd-0000-4000-8000-00000000000d', 'closed')$$, 'not_found');

-- предметы из расписания
insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject, kind) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2099-02-01', 1, 'Статистика', 'lecture'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2099-02-01', 2, 'Статистика', 'practice'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2099-02-02', 1, 'Маркетинг услуг', 'lecture');
select pg_temp.expect_val('предметы: distinct из расписания по алфавиту', pg_temp.u(7),
  $$array_to_string(public.sysadmin_group_subjects('aaaaaaaa-0000-4000-8000-00000000000a'), '|')$$,
  (select string_agg(distinct subject, '|' order by subject) from public.schedule_lessons where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_val('предметы: группа без расписания → пустой массив', pg_temp.u(7),
  $$public.sysadmin_group_subjects('cccccccc-0000-4000-8000-00000000000c')$$, '{}');

-- ===================================================================================================
-- 7. Одобрение заявки после переноса в _group_create (поведение прежнее)
-- ===================================================================================================
insert into public.registration_requests (id, owner_user_id, status, payload, schedule_status, submitted_at) values
  ('eeeeeeee-0000-4000-8000-00000000000e', pg_temp.u(13), 'submitted',
   '{"group":{"name":"ТЕСТ-ЗАЯВКА","group_no":"ТЕСТ-ЗАЯВКА","faculty":"ФМк","course":3},
     "owner":{"studentIndex":1},
     "students":[{"lastName":"Альфа","firstName":"А"},{"last_name":"Бета","first_name":"Б","study_form":"paid"}]}', 'found', now()),
  ('eeeeeeee-0000-4000-8000-0000000000ef', pg_temp.u(11), 'draft', '{}', null, null);
create temp table ap as
  select case when t like 'ERR:%' then '{}'::jsonb else t::jsonb end as r, t
    from (select pg_temp.sys($$public.sysadmin_approve_registration('eeeeeeee-0000-4000-8000-00000000000e')$$) as t) x;
select pg_temp.ok('одобрение: ответ {group_id, code}',
  (select (select array_agg(k order by k) from jsonb_object_keys(r) k) = '{code,group_id}' and r ->> 'code' ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$' from ap),
  (select t from ap));
select pg_temp.ok('одобрение: группа (course из числа, schedule_status заявки), студенты по порядку',
  (select g.name = 'ТЕСТ-ЗАЯВКА' and g.course = 3 and g.schedule_status = 'found' from public.groups g, ap where g.id = (ap.r ->> 'group_id')::uuid)
  and (select string_agg(s.sort || ':' || s.last_name || ':' || coalesce(s.study_form, '-'), ',' order by s.sort)
         from public.students s, ap where s.group_id = (ap.r ->> 'group_id')::uuid) = '1:Альфа:-,2:Бета:paid');
select pg_temp.ok('одобрение: владелец — староста, привязан к студенту studentIndex 1',
  (select m.status = 'active' and m.extra_role = 'headman' and m.base_role = 'student' and s.last_name = 'Бета'
          and s.claimed_by = pg_temp.u(13) and s.claim_status = 'active'
     from public.memberships m join public.students s on s.id = m.student_id, ap
    where m.user_id = pg_temp.u(13) and m.group_id = (ap.r ->> 'group_id')::uuid));
select pg_temp.ok('одобрение: заявка approved, хэш кода, audit registration_approve',
  (select r.status = 'approved' and r.group_id = (ap.r ->> 'group_id')::uuid and r.reviewed_by = pg_temp.u(7)
     from public.registration_requests r, ap where r.id = 'eeeeeeee-0000-4000-8000-00000000000e')
  and (select i.code_hash = encode(extensions.digest(replace(ap.r ->> 'code', '-', ''), 'sha256'), 'hex')
         from public.group_invites i, ap where i.group_id = (ap.r ->> 'group_id')::uuid)
  and exists (select 1 from public.audit_log a, ap where a.action = 'registration_approve' and a.group_id = (ap.r ->> 'group_id')::uuid
                and a.details ->> 'students' = '2'));
select pg_temp.expect_err('одобрение: повтор → already_approved', pg_temp.u(7),
  $$public.sysadmin_approve_registration('eeeeeeee-0000-4000-8000-00000000000e')$$, 'already_approved');
select pg_temp.expect_err('одобрение: черновик → not_submitted', pg_temp.u(7),
  $$public.sysadmin_approve_registration('eeeeeeee-0000-4000-8000-0000000000ef')$$, 'not_submitted');
select pg_temp.expect_err('одобрение: нет заявки → not_found', pg_temp.u(7),
  $$public.sysadmin_approve_registration('eeeeeeee-0000-4000-8000-0000000000ff')$$, 'not_found');
select pg_temp.expect_err('одобрение: староста → forbidden', pg_temp.u(1),
  $$public.sysadmin_approve_registration('eeeeeeee-0000-4000-8000-0000000000ef')$$, 'forbidden');

-- ===================================================================================================
-- 8. Сисадмины (последним: снимают сисадмина 7)
-- ===================================================================================================
select pg_temp.expect_val('сисадмины: добавить 12', pg_temp.u(7), format('public.sysadmin_add_sysadmin(%L)', pg_temp.u(12)), '{"ok": true, "added": true}');
select pg_temp.expect_val('сисадмины: повтор — без изменений', pg_temp.u(7), format('public.sysadmin_add_sysadmin(%L) ->> %L', pg_temp.u(12), 'added'), 'false');
select pg_temp.expect_err('сисадмины: несуществующий пользователь → user_not_found', pg_temp.u(7),
  $$public.sysadmin_add_sysadmin('dddddddd-0000-4000-8000-00000000000d')$$, 'user_not_found');
select pg_temp.expect_val('сисадмины: список — двое, с почтой', pg_temp.u(12),
  $$(select count(*) || '/' || bool_and(email is not null and created_at is not null) from public.sysadmin_list_sysadmins())$$, '2/true');
select pg_temp.ok('сисадмины: audit sysadmin_add один раз',
  (select count(*) from public.audit_log where action = 'sysadmin_add' and details ->> 'user_id' = pg_temp.u(12)::text) = 1);
select pg_temp.expect_err('сисадмины: снять себя → self', pg_temp.u(7), format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(7)), 'self');
select pg_temp.expect_err('сисадмины: снять не-сисадмина → not_found', pg_temp.u(7), format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(3)), 'not_found');
select pg_temp.expect_val('сисадмины: 12 снимает 7', pg_temp.u(12), format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(7)), '{"ok": true}');
select pg_temp.ok('сисадмины: остался один (12), audit sysadmin_remove',
  (select array_agg(user_id) from public.sysadmins) = array[pg_temp.u(12)]
  and exists (select 1 from public.audit_log where action = 'sysadmin_remove' and actor = pg_temp.u(12) and details ->> 'user_id' = pg_temp.u(7)::text));
select pg_temp.expect_err('сисадмины: последний не снимает себя → self', pg_temp.u(12), format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(12)), 'self');
select pg_temp.expect_err('сисадмины: снятый 7 больше ничего не может', pg_temp.u(7), format('public.sysadmin_remove_sysadmin(%L)', pg_temp.u(12)), 'forbidden');
select pg_temp.expect_err('сисадмины: снятый 7 не возвращает себя', pg_temp.u(7), format('public.sysadmin_add_sysadmin(%L)', pg_temp.u(7)), 'forbidden');
select pg_temp.ok('сисадмины: сисадмин по-прежнему один', (select count(*) from public.sysadmins) = 1);
