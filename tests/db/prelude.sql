-- Общая часть SQL-тестов прав. Выполняется в одной транзакции, которую раннер откатывает (raise exception в конце).
-- Фикстуры строятся на 28 тестовых аккаунтах Auth (student01…28). Результаты складываются в pg_temp.res.
create temp table res (name text, ok boolean, detail text);
grant all on res to public;

-- n-й тестовый пользователь по email
create function pg_temp.u(n int) returns uuid language sql as
$$ select id from auth.users order by email offset n - 1 limit 1 $$;

create function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
end $$;

create function pg_temp.as_anon() returns void language plpgsql as $$
begin
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;

-- сколько строк видит пользователь по запросу (null, если запрос упал)
create function pg_temp.count_as(u uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.as_user(u);
  begin execute 'select count(*) from (' || q || ') t' into n;
  exception when others then n := null; end;
  execute 'reset role';
  return n;
end $$;

create function pg_temp.expect_count(t text, u uuid, q text, want bigint) returns void language plpgsql as $$
declare got bigint;
begin
  got := pg_temp.count_as(u, q);
  insert into res values (t, got = want, 'ожидалось ' || want || ', получено ' || coalesce(got::text, 'ошибка'));
end $$;

-- «не меньше»
create function pg_temp.expect_min(t text, u uuid, q text, want bigint) returns void language plpgsql as $$
declare got bigint;
begin
  got := pg_temp.count_as(u, q);
  insert into res values (t, coalesce(got, -1) >= want, 'ожидалось ≥ ' || want || ', получено ' || coalesce(got::text, 'ошибка'));
end $$;

-- запись должна быть отклонена (ошибка или 0 затронутых строк)
create function pg_temp.expect_denied(t text, u uuid, stmt text) returns void language plpgsql as $$
declare n bigint; denied boolean := false;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; get diagnostics n = row_count; denied := (n = 0);
  exception when others then denied := true; end;
  execute 'reset role';
  insert into res values (t, denied, case when denied then 'отказ' else 'запись прошла' end);
end $$;

-- запись должна пройти
create function pg_temp.expect_allowed(t text, u uuid, stmt text) returns void language plpgsql as $$
declare n bigint; ok boolean := false; err text;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; get diagnostics n = row_count; ok := (n > 0);
  exception when others then ok := false; err := sqlerrm; end;
  execute 'reset role';
  insert into res values (t, ok, coalesce(err, 'строк: ' || n));
end $$;

-- вызов функции (select ...) под пользователем: должен пройти без ошибки
create function pg_temp.expect_call_ok(t text, u uuid, stmt text) returns void language plpgsql as $$
declare ok boolean := false; err text;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; ok := true; exception when others then err := sqlerrm; end;
  execute 'reset role';
  insert into res values (t, ok, coalesce(err, 'ok'));
end $$;

-- вызов функции под пользователем: должен упасть
create function pg_temp.expect_call_fail(t text, u uuid, stmt text) returns void language plpgsql as $$
declare failed boolean := false; err text;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; exception when others then failed := true; err := sqlerrm; end;
  execute 'reset role';
  insert into res values (t, failed, coalesce(err, 'ошибки не было'));
end $$;

-- запрос под владельцем, который должен упасть от ограничения
create function pg_temp.expect_error(t text, stmt text) returns void language plpgsql as $$
declare failed boolean := false; err text;
begin
  begin execute stmt; exception when others then failed := true; err := sqlerrm; end;
  insert into res values (t, failed, coalesce(err, 'ошибки не было'));
end $$;

-- ===== фикстуры =====
-- 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A, 6 препод ПЗ A, 7 сисадмин,
-- 8 староста B, 9 студент B, 10 студент легаси-группы 24ДММ-2, 11 пользователь без групп
alter table public.app_events disable trigger user;
alter table public.student_achievements disable trigger user;
alter table public.game_records disable trigger user;
alter table public.tasks disable trigger user;

insert into public.groups (id, name, group_no, course, status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'ТЕСТ-1', 'ТЕСТ-1', 2, 'active'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'ТЕСТ-2', 'ТЕСТ-2', 2, 'active')
  on conflict do nothing;
insert into public.groups (id, name) values ('00000000-0000-4000-8000-000000000024', '24ДММ-2') on conflict do nothing;

insert into public.students (id, group_id, last_name, first_name, claim_status, claimed_by) values
  ('t-a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Тестов', 'Староста', 'active', pg_temp.u(1)),
  ('t-a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Тестов', 'Зам', 'active', pg_temp.u(2)),
  ('t-a3', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Тестов', 'Студент', 'active', pg_temp.u(3)),
  ('t-a4', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Тестов', 'Ожидающий', 'pending', pg_temp.u(4)),
  ('t-a5', 'aaaaaaaa-0000-4000-8000-00000000000a', 'Тестов', 'Свободный', 'free', null),
  ('t-b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Другов', 'Староста', 'active', pg_temp.u(8)),
  ('t-b2', 'bbbbbbbb-0000-4000-8000-00000000000b', 'Другов', 'Студент', 'active', pg_temp.u(9)),
  ('t-l1', '00000000-0000-4000-8000-000000000024', 'Легаси', 'Студент', 'active', pg_temp.u(10));

insert into public.memberships (user_id, group_id, student_id, base_role, extra_role, status) values
  (pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a1', 'student', 'headman', 'active'),
  (pg_temp.u(2), 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', 'student', 'deputy', 'active'),
  (pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'student', null, 'active'),
  (pg_temp.u(4), 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a4', 'student', null, 'pending'),
  (pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', null, 'teacher_lecture', null, 'active'),
  (pg_temp.u(6), 'aaaaaaaa-0000-4000-8000-00000000000a', null, 'teacher_practice', null, 'active'),
  (pg_temp.u(8), 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b1', 'student', 'headman', 'active'),
  (pg_temp.u(9), 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', 'student', null, 'active'),
  (pg_temp.u(10), '00000000-0000-4000-8000-000000000024', 't-l1', 'student', null, 'active');
insert into public.sysadmins (user_id) values (pg_temp.u(7));
insert into public.teacher_assignments (user_id, group_id, subject, lesson_kind) values
  (pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', 'Маркетинг услуг', 'lecture'),
  (pg_temp.u(6), 'aaaaaaaa-0000-4000-8000-00000000000a', 'Маркетинг услуг', 'practice');

insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by) values
  ('abs-a1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-03', 'Маркетинг услуг', 2, 'lecture', pg_temp.u(1)),
  ('abs-a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-03', 'Маркетинг услуг', 2, 'practice', pg_temp.u(1)),
  ('abs-a3', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-04', 'Статистика', 2, 'lecture', pg_temp.u(2)),
  ('abs-b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', '2026-11-03', 'Логистика', 2, 'lecture', pg_temp.u(8));
insert into public.tasks (id, kind, rec, group_id) values
  ('tk-a1', 'homework', '{"subject":"Статистика"}', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('tk-b1', 'homework', '{"subject":"Логистика"}', 'bbbbbbbb-0000-4000-8000-00000000000b');
insert into public.app_events (user_id, student_id, kind, ref, group_id) values
  (pg_temp.u(3), 't-a3', 'test', 'a', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  (pg_temp.u(9), 't-b2', 'test', 'b', 'bbbbbbbb-0000-4000-8000-00000000000b'),
  (pg_temp.u(10), 't-l1', 'test', 'l', '00000000-0000-4000-8000-000000000024');
insert into public.student_achievements (student_id, code, period, semester, group_id) values
  ('t-a3', 'test_a', 'p', 's', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('t-b2', 'test_b', 'p', 's', 'bbbbbbbb-0000-4000-8000-00000000000b');
insert into public.game_records (student_id, game, difficulty, score, proof, group_id) values
  ('t-a3', 'test', 'e', 1, '{}', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('t-b2', 'test', 'e', 1, '{}', 'bbbbbbbb-0000-4000-8000-00000000000b');
insert into public.study_days (day, semester, group_id) values
  ('2099-01-01', 'test', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('2099-01-02', 'test', 'bbbbbbbb-0000-4000-8000-00000000000b');
