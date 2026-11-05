-- Журнал 2.0, этап 1: группы, роли, членства, RLS по группам, RPC регистрации и подтверждения.
--
-- Миграция аддитивная: старые таблицы (journal_private, profiles, …) и старые вызовы клиента остаются.
-- Политики «есть строка в profiles → читай» заменены на «active-член группы строки»; для 28 действующих
-- аккаунтов 24ДММ-2 поведение прежнее, потому что в конце миграции вызывается импорт легаси-данных
-- (journal2_import_legacy), который выдаёт им active-членство в группе 24ДММ-2.
-- Подробно (матрица прав, список изменённых политик, риски, чек-лист деплоя): docs/stage1-db.md.
-- Откат: supabase/migrations_down/20261105200000_journal2_groups.down.sql.
--
-- Фиксированный id группы переезда 24ДММ-2: 00000000-0000-4000-8000-000000000024 (дальше «G24»).

-- ===================================================================================================
-- 1. Таблицы
-- ===================================================================================================

create table public.groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  faculty         text,
  study_form      text,
  course          int,
  group_no        text,
  university      text default 'БГЭУ',
  status          text not null default 'active' check (status in ('active', 'closed', 'graduated')),
  warn_hours      int not null default 8,
  dean_hours      int not null default 12,
  semester_end    date,
  bseu_faculty_id text,
  bseu_form_id    text,
  bseu_group_id   text,
  schedule_status text,
  graduated_at    timestamptz,
  created_at      timestamptz default now()
);

-- Группа переезда должна существовать до того, как на неё сошлются колонки group_id и политики
insert into public.groups (id, name, faculty, study_form, course, group_no, bseu_faculty_id, bseu_form_id, bseu_group_id)
values ('00000000-0000-4000-8000-000000000024', '24ДММ-2', 'ФМк', 'Дневная', 3, '24ДММ-2', '13', '10', '9457')
on conflict do nothing;

-- Код группы: в базе только sha-256 (hex) от кода без дефиса в верхнем регистре
create table public.group_invites (
  group_id   uuid primary key references public.groups (id) on delete cascade,
  code_hash  text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table public.students (
  id          text primary key default ('st-' || replace(gen_random_uuid()::text, '-', '')),
  group_id    uuid not null references public.groups (id),
  last_name   text,
  first_name  text,
  study_form  text check (study_form in ('budget', 'paid')),
  subgroup    text,
  claimed_by  uuid unique references auth.users (id) on delete set null,
  claim_status text not null default 'free' check (claim_status in ('free', 'pending', 'active')),
  claimed_at  timestamptz,
  telegram    jsonb,
  sort        int,
  created_at  timestamptz not null default now(),
  unique (id, group_id)                       -- цель составных FK: студент принадлежит группе строки
);
create unique index students_fio_unique
  on public.students (group_id, lower(btrim(last_name)), lower(btrim(first_name)));
create index students_group_idx on public.students (group_id, sort);

create table public.sysadmins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.memberships (
  user_id         uuid not null references auth.users (id) on delete cascade,
  group_id        uuid not null references public.groups (id),
  student_id      text,
  base_role       text not null check (base_role in ('student', 'teacher_lecture', 'teacher_practice')),
  extra_role      text check (extra_role in ('headman', 'deputy')),
  status          text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'removed')),
  consent_at      timestamptz,
  consent_version text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, group_id),
  foreign key (student_id, group_id) references public.students (id, group_id),
  check (extra_role is null or base_role = 'student')       -- староста/заместитель = студент с доп. ролью
);
create unique index memberships_one_headman on public.memberships (group_id)
  where status = 'active' and extra_role = 'headman';
create unique index memberships_one_deputy on public.memberships (group_id)
  where status = 'active' and extra_role = 'deputy';
create index memberships_group_idx on public.memberships (group_id, status);

create table public.teacher_assignments (
  user_id     uuid not null references auth.users (id) on delete cascade,
  group_id    uuid not null references public.groups (id),
  subject     text not null,
  lesson_kind text not null check (lesson_kind in ('lecture', 'practice')),
  primary key (user_id, group_id, subject, lesson_kind)
);

create table public.absences (
  id             text primary key default ('ab-' || replace(gen_random_uuid()::text, '-', '')),
  group_id       uuid not null references public.groups (id),
  student_id     text not null,
  date           date,
  subject        text,
  hours          numeric,
  is_excused     boolean not null default false,
  cert_type      text,
  cert_submitted boolean not null default false,
  cert_due_date  date,
  comment        text,
  created_by     uuid default auth.uid(),
  lesson_kind    text check (lesson_kind in ('lecture', 'practice')),
  created_at     timestamptz not null default now(),
  foreign key (student_id, group_id) references public.students (id, group_id)
);
create index absences_group_idx on public.absences (group_id, date);
create index absences_student_idx on public.absences (student_id);

create table public.registration_requests (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status          text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  step            int default 1,
  payload         jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  schedule_status text,
  group_id        uuid references public.groups (id),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  reject_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  submitted_at    timestamptz
);
-- Одна открытая заявка (черновик или на рассмотрении) на владельца
create unique index registration_requests_one_open on public.registration_requests (owner_user_id)
  where status in ('draft', 'submitted');

create table public.join_attempts (
  id        bigint generated always as identity primary key,
  ip_hash   text not null,
  group_key text,
  ok        boolean not null default false,
  at        timestamptz not null default now()
);
create index join_attempts_ip_at_idx on public.join_attempts (ip_hash, at);

create table public.consents (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  group_id    uuid references public.groups (id),
  version     text not null,
  text_hash   text,
  accepted_at timestamptz not null default now()
);
create index consents_user_idx on public.consents (user_id);

create table public.audit_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  actor    uuid,
  group_id uuid,
  action   text not null,
  details  jsonb not null default '{}'::jsonb
);
create index audit_log_group_at_idx on public.audit_log (group_id, at desc);
create index audit_log_action_at_idx on public.audit_log (action, at desc);

create table public.remind_log (
  group_id   uuid not null references public.groups (id),
  student_id text not null,
  last_at    timestamptz not null,
  primary key (group_id, student_id)
);

-- Все новые таблицы: RLS включён, права клиентов сняты; ниже точечные grant + политики
do $$
declare t text;
begin
  foreach t in array array['groups', 'group_invites', 'students', 'sysadmins', 'memberships', 'teacher_assignments',
                           'absences', 'registration_requests', 'join_attempts', 'consents', 'audit_log', 'remind_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ===================================================================================================
-- 2. group_id в существующих таблицах данных
-- ===================================================================================================
-- default = G24: все старые писатели (клиент 1.x, Edge Functions, seed) пишут только за 24ДММ-2 и про
-- group_id не знают. Колонка сразу not null: default с константой заполняет старые строки без перезаписи
-- таблицы. ponytail: default — легаси-допущение, убрать на этапе 2, когда писатели начнут передавать group_id.
alter table public.app_events
  add column group_id uuid not null default '00000000-0000-4000-8000-000000000024' references public.groups (id);
alter table public.student_achievements
  add column group_id uuid not null default '00000000-0000-4000-8000-000000000024' references public.groups (id);
alter table public.game_records
  add column group_id uuid not null default '00000000-0000-4000-8000-000000000024' references public.groups (id);
alter table public.tasks
  add column group_id uuid not null default '00000000-0000-4000-8000-000000000024' references public.groups (id),
  add column created_by uuid default auth.uid();
alter table public.study_days
  add column group_id uuid not null default '00000000-0000-4000-8000-000000000024' references public.groups (id);
-- Учебные дни у каждой группы свои: ключ (group_id, day)
alter table public.study_days drop constraint study_days_pkey;
alter table public.study_days add primary key (group_id, day);

create index app_events_group_idx on public.app_events (group_id);
create index student_achievements_group_idx on public.student_achievements (group_id);
create index game_records_group_idx on public.game_records (group_id);
create index tasks_group_idx on public.tasks (group_id);

-- ===================================================================================================
-- 3. Хелперы RLS (security definer: читают memberships в обход RLS, поэтому рекурсии в политиках нет)
-- ===================================================================================================

create function public.is_sysadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sysadmins s where s.user_id = (select auth.uid()));
$$;

create function public.my_active_groups()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.group_id from public.memberships m where m.user_id = (select auth.uid()) and m.status = 'active';
$$;

-- roles: 'student','headman','deputy','teacher_lecture','teacher_practice'; sysadmin проходит всегда
create function public.has_group_role(g uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_sysadmin() or exists (
    select 1 from public.memberships m
     where m.user_id = (select auth.uid()) and m.group_id = g and m.status = 'active'
       and (m.base_role = any (roles) or m.extra_role = any (roles)));
$$;

create function public.is_group_staff(g uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_group_role(g, array['headman', 'deputy']);
$$;

-- Читатель данных группы «как студент»: active-студент (в т. ч. староста/заместитель) или сисадмин.
-- Преподаватели сюда не входят: им — только свои дисциплины (teaches).
create function public.is_group_reader(g uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_group_role(g, array['student']);
$$;

-- Преподаватель (active-членство teacher_*) с назначением в группе g. null в p_subject/p_kind = любой.
create function public.teaches(g uuid, p_subject text, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.teacher_assignments ta
      join public.memberships m on m.user_id = ta.user_id and m.group_id = ta.group_id
                               and m.status = 'active' and m.base_role = 'teacher_' || ta.lesson_kind
     where ta.user_id = (select auth.uid()) and ta.group_id = g
       and (p_subject is null or ta.subject = p_subject)
       and (p_kind is null or ta.lesson_kind = p_kind));
$$;

-- student_id вызывающего в группе g (только active-студент); иначе null
create function public.my_student_id(g uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.student_id from public.memberships m
   where m.user_id = (select auth.uid()) and m.group_id = g and m.status = 'active' and m.base_role = 'student';
$$;

-- Является ли u старостой/заместителем группы g (для «преподаватель отменяет записи старосты»).
-- Ответ только для участника группы, чтобы не служить справочником ролей чужих групп.
create function public.user_is_staff(g uuid, u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_group_role(g, array['student', 'teacher_lecture', 'teacher_practice'])
     and exists (select 1 from public.memberships m
                  where m.user_id = u and m.group_id = g and m.status = 'active' and m.extra_role in ('headman', 'deputy'));
$$;

-- Видна ли вызывающему аватарка пользователя p_user (uuid текстом): своя, общая active-группа или сисадмин
create function public.can_see_user(p_user text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user = (select auth.uid())::text
      or public.is_sysadmin()
      or exists (select 1 from public.memberships a
                   join public.memberships b on b.group_id = a.group_id and b.status = 'active'
                  where a.user_id = (select auth.uid()) and a.status = 'active' and b.user_id::text = p_user);
$$;

-- Журнал группы открыт для записи: группа active и (техработы выключены или вызывающий — староста/сисадмин)
create function public.group_open(g uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.groups gr where gr.id = g and gr.status = 'active')
     and (coalesce((select (s.value ->> 'on')::boolean from public.app_settings s where s.key = 'maintenance'), false) is not true
          or public.is_group_staff(g));
$$;

do $$
declare f text;
begin
  foreach f in array array['is_sysadmin()', 'my_active_groups()', 'has_group_role(uuid, text[])', 'is_group_staff(uuid)',
                           'is_group_reader(uuid)', 'teaches(uuid, text, text)', 'my_student_id(uuid)',
                           'user_is_staff(uuid, uuid)', 'can_see_user(text)', 'group_open(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===== Староста для режима техработ: теперь по членству, а не по isAdmin в jsonb =====
-- Сигнатуры и права прежние (anon, authenticated), maintenance_status()/set_maintenance() не меняются.
create or replace function public.is_journal_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select public.is_sysadmin() or exists (
    select 1 from public.memberships m
     where m.user_id = (select auth.uid())
       and m.group_id = '00000000-0000-4000-8000-000000000024'
       and m.status = 'active'
       and m.extra_role in ('headman', 'deputy'));
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

-- ===================================================================================================
-- 4. Политики новых таблиц
-- ===================================================================================================

grant select on public.groups to authenticated;
create policy "Группа видна участникам" on public.groups for select to authenticated
  using (id in (select public.my_active_groups()) or (select public.is_sysadmin()));

grant select on public.students to authenticated;
create policy "Студенты группы" on public.students for select to authenticated
  using (public.is_group_reader(group_id)
         or public.teaches(group_id, null, null)
         or claimed_by = (select auth.uid()));          -- pending видит только свою запись

grant select on public.sysadmins to authenticated;
create policy "Сисадмины" on public.sysadmins for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_sysadmin()));

grant select on public.memberships to authenticated;
create policy "Членства" on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.is_group_staff(group_id));

grant select on public.teacher_assignments to authenticated;
create policy "Назначения преподавателей" on public.teacher_assignments for select to authenticated
  using (user_id = (select auth.uid()) or group_id in (select public.my_active_groups()) or (select public.is_sysadmin()));

grant select, insert, update, delete on public.absences to authenticated;
create policy "Пропуски: чтение" on public.absences for select to authenticated
  using (public.is_group_reader(group_id)
         or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)));
create policy "Пропуски: внесение" on public.absences for insert to authenticated
  with check (created_by = (select auth.uid())
              and public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
create policy "Пропуски: изменение" on public.absences for update to authenticated
  using (public.is_group_staff(group_id)
         or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)))
  with check (public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
-- Староста отменяет свои и легаси-записи (created_by null — внесены старостой до переезда);
-- преподаватель — свои и старосты/заместителя, только по своей дисциплине и виду занятий.
create policy "Пропуски: отмена" on public.absences for delete to authenticated
  using (public.group_open(group_id)
         and ((public.is_group_staff(group_id) and (created_by = (select auth.uid()) or created_by is null))
              or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)
                  and (created_by = (select auth.uid()) or public.user_is_staff(group_id, created_by)))));

-- Какие поля можно менять, RLS не выражает: это делает триггер (только для клиентских ролей)
create function public.absences_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if current_user not in ('authenticated', 'anon') then
    return new;                                   -- service_role и владелец: без ограничений
  end if;
  if new.id is distinct from old.id or new.group_id is distinct from old.group_id
     or new.student_id is distinct from old.student_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'absences: поле нельзя менять' using errcode = '42501';
  end if;
  if old.created_by = v_uid then
    return new;                                   -- своя запись: любые поля (вид/дисциплину держит with check)
  end if;
  if public.is_group_staff(old.group_id) then
    if old.created_by is null then
      return new;                                 -- легаси-запись группы
    end if;
    -- запись преподавателя: только справка и комментарий; уважительность — только вместе со сданной справкой
    if (new.date, new.subject, new.hours, new.lesson_kind) is distinct from (old.date, old.subject, old.hours, old.lesson_kind)
       or (new.is_excused is distinct from old.is_excused and not new.cert_submitted) then
      raise exception 'absences: староста меняет в чужой записи только справку' using errcode = '42501';
    end if;
    return new;
  end if;
  -- преподаватель в чужой записи своей дисциплины: только «уважительный»
  if (new.date, new.subject, new.hours, new.lesson_kind, new.cert_type, new.cert_submitted, new.cert_due_date, new.comment)
     is distinct from
     (old.date, old.subject, old.hours, old.lesson_kind, old.cert_type, old.cert_submitted, old.cert_due_date, old.comment) then
    raise exception 'absences: преподаватель меняет только уважительность' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.absences_guard() from public, anon, authenticated;
create trigger absences_guard before update on public.absences
  for each row execute function public.absences_guard();

-- Черновик заявки старосты: владелец создаёт и правит, пока status = 'draft'; отправка — registration_submit()
grant select, delete on public.registration_requests to authenticated;
grant insert (payload, step, schedule_status) on public.registration_requests to authenticated;
grant update (payload, step, schedule_status) on public.registration_requests to authenticated;
create policy "Заявка: чтение" on public.registration_requests for select to authenticated
  using (owner_user_id = (select auth.uid()) or (select public.is_sysadmin()));
create policy "Заявка: создание" on public.registration_requests for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and status = 'draft');
create policy "Заявка: правка черновика" on public.registration_requests for update to authenticated
  using (owner_user_id = (select auth.uid()) and status = 'draft')
  with check (owner_user_id = (select auth.uid()) and status = 'draft');
create policy "Заявка: удаление черновика" on public.registration_requests for delete to authenticated
  using (owner_user_id = (select auth.uid()) and status = 'draft');

grant select on public.consents to authenticated;
create policy "Свои согласия" on public.consents for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.audit_log to authenticated;
create policy "Журнал действий" on public.audit_log for select to authenticated
  using ((select public.is_sysadmin()) or (group_id is not null and public.is_group_staff(group_id)));

-- group_invites, join_attempts, remind_log: политик нет — только service_role и security definer RPC.

-- ===================================================================================================
-- 5. Замена политик существующих таблиц (было: «есть строка в profiles» / «все вошедшие»)
-- ===================================================================================================

-- journal_private без group_id: легаси-таблица 24ДММ-2 → active-студент G24 или сисадмин
drop policy "Студент группы читает журнал" on public.journal_private;
create policy "Студент группы читает журнал" on public.journal_private for select to authenticated
  using ((select public.is_group_reader('00000000-0000-4000-8000-000000000024')));

drop policy "Свои события видны" on public.app_events;
create policy "Свои события видны" on public.app_events for select to authenticated
  using (user_id = (select auth.uid()) and student_id = public.my_student_id(group_id));
drop policy "Свои события добавляются" on public.app_events;
create policy "Свои события добавляются" on public.app_events for insert to authenticated
  with check (user_id = (select auth.uid()) and student_id = public.my_student_id(group_id) and public.group_open(group_id));
drop policy "Отметку о домашке можно снять" on public.app_events;
create policy "Отметку о домашке можно снять" on public.app_events for delete to authenticated
  using (user_id = (select auth.uid()) and kind in ('homework_done', 'deadline_done')
         and student_id = public.my_student_id(group_id) and public.group_open(group_id));

drop policy "Свои значки видны" on public.student_achievements;
create policy "Свои значки видны" on public.student_achievements for select to authenticated
  using (student_id = public.my_student_id(group_id));
drop policy "Свои значки добавляются" on public.student_achievements;
create policy "Свои значки добавляются" on public.student_achievements for insert to authenticated
  with check (student_id = public.my_student_id(group_id)
              and public.group_open(group_id)
              and code not like 'game\_%'
              and code <> all (public.attendance_badge_codes()));

drop policy "Рекорды видны вошедшим" on public.game_records;
create policy "Рекорды видны вошедшим" on public.game_records for select to authenticated
  using (public.is_group_reader(group_id));

drop policy "Учебные дни читают вошедшие" on public.study_days;
create policy "Учебные дни читают вошедшие" on public.study_days for select to authenticated
  using (group_id in (select public.my_active_groups()) or (select public.is_sysadmin()));

-- assoc_daily_results без group_id: легаси 24ДММ-2 (assoc_settings — настройки без личных данных, не трогаем)
drop policy "Итоги дней видят вошедшие" on public.assoc_daily_results;
create policy "Итоги дней видят вошедшие" on public.assoc_daily_results for select to authenticated
  using ((select public.is_group_reader('00000000-0000-4000-8000-000000000024')));

-- tasks: раньше клиенту закрыта полностью (только Edge Functions). Теперь чтение группе по RLS,
-- запись — староста/заместитель своей группы; менять/удалять — свои и легаси (created_by null).
grant select, insert, update, delete on public.tasks to authenticated;
create policy "Задания: чтение" on public.tasks for select to authenticated
  using (public.is_group_reader(group_id) or public.teaches(group_id, rec ->> 'subject', null));
create policy "Задания: внесение" on public.tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and public.is_group_staff(group_id) and public.group_open(group_id));
create policy "Задания: изменение" on public.tasks for update to authenticated
  using (public.is_group_staff(group_id) and (created_by = (select auth.uid()) or created_by is null))
  with check (public.is_group_staff(group_id) and public.group_open(group_id)
              and (created_by = (select auth.uid()) or created_by is null));
create policy "Задания: удаление" on public.tasks for delete to authenticated
  using (public.is_group_staff(group_id) and public.group_open(group_id)
         and (created_by = (select auth.uid()) or created_by is null));

-- Аватарки: было «видят все вошедшие» → своя, участники общей группы, сисадмин
drop policy "Аватарки видят вошедшие" on storage.objects;
create policy "Аватарки видят вошедшие" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and public.can_see_user(split_part(name, '.', 1)));

-- ===== Рейтинги (security definer, обходят RLS): ограничены группой =====
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
     and public.is_group_reader(sa.group_id)
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
     and public.is_group_reader(sa.group_id)
   group by sa.student_id
   order by points desc, sa.student_id;
$$;

-- word_attempts / assoc_daily_results без group_id: легаси 24ДММ-2
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
     and (select public.is_group_reader('00000000-0000-4000-8000-000000000024'))
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
       and (select public.is_group_reader('00000000-0000-4000-8000-000000000024'))
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
     and (select public.is_group_reader('00000000-0000-4000-8000-000000000024'))
   group by r.student_id
  having sum(r.bonus) > 0
   order by bonus desc, wins desc, count(*) filter (where r.place = 2) desc, days desc, r.student_id;
$$;

-- ===================================================================================================
-- 6. RPC
-- ===================================================================================================

-- Внутреннее: новый 8-символьный код группы (без 0/O/1/I/L), в базе — только хэш. Возвращает «ABCD-EFGH».
create function public._group_code_set(p_group uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw text;
  b bytea;
  i int;
  attempt int;
begin
  for attempt in 1..5 loop
    raw := '';
    b := extensions.gen_random_bytes(8);
    for i in 0..7 loop
      raw := raw || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
    end loop;
    begin
      insert into public.group_invites (group_id, code_hash)
        values (p_group, encode(extensions.digest(raw, 'sha256'), 'hex'))
      on conflict (group_id) do update set code_hash = excluded.code_hash, rotated_at = now();
      return substr(raw, 1, 4) || '-' || substr(raw, 5, 4);
    exception when unique_violation then
      null;                                       -- совпал хэш другой группы: пробуем ещё раз
    end;
  end loop;
  raise exception 'code_generation_failed';
end;
$$;

-- Внутреннее: освободить привязку студента и членство (status → p_status). Данные студента остаются.
-- Легаси-связь profiles (только 24ДММ-2) удаляется, иначе старый клиент и Edge Functions продолжали бы
-- считать аккаунт этим студентом, а повторный импорт снова привязал бы его.
create function public._release_binding(p_student_id text, p_status text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_group uuid;
begin
  select claimed_by, group_id into v_user, v_group from public.students where id = p_student_id;
  update public.students set claimed_by = null, claim_status = 'free', claimed_at = null where id = p_student_id;
  if v_user is not null then
    update public.memberships set status = p_status, extra_role = null, student_id = null, updated_at = now()
     where user_id = v_user and group_id = v_group;
    delete from public.profiles where user_id = v_user and student_id = p_student_id;
  end if;
  return v_user;
end;
$$;

-- Безопасный разбор даты (кривая дата в jsonb → null, а не ошибка импорта)
create function public._try_date(p text)
returns date language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(p, 10)::date;
exception when others then
  return null;
end;
$$;

-- 1. Подтвердить студента (староста/заместитель группы студента или сисадмин)
create function public.membership_approve(p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.students;
begin
  select * into s from public.students where id = p_student_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(s.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if s.claim_status <> 'pending' or s.claimed_by is null then raise exception 'not_pending' using errcode = 'P0001'; end if;
  update public.students set claim_status = 'active', claimed_at = now() where id = s.id;
  update public.memberships set status = 'active', updated_at = now()
   where user_id = s.claimed_by and group_id = s.group_id and status = 'pending';
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), s.group_id, 'membership_approve', jsonb_build_object('student_id', s.id, 'user_id', s.claimed_by));
  return jsonb_build_object('ok', true, 'student_id', s.id, 'user_id', s.claimed_by);
end;
$$;

-- 2. «Не он»: запись снова свободна, заявитель → rejected
create function public.membership_reject(p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.students;
begin
  select * into s from public.students where id = p_student_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(s.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if s.claim_status <> 'pending' or s.claimed_by is null then raise exception 'not_pending' using errcode = 'P0001'; end if;
  perform public._release_binding(s.id, 'rejected');
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), s.group_id, 'membership_reject', jsonb_build_object('student_id', s.id, 'user_id', s.claimed_by));
  return jsonb_build_object('ok', true, 'student_id', s.id, 'user_id', s.claimed_by);
end;
$$;

-- 3. Сброс привязки активного студента; данные студента (пропуски, события) сохраняются
create function public.student_reset_binding(p_student_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.students; v_extra text;
begin
  select * into s from public.students where id = p_student_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(s.group_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if s.claim_status <> 'active' or s.claimed_by is null then raise exception 'not_active' using errcode = 'P0001'; end if;
  if s.claimed_by = auth.uid() then raise exception 'self' using errcode = '42501'; end if;
  select extra_role into v_extra from public.memberships where user_id = s.claimed_by and group_id = s.group_id;
  if v_extra is not null and not public.is_sysadmin() then
    raise exception 'forbidden_role_holder' using errcode = '42501';   -- старосту/заместителя снимает только сисадмин
  end if;
  perform public._release_binding(s.id, 'removed');
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), s.group_id, 'student_reset_binding', jsonb_build_object('student_id', s.id, 'user_id', s.claimed_by));
  return jsonb_build_object('ok', true, 'student_id', s.id, 'user_id', s.claimed_by);
end;
$$;

-- 4. Напомнить старосте (pending-студент), не чаще раза в час. Отправляет Edge Function по audit_log.
create function public.remind_headman()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.memberships; v_last timestamptz;
begin
  select * into m from public.memberships
   where user_id = auth.uid() and status = 'pending' and base_role = 'student' and student_id is not null
   order by created_at desc limit 1;
  if not found then raise exception 'not_pending' using errcode = 'P0001'; end if;
  select last_at into v_last from public.remind_log where group_id = m.group_id and student_id = m.student_id for update;
  if v_last is not null and v_last > now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'next_at', v_last + interval '1 hour');
  end if;
  insert into public.remind_log (group_id, student_id, last_at) values (m.group_id, m.student_id, now())
    on conflict (group_id, student_id) do update set last_at = excluded.last_at;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), m.group_id, 'remind_headman', jsonb_build_object('student_id', m.student_id));
  return jsonb_build_object('ok', true, 'next_at', now() + interval '1 hour');
end;
$$;

-- 5. Согласие на обработку персональных данных
create function public.consent_accept(p_group uuid, p_version text, p_text_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(btrim(p_version), '') = '' then raise exception 'bad_version' using errcode = '22023'; end if;
  update public.memberships set consent_at = now(), consent_version = p_version, updated_at = now()
   where user_id = auth.uid() and group_id = p_group and status in ('active', 'pending');
  if not found then raise exception 'no_membership' using errcode = 'P0002'; end if;
  insert into public.consents (user_id, group_id, version, text_hash) values (auth.uid(), p_group, p_version, p_text_hash);
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'consent_accept', jsonb_build_object('version', p_version));
  return jsonb_build_object('ok', true);
end;
$$;

-- 6. Отправить заявку старосты на рассмотрение
create function public.registration_submit(p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.registration_requests; n int; nd int; v_idx int;
begin
  select * into r from public.registration_requests where id = p_request for update;
  if not found or r.owner_user_id is distinct from auth.uid() then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status <> 'draft' then raise exception 'not_draft' using errcode = 'P0001'; end if;
  if jsonb_typeof(r.payload -> 'group') is distinct from 'object'
     or jsonb_typeof(r.payload -> 'owner') is distinct from 'object'
     or jsonb_typeof(r.payload -> 'students') is distinct from 'array'
     or coalesce(btrim(coalesce(r.payload -> 'group' ->> 'name', r.payload -> 'group' ->> 'group_no')), '') = '' then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  select count(*),
         count(distinct lower(btrim(coalesce(e ->> 'last_name', e ->> 'lastName'))) || '|' || lower(btrim(coalesce(e ->> 'first_name', e ->> 'firstName'))))
    into n, nd
    from jsonb_array_elements(r.payload -> 'students') e;
  if n < 1 then raise exception 'no_students' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(r.payload -> 'students') e
              where jsonb_typeof(e) <> 'object'
                 or coalesce(btrim(coalesce(e ->> 'last_name', e ->> 'lastName')), '') = ''
                 or coalesce(btrim(coalesce(e ->> 'first_name', e ->> 'firstName')), '') = ''
                 or coalesce(e ->> 'study_form', e ->> 'studyForm', 'budget') not in ('budget', 'paid')) then
    raise exception 'bad_student' using errcode = '22023';
  end if;
  if nd <> n then raise exception 'duplicate_student' using errcode = '22023'; end if;
  if r.payload -> 'owner' ? 'studentIndex' and jsonb_typeof(r.payload -> 'owner' -> 'studentIndex') <> 'null' then
    v_idx := (r.payload -> 'owner' ->> 'studentIndex')::int;
    if v_idx < 0 or v_idx >= n then raise exception 'bad_owner_index' using errcode = '22023'; end if;
  end if;
  update public.registration_requests set status = 'submitted', submitted_at = now(), updated_at = now() where id = r.id;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), null, 'registration_submit', jsonb_build_object('request_id', r.id));
  return jsonb_build_object('ok', true, 'request_id', r.id);
end;
$$;

-- 7. Одобрить заявку (только сисадмин): группа, студенты, староста, код группы. Код возвращается один раз.
create function public.sysadmin_approve_registration(p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.registration_requests;
  g jsonb;
  v_group uuid;
  v_owner_idx int;
  v_owner_student text;
  v_code text;
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.registration_requests where id = p_request for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status = 'approved' then raise exception 'already_approved' using errcode = 'P0001'; end if;
  if r.status <> 'submitted' then raise exception 'not_submitted' using errcode = 'P0001'; end if;
  g := r.payload -> 'group';

  insert into public.groups (name, faculty, study_form, course, group_no, university,
                             bseu_faculty_id, bseu_form_id, bseu_group_id, schedule_status)
  values (btrim(coalesce(g ->> 'name', g ->> 'group_no')), g ->> 'faculty', g ->> 'study_form',
          case when g ->> 'course' ~ '^\d+$' then (g ->> 'course')::int end,
          g ->> 'group_no', coalesce(nullif(g ->> 'university', ''), 'БГЭУ'),
          g ->> 'bseu_faculty_id', g ->> 'bseu_form_id', g ->> 'bseu_group_id', r.schedule_status)
  returning id into v_group;

  -- Студенты в порядке заявки: sort = позиция в массиве (1-based), по ней находим студента-старосту
  insert into public.students (group_id, last_name, first_name, study_form, sort)
    select v_group,
           btrim(coalesce(e.v ->> 'last_name', e.v ->> 'lastName')),
           btrim(coalesce(e.v ->> 'first_name', e.v ->> 'firstName')),
           nullif(coalesce(e.v ->> 'study_form', e.v ->> 'studyForm'), ''),
           e.ord::int
      from jsonb_array_elements(r.payload -> 'students') with ordinality as e(v, ord);

  if jsonb_typeof(r.payload -> 'owner' -> 'studentIndex') = 'number' then
    v_owner_idx := (r.payload -> 'owner' ->> 'studentIndex')::int;      -- 0-based
    select id into v_owner_student from public.students where group_id = v_group and sort = v_owner_idx + 1;
  end if;
  if v_owner_student is not null then
    update public.students set claimed_by = r.owner_user_id, claim_status = 'active', claimed_at = now()
     where id = v_owner_student;
  end if;
  insert into public.memberships (user_id, group_id, student_id, base_role, extra_role, status)
    values (r.owner_user_id, v_group, v_owner_student, 'student', 'headman', 'active');

  v_code := public._group_code_set(v_group);
  update public.registration_requests
     set status = 'approved', group_id = v_group, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = r.id;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), v_group, 'registration_approve',
            jsonb_build_object('request_id', r.id, 'owner', r.owner_user_id,
                               'students', jsonb_array_length(r.payload -> 'students')));
  return jsonb_build_object('group_id', v_group, 'code', v_code);
end;
$$;

-- 8. Отклонить заявку (только сисадмин)
create function public.sysadmin_reject_registration(p_request uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.registration_requests;
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into r from public.registration_requests where id = p_request for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status <> 'submitted' then raise exception 'not_submitted' using errcode = 'P0001'; end if;
  update public.registration_requests
     set status = 'rejected', reject_reason = left(p_reason, 500), reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = r.id;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), null, 'registration_reject', jsonb_build_object('request_id', r.id, 'reason', left(p_reason, 500)));
  return jsonb_build_object('ok', true);
end;
$$;

-- 9. Перевыпуск кода группы: старый хэш перестаёт работать, новый код возвращается один раз
create function public.group_code_rotate(p_group uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not exists (select 1 from public.groups where id = p_group) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not public.is_group_staff(p_group) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_code := public._group_code_set(p_group);
  insert into public.audit_log (actor, group_id, action, details) values (auth.uid(), p_group, 'group_code_rotate', '{}');
  return v_code;
end;
$$;

-- 10. Роли в группе (только сисадмин). headman/deputy передаются: прежний держатель становится студентом.
create function public.sysadmin_set_group_role(p_group uuid, p_user uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.memberships; v_prev uuid;
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'self' using errcode = '42501'; end if;
  if p_role not in ('headman', 'deputy', 'student', 'none') then raise exception 'bad_role' using errcode = '22023'; end if;
  select * into m from public.memberships where user_id = p_user and group_id = p_group for update;
  if not found or m.status <> 'active' then raise exception 'no_active_membership' using errcode = 'P0002'; end if;

  if p_role in ('headman', 'deputy') then
    if m.base_role <> 'student' then raise exception 'not_student' using errcode = 'P0001'; end if;
    -- Один староста и один заместитель: снимаем роль с прежнего держателя в той же транзакции
    update public.memberships set extra_role = null, updated_at = now()
     where group_id = p_group and status = 'active' and extra_role = p_role and user_id <> p_user
    returning user_id into v_prev;
    update public.memberships set extra_role = p_role, updated_at = now() where user_id = p_user and group_id = p_group;
  elsif p_role = 'student' then
    update public.memberships set extra_role = null, updated_at = now() where user_id = p_user and group_id = p_group;
  else
    if m.student_id is not null then
      perform public._release_binding(m.student_id, 'removed');
    end if;
    update public.memberships set status = 'removed', extra_role = null, updated_at = now()
     where user_id = p_user and group_id = p_group;
  end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'set_group_role',
            jsonb_build_object('user_id', p_user, 'role', p_role, 'previous_holder', v_prev));
  return jsonb_build_object('ok', true, 'previous_holder', v_prev);
end;
$$;

-- 11. Пороги пропусков группы (только сисадмин)
create function public.sysadmin_set_thresholds(p_group uuid, p_warn int, p_dean int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_warn is null or p_dean is null or p_warn < 1 or p_dean < p_warn then
    raise exception 'bad_thresholds' using errcode = '22023';
  end if;
  update public.groups set warn_hours = p_warn, dean_hours = p_dean where id = p_group;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'set_thresholds', jsonb_build_object('warn', p_warn, 'dean', p_dean));
  return jsonb_build_object('ok', true);
end;
$$;

-- 12. Импорт легаси-данных 24ДММ-2 (только service_role; вызывается и в конце этой миграции).
-- Идемпотентный: только добавляет недостающее. Существующие строки students/absences/memberships
-- не перезаписываются (кроме пустого students.telegram), ручные правки и сбросы привязок сохраняются.
-- Удаления и правки в journal_private после первого импорта сюда НЕ переносятся (см. docs/stage1-db.md).
create function public.journal2_import_legacy()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  G constant uuid := '00000000-0000-4000-8000-000000000024';
  js jsonb;
  ja jsonb;
  v_students int; v_absences int; v_members int; v_claimed int; v_skipped int;
  v_new_users uuid[];
  adm record;
begin
  insert into public.groups (id, name, faculty, study_form, course, group_no, bseu_faculty_id, bseu_form_id, bseu_group_id)
  values (G, '24ДММ-2', 'ФМк', 'Дневная', 3, '24ДММ-2', '13', '10', '9457')
  on conflict do nothing;

  select students, absences into js, ja from public.journal_private where id = 'main';
  js := coalesce(js, '[]'::jsonb);
  ja := coalesce(ja, '[]'::jsonb);

  -- Студенты: id сохраняется, sort — по алфавиту; status «Бюджет/Платное» → budget/paid
  insert into public.students (id, group_id, last_name, first_name, study_form, telegram, sort)
  select s ->> 'id', G,
         nullif(btrim(s ->> 'lastName'), ''), nullif(btrim(s ->> 'firstName'), ''),
         case lower(btrim(s ->> 'status')) when 'бюджет' then 'budget' when 'платное' then 'paid' end,
         case when nullif(btrim(s ->> 'telegramUsername'), '') is not null
              then jsonb_build_object('username', btrim(s ->> 'telegramUsername')) end,
         row_number() over (order by lower(s ->> 'lastName'), lower(s ->> 'firstName'), s ->> 'id')::int
    from jsonb_array_elements(js) s
   where nullif(s ->> 'id', '') is not null
  on conflict (id) do update set telegram = excluded.telegram
   where public.students.group_id = G and public.students.telegram is null and excluded.telegram is not null;

  -- Пропуски: даты и часы нормализуются, пустое → null; пропуски несуществующих студентов пропускаются
  insert into public.absences (id, group_id, student_id, date, subject, hours, is_excused,
                               cert_type, cert_submitted, cert_due_date, comment, created_by)
  select a ->> 'id', G, a ->> 'studentId',
         public._try_date(a ->> 'date'),
         nullif(btrim(a ->> 'subject'), ''),
         case when btrim(a ->> 'totalHours') ~ '^\d+([.,]\d+)?$' then replace(btrim(a ->> 'totalHours'), ',', '.')::numeric end,
         coalesce(lower(a ->> 'isExcused') in ('true', 't', '1'), false),
         nullif(btrim(a ->> 'certType'), ''),
         coalesce(lower(a ->> 'certSubmitted') in ('true', 't', '1'), false),
         public._try_date(a ->> 'certDueDate'),
         nullif(btrim(a ->> 'comment'), ''),
         null
    from jsonb_array_elements(ja) a
   where nullif(a ->> 'id', '') is not null
     and exists (select 1 from public.students st where st.id = a ->> 'studentId' and st.group_id = G)
  on conflict (id) do nothing;

  -- Привязка записи, у которой аккаунт удалён (claimed_by обнулился по FK), снова свободна
  update public.students set claim_status = 'free', claimed_at = null
   where group_id = G and claimed_by is null and claim_status <> 'free';

  -- Членства для профилей; роли — только вновь созданным (ручные правки ролей сохраняются)
  with ins as (
    insert into public.memberships (user_id, group_id, student_id, base_role, status)
    select p.user_id, G, p.student_id, 'student', 'active'
      from public.profiles p
      join public.students st on st.id = p.student_id and st.group_id = G
     where (st.claimed_by is null or st.claimed_by = p.user_id)
    on conflict (user_id, group_id) do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into v_new_users from ins;

  for adm in
    select m.user_id, row_number() over (order by s ->> 'id') as rn
      from jsonb_array_elements(js) s
      join public.memberships m on m.group_id = G and m.student_id = s ->> 'id'
     where s ->> 'isAdmin' = 'true' and m.user_id = any (v_new_users)
  loop
    -- isAdmin → headman; если староста уже есть — заместитель; если заняты обе роли — без роли
    if not exists (select 1 from public.memberships where group_id = G and status = 'active' and extra_role = 'headman') then
      update public.memberships set extra_role = 'headman' where user_id = adm.user_id and group_id = G;
    elsif not exists (select 1 from public.memberships where group_id = G and status = 'active' and extra_role = 'deputy') then
      update public.memberships set extra_role = 'deputy' where user_id = adm.user_id and group_id = G;
    end if;
  end loop;

  update public.students st
     set claimed_by = m.user_id, claim_status = 'active', claimed_at = coalesce(st.claimed_at, now())
    from public.memberships m
   where m.group_id = G and m.status = 'active' and m.student_id = st.id
     and st.group_id = G and st.claimed_by is null
     and not exists (select 1 from public.students x where x.claimed_by = m.user_id);

  select count(*) into v_students from public.students where group_id = G;
  select count(*) into v_absences from public.absences where group_id = G;
  select count(*) into v_members from public.memberships where group_id = G and status = 'active';
  select count(*) into v_claimed from public.students where group_id = G and claim_status = 'active';
  select count(*) into v_skipped from jsonb_array_elements(ja) a
   where not exists (select 1 from public.students st where st.id = a ->> 'studentId' and st.group_id = G);

  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), G, 'legacy_import',
            jsonb_build_object('students', v_students, 'absences', v_absences, 'memberships', v_members,
                               'new_memberships', coalesce(array_length(v_new_users, 1), 0)));
  return jsonb_build_object(
    'students', v_students,
    'absences', v_absences,
    'memberships', v_members,
    'new_memberships', coalesce(array_length(v_new_users, 1), 0),
    'claimed', v_claimed,
    'headman', (select count(*) from public.memberships where group_id = G and status = 'active' and extra_role = 'headman'),
    'deputy', (select count(*) from public.memberships where group_id = G and status = 'active' and extra_role = 'deputy'),
    'skipped_absences', v_skipped,
    'profiles_without_student', (select count(*) from public.profiles p
                                  where not exists (select 1 from public.students st where st.id = p.student_id and st.group_id = G)),
    'legacy_students', jsonb_array_length(js),
    'legacy_absences', jsonb_array_length(ja));
end;
$$;

-- 13. Первый сисадмин (только service_role)
create function public.sysadmin_bootstrap(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sysadmins (user_id) values (p_user) on conflict do nothing;
  insert into public.audit_log (actor, group_id, action, details)
    values (null, null, 'sysadmin_bootstrap', jsonb_build_object('user_id', p_user));
  return jsonb_build_object('ok', true);
end;
$$;

-- Новый легаси-профиль (старый register-with-code для 24ДММ-2) сразу получает членство через импорт,
-- иначе новый студент 24ДММ-2 не прочитал бы журнал. Студенту другой группы профиль не положен.
create function public.profiles_legacy_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.students st
              where st.id = new.student_id and st.group_id <> '00000000-0000-4000-8000-000000000024') then
    raise exception 'profiles: только для студентов 24ДММ-2' using errcode = '42501';
  end if;
  perform public.journal2_import_legacy();
  return null;
end;
$$;
create trigger profiles_legacy_sync after insert on public.profiles
  for each row execute function public.profiles_legacy_sync();

-- ===== Права на функции =====
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['_group_code_set(uuid)', '_release_binding(text, text)', '_try_date(text)',
                           'profiles_legacy_sync()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- только service_role
  foreach f in array array['journal2_import_legacy()', 'sysadmin_bootstrap(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- клиентские RPC: только authenticated (права проверяются внутри по auth.uid())
  foreach f in array array['membership_approve(text)', 'membership_reject(text)', 'student_reset_binding(text)',
                           'remind_headman()', 'consent_accept(uuid, text, text)', 'registration_submit(uuid)',
                           'sysadmin_approve_registration(uuid)', 'sysadmin_reject_registration(uuid, text)',
                           'group_code_rotate(uuid)', 'sysadmin_set_group_role(uuid, uuid, text)',
                           'sysadmin_set_thresholds(uuid, int, int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================================================
-- 7. «Техработы» на новых таблицах (тот же паттерн, что в 20261103130000; app_settings — исключение)
-- ===================================================================================================
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables tb
     where schemaname = 'public' and tablename <> 'app_settings'
       and not exists (select 1 from pg_policies p
                        where p.schemaname = 'public' and p.tablename = tb.tablename and p.policyname = 'Техработы')
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

-- ===================================================================================================
-- 8. Импорт 24ДММ-2 в той же транзакции: без него 28 действующих потеряли бы доступ к журналу
-- ===================================================================================================
select public.journal2_import_legacy();
