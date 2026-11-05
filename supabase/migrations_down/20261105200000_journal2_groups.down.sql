-- Откат 20261105200000_journal2_groups.sql: БД возвращается к состоянию после 20261103130000.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
-- ВНИМАНИЕ: удаляет новые таблицы вместе с данными (группы, студенты, пропуски, членства, заявки, журнал)
-- и строки старых таблиц, принадлежащие другим группам (их group_id исчезает). Данные 24ДММ-2 в
-- journal_private, profiles, app_events, student_achievements, game_records, tasks, study_days остаются.
begin;

-- 1. Прежние политики существующих таблиц (тексты из 20261006010000, 20261011120000, 20261026120000,
--    20261031190000, 20261101120000, 20261103120000, 20260927153351)
drop policy if exists "Студент группы читает журнал" on public.journal_private;
create policy "Студент группы читает журнал" on public.journal_private
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid())));

drop policy if exists "Свои события видны" on public.app_events;
create policy "Свои события видны" on public.app_events
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Свои события добавляются" on public.app_events;
create policy "Свои события добавляются" on public.app_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "Отметку о домашке можно снять" on public.app_events;
create policy "Отметку о домашке можно снять" on public.app_events
  for delete to authenticated
  using (user_id = (select auth.uid()) and kind in ('homework_done', 'deadline_done'));

drop policy if exists "Свои значки видны" on public.student_achievements;
create policy "Свои значки видны" on public.student_achievements
  for select to authenticated
  using (student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid())));
drop policy if exists "Свои значки добавляются" on public.student_achievements;
create policy "Свои значки добавляются" on public.student_achievements
  for insert to authenticated
  with check (
    student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid()))
    and code not like 'game\_%'
    and code <> all (public.attendance_badge_codes())
  );

drop policy if exists "Рекорды видны вошедшим" on public.game_records;
create policy "Рекорды видны вошедшим" on public.game_records
  for select to authenticated using (true);

drop policy if exists "Учебные дни читают вошедшие" on public.study_days;
create policy "Учебные дни читают вошедшие" on public.study_days
  for select to authenticated using (true);

drop policy if exists "Итоги дней видят вошедшие" on public.assoc_daily_results;
create policy "Итоги дней видят вошедшие" on public.assoc_daily_results
  for select to authenticated using (true);

drop policy if exists "Задания: чтение" on public.tasks;
drop policy if exists "Задания: внесение" on public.tasks;
drop policy if exists "Задания: изменение" on public.tasks;
drop policy if exists "Задания: удаление" on public.tasks;
revoke all on public.tasks from anon, authenticated;

drop policy if exists "Аватарки видят вошедшие" on storage.objects;
create policy "Аватарки видят вошедшие" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

-- 2. Прежние функции (тексты из 20261103130000)
create or replace function public.is_journal_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
      join public.journal_private j on j.id = 'main'
      cross join lateral jsonb_array_elements(j.students) s
     where p.user_id = (select auth.uid())
       and s ->> 'id' = p.student_id
       and s ->> 'isAdmin' = 'true'
  );
$$;

create or replace function public.app_open()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select (value ->> 'on')::boolean from public.app_settings where key = 'maintenance'), false) is not true
      or public.is_journal_admin();
$$;

create or replace function public.rpc_ach_board(exclude_codes text[] default '{}')
returns table (student_id text, badges integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, count(*)::integer as badges
    from public.student_achievements sa
   where not (sa.code = any (coalesce(exclude_codes, '{}')))
     and public.app_open()
   group by sa.student_id
   order by badges desc, sa.student_id;
$$;

create or replace function public.rpc_game_points(codes text[], points integer[])
returns table (student_id text, points integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, sum(w.points)::integer as points
    from public.student_achievements sa
    join unnest(codes, points) as w(code, points) on w.code = sa.code
   where public.app_open()
   group by sa.student_id
   order by points desc, sa.student_id;
$$;

create or replace function public.rpc_assoc_board(p_day date default null)
returns table (student_id text, points integer, days integer, tries integer)
language sql
security definer
set search_path = public
stable
as $$
  select wa.student_id,
         sum(wa.points)::integer as points,
         count(*) filter (where wa.solved)::integer as days,
         sum(wa.tries)::integer as tries
    from public.word_attempts wa
   where wa.mode = 'ranks'
     and wa.day >= date_trunc('month', coalesce(p_day, current_date))::date
     and wa.day <  (date_trunc('month', coalesce(p_day, current_date)) + interval '1 month')::date
     and public.app_open()
   group by wa.student_id
  having sum(wa.points) > 0
   order by points desc, tries asc, days desc, wa.student_id;
$$;

create or replace function public.rpc_assoc_day_board(p_day date default null)
returns table (student_id text, place integer, points integer, tries integer, finished_at timestamptz, bonus integer)
language sql
security definer
set search_path = public
stable
as $$
  with d as (select coalesce(p_day, (now() at time zone 'Europe/Minsk')::date) as day),
  ranked as (
    select wa.student_id, wa.points, wa.tries, wa.updated_at as finished_at,
           row_number() over (order by wa.points desc, wa.updated_at asc, wa.student_id asc)::integer as place
      from public.word_attempts wa, d
     where wa.day = d.day and wa.mode = 'ranks' and wa.solved and wa.points > 0
       and public.app_open()
  )
  select r.student_id, r.place, r.points, r.tries, r.finished_at,
         coalesce(res.bonus, s.bonus, 0) as bonus
    from ranked r
    cross join d
    left join public.assoc_daily_results res on res.day = d.day and res.student_id = r.student_id
    left join public.assoc_settings s on s.place = r.place
   order by r.place;
$$;

create or replace function public.rpc_assoc_total_board()
returns table (student_id text, bonus integer, wins integer, days integer)
language sql
security definer
set search_path = public
stable
as $$
  select r.student_id,
         sum(r.bonus)::integer as bonus,
         count(*) filter (where r.place = 1)::integer as wins,
         count(*)::integer as days
    from public.assoc_daily_results r
   where public.app_open()
   group by r.student_id
  having sum(r.bonus) > 0
   order by bonus desc, wins desc, count(*) filter (where r.place = 2) desc, days desc, r.student_id;
$$;

-- 3. Колонки group_id и прежний ключ study_days. Строки других групп удаляются: без group_id они
--    смешались бы с 24ДММ-2 (а у study_days нарушили бы прежний ключ (day)).
drop trigger if exists profiles_legacy_sync on public.profiles;
delete from public.app_events where group_id <> '00000000-0000-4000-8000-000000000024';
delete from public.student_achievements where group_id <> '00000000-0000-4000-8000-000000000024';
delete from public.game_records where group_id <> '00000000-0000-4000-8000-000000000024';
delete from public.tasks where group_id <> '00000000-0000-4000-8000-000000000024';
delete from public.study_days where group_id <> '00000000-0000-4000-8000-000000000024';
alter table public.study_days drop constraint study_days_pkey;
alter table public.study_days drop column group_id;
alter table public.study_days add primary key (day);
alter table public.app_events drop column group_id;
alter table public.student_achievements drop column group_id;
alter table public.game_records drop column group_id;
alter table public.tasks drop column group_id, drop column created_by;

-- 4. Новые таблицы (их политики и триггеры уходят вместе с ними)
drop table public.remind_log, public.audit_log, public.consents, public.join_attempts,
           public.registration_requests, public.absences, public.teacher_assignments,
           public.memberships, public.sysadmins, public.students, public.group_invites, public.groups;

-- 5. Новые функции (без cascade: если что-то на них ещё ссылается, откат упадёт, а не удалит молча)
drop function public.profiles_legacy_sync();
drop function public.absences_guard();
drop function public.sysadmin_bootstrap(uuid);
drop function public.journal2_import_legacy();
drop function public.sysadmin_set_thresholds(uuid, int, int);
drop function public.sysadmin_set_group_role(uuid, uuid, text);
drop function public.group_code_rotate(uuid);
drop function public.sysadmin_reject_registration(uuid, text);
drop function public.sysadmin_approve_registration(uuid);
drop function public.registration_submit(uuid);
drop function public.consent_accept(uuid, text, text);
drop function public.remind_headman();
drop function public.student_reset_binding(text);
drop function public.membership_reject(text);
drop function public.membership_approve(text);
drop function public._try_date(text);
drop function public._release_binding(text, text);
drop function public._group_code_set(uuid);
drop function public.group_open(uuid);
drop function public.can_see_user(text);
drop function public.user_is_staff(uuid, uuid);
drop function public.my_student_id(uuid);
drop function public.teaches(uuid, text, text);
drop function public.is_group_reader(uuid);
drop function public.is_group_staff(uuid);
drop function public.has_group_role(uuid, text[]);
drop function public.my_active_groups();
drop function public.is_sysadmin();

-- 6. Запись о миграции: иначе db push не применит её повторно
delete from supabase_migrations.schema_migrations where version = '20261105200000';

commit;
