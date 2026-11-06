-- Журнал 2.0, этап 5: утилита сисадмина — события и замеры (client_events), служебное состояние (ops_state),
-- резервные копии (backups + закрытое хранилище Storage `backups`), сводка состояния, преподаватели, сисадмины,
-- создание и закрытие групп, cron мониторинга, сводки, копий и чистки.
--
-- Контракт: docs/stage5-contract.md, раздел «База». Подробно (матрица прав, RPC, до → после, риски, чек-лист):
-- docs/stage5-db.md. Откат: supabase/migrations_down/20261109100000_journal2_ops.down.sql.
--
-- ВНИМАНИЕ (cron). Секрета в файле нет: задания читают его из Vault (cron_secret), как на этапе 3.
-- Адрес ниже — прод; тестовая копия миграций подменяет ref (tools/test/apply-migrations.sh). Без pg_cron
-- задания не создаются (notice); без pg_net или Vault не создаются только задания с HTTP-вызовом.

-- ===================================================================================================
-- 1. Таблицы
-- ===================================================================================================

-- События браузера и сервера, пинги, алерты. Без идентификаторов пользователей. Пишет только service_role
-- (Edge Functions client-report, health-check, _shared/oplog.ts). group_id без FK: событие не должно теряться
-- из-за удалённой или выдуманной клиентом группы.
create table public.client_events (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  source   text not null check (source in ('client', 'server', 'health')),
  kind     text not null check (kind in ('error', 'perf', 'ping', 'alert')),
  name     text check (length(name) <= 120),
  message  text check (length(message) <= 300),
  detail   text check (length(detail) <= 1000),
  ms       int,
  ok       boolean,
  ua       text check (length(ua) <= 120),
  group_id uuid
);
create index client_events_at_idx on public.client_events (at);
create index client_events_kind_at_idx on public.client_events (kind, at);

-- Служебное состояние Edge Functions: ключи 'last_alert' (последний алерт health-check) и 'last_digest'
-- (последняя сводка ops-report). updated_at ставит триггер на любой insert/update (upsert без updated_at
-- тоже обновляет время).
create table public.ops_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Журнал резервных копий (пишет backup-run под service_role)
create table public.backups (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('nightly', 'manual')),
  path       text,
  size_bytes bigint,
  tables     jsonb,
  status     text not null check (status in ('ok', 'failed')),
  error      text
);
create index backups_at_idx on public.backups (at desc);

do $$
declare t text;
begin
  foreach t in array array['client_events', 'ops_state', 'backups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

-- Читает только сисадмин; записи клиента нет (нет grant). ops_state клиенту закрыта целиком (видна через ops_summary).
grant select on public.client_events, public.backups to authenticated;
create policy "События: сисадмин" on public.client_events for select to authenticated
  using ((select public.is_sysadmin()));
create policy "Резервные копии: сисадмин" on public.backups for select to authenticated
  using ((select public.is_sysadmin()));

create function public.ops_state_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger ops_state_touch before insert or update on public.ops_state
  for each row execute function public.ops_state_touch();

-- Закрытое хранилище копий: private, без политик на storage.objects — доступ только service_role
-- (скачивание — подписанной ссылкой из Edge Function backup-link).
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do update set public = false;

-- ===================================================================================================
-- 2. Группа из payload: общая часть одобрения заявки и создания группы сисадмином
-- ===================================================================================================

-- Внутреннее: группа и студенты из payload формата registration_requests.payload.group / .students.
-- Студенты в порядке массива: sort = позиция (1-based). Проверок здесь нет: одобрение полагается на
-- registration_submit, создание сисадмином — на _group_payload_check.
create function public._group_create(p_group jsonb, p_students jsonb, p_schedule_status text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_group uuid;
begin
  insert into public.groups (name, faculty, study_form, course, group_no, university,
                             bseu_faculty_id, bseu_form_id, bseu_group_id, schedule_status)
  values (btrim(coalesce(p_group ->> 'name', p_group ->> 'group_no')), p_group ->> 'faculty', p_group ->> 'study_form',
          case when p_group ->> 'course' ~ '^\d+$' then (p_group ->> 'course')::int end,
          p_group ->> 'group_no', coalesce(nullif(p_group ->> 'university', ''), 'БГЭУ'),
          p_group ->> 'bseu_faculty_id', p_group ->> 'bseu_form_id', p_group ->> 'bseu_group_id', p_schedule_status)
  returning id into v_group;

  insert into public.students (group_id, last_name, first_name, study_form, sort)
    select v_group,
           btrim(coalesce(e.v ->> 'last_name', e.v ->> 'lastName')),
           btrim(coalesce(e.v ->> 'first_name', e.v ->> 'firstName')),
           nullif(coalesce(e.v ->> 'study_form', e.v ->> 'studyForm'), ''),
           e.ord::int
      from jsonb_array_elements(p_students) with ordinality as e(v, ord);
  return v_group;
end;
$$;

-- Внутреннее: проверки payload — те же правила и коды, что у registration_submit (группа с именем, ≥ 1 студент,
-- ФИО непустые и уникальны, форма budget/paid/нет), плюс пределы длины для ввода сисадмином.
create function public._group_payload_check(p_group jsonb, p_students jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare n int; nd int;
begin
  if jsonb_typeof(p_group) is distinct from 'object' or jsonb_typeof(p_students) is distinct from 'array'
     or coalesce(btrim(coalesce(p_group ->> 'name', p_group ->> 'group_no')), '') = ''
     or length(btrim(coalesce(p_group ->> 'name', p_group ->> 'group_no'))) > 60 then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  select count(*),
         count(distinct lower(btrim(coalesce(e ->> 'last_name', e ->> 'lastName'))) || '|' || lower(btrim(coalesce(e ->> 'first_name', e ->> 'firstName'))))
    into n, nd
    from jsonb_array_elements(p_students) e;
  if n < 1 then raise exception 'no_students' using errcode = '22023'; end if;
  if n > 300 then raise exception 'too_many_students' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_students) e
              where jsonb_typeof(e) <> 'object'
                 or coalesce(btrim(coalesce(e ->> 'last_name', e ->> 'lastName')), '') = ''
                 or coalesce(btrim(coalesce(e ->> 'first_name', e ->> 'firstName')), '') = ''
                 or length(btrim(coalesce(e ->> 'last_name', e ->> 'lastName'))) > 100
                 or length(btrim(coalesce(e ->> 'first_name', e ->> 'firstName'))) > 100
                 or coalesce(e ->> 'study_form', e ->> 'studyForm', 'budget') not in ('budget', 'paid')) then
    raise exception 'bad_student' using errcode = '22023';
  end if;
  if nd <> n then raise exception 'duplicate_student' using errcode = '22023'; end if;
end;
$$;

-- Одобрение заявки: поведение и ответ прежние, вставка группы и студентов вынесена в _group_create
create or replace function public.sysadmin_approve_registration(p_request uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.registration_requests;
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

  v_group := public._group_create(r.payload -> 'group', r.payload -> 'students', r.schedule_status);

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

-- ===================================================================================================
-- 3. RPC сисадмина (security definer, search_path = ''; ошибки — raise exception '<код>')
-- ===================================================================================================

-- Общая проверка: вызывающий — сисадмин; p_write — ещё и app_open() (у сисадмина он всегда истинен,
-- проверка оставлена ради единого правила «app_open() там, где пишется»)
create function public._assert_sysadmin(p_write boolean)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_sysadmin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_write and not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
end;
$$;

-- 1. Сводка состояния за p_hours часов (1…720)
create function public.ops_summary(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_since timestamptz;
  v_ping record;
  v_page record;
  v_err record;
begin
  perform public._assert_sysadmin(false);
  if p_hours is null or p_hours < 1 or p_hours > 720 then raise exception 'bad_hours' using errcode = '22023'; end if;
  v_since := now() - make_interval(hours => p_hours);

  select count(*) as pings,
         round(100.0 * count(*) filter (where e.ok) / nullif(count(*), 0), 1) as availability_pct,
         round(percentile_cont(0.5) within group (order by e.ms) filter (where e.name = 'db' and e.ms is not null))::int as p50,
         round(percentile_cont(0.95) within group (order by e.ms) filter (where e.name = 'db' and e.ms is not null))::int as p95
    into v_ping
    from public.client_events e
   where e.kind = 'ping' and e.at >= v_since;

  select round(percentile_cont(0.5) within group (order by e.ms))::int as p50,
         round(percentile_cont(0.95) within group (order by e.ms))::int as p95
    into v_page
    from public.client_events e
   where e.kind = 'perf' and e.name = 'page' and e.ms is not null and e.at >= v_since;

  select count(*) filter (where e.source = 'client') as client_errors,
         count(*) filter (where e.source = 'server') as server_errors
    into v_err
    from public.client_events e
   where e.kind = 'error' and e.at >= v_since;

  return jsonb_build_object(
    'hours', p_hours,
    'availability_pct', v_ping.availability_pct,
    'pings', v_ping.pings,
    'resp_p50_ms', v_ping.p50,
    'resp_p95_ms', v_ping.p95,
    'page_p50_ms', v_page.p50,
    'page_p95_ms', v_page.p95,
    'client_errors', v_err.client_errors,
    'server_errors', v_err.server_errors,
    'top_errors', (select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'message', t.message, 'count', t.n)
                                             order by t.n desc, t.name, t.message), '[]'::jsonb)
                     from (select e.name, e.message, count(*) as n
                             from public.client_events e
                            where e.kind = 'error' and e.at >= v_since
                            group by e.name, e.message
                            order by n desc, e.name, e.message
                            limit 5) t),
    'imports', (select coalesce(jsonb_agg(jsonb_build_object('group_id', g.id, 'name', g.name,
                                                             'last_import_at', m.last_import_at, 'last_status', m.last_status,
                                                             'last_error', m.last_error, 'lessons_count', m.lessons_count)
                                          order by g.name), '[]'::jsonb)
                  from public.groups g
                  left join public.schedule_meta m on m.group_id = g.id
                 where g.status <> 'graduated'),
    'pending_requests', (select count(*) from public.registration_requests r where r.status = 'submitted'),
    'pending_students', (select count(*) from public.students s where s.claim_status = 'pending'),
    'last_alert_at', (select o.updated_at from public.ops_state o where o.key = 'last_alert'),
    'last_digest_at', (select o.updated_at from public.ops_state o where o.key = 'last_digest'),
    'backup_last', (select jsonb_build_object('at', b.at, 'size_bytes', b.size_bytes, 'status', b.status)
                      from public.backups b order by b.at desc limit 1),
    'maintenance', coalesce((select (s.value ->> 'on')::boolean from public.app_settings s where s.key = 'maintenance'), false));
end;
$$;

-- 2. Лента событий: от новых к старым, курсор p_before (id), лимит до 200
create function public.ops_events(p_source text default null, p_kind text default null, p_hours int default 24,
                                  p_limit int default 100, p_before bigint default null)
returns setof public.client_events language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(false);
  if p_hours is null or p_hours < 1 or p_hours > 720 then raise exception 'bad_hours' using errcode = '22023'; end if;
  return query
  select e.* from public.client_events e
   where (p_source is null or e.source = p_source)
     and (p_kind is null or e.kind = p_kind)
     and e.at >= now() - make_interval(hours => p_hours)
     and (p_before is null or e.id < p_before)
   order by e.id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

-- 3. Пользователь по почте (без учёта регистра) → uuid или null
create function public.sysadmin_find_user(p_email text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(false);
  return (select u.id from auth.users u where lower(u.email) = lower(btrim(p_email)) order by u.created_at limit 1);
end;
$$;

-- 4. Назначить преподавателя группы: active-членство teacher_* без согласия (создаётся или переводится),
-- назначения пользователя в группе заменяются набором предметов с видом занятий по роли.
create function public.sysadmin_assign_teacher(p_user uuid, p_group uuid, p_role text, p_subjects text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_subjects text[];
begin
  perform public._assert_sysadmin(true);
  if p_role is null or p_role not in ('teacher_lecture', 'teacher_practice') then raise exception 'bad_role' using errcode = '22023'; end if;
  if not exists (select 1 from public.groups g where g.id = p_group) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  if p_subjects is null or exists (select 1 from unnest(p_subjects) s where coalesce(btrim(s), '') = '' or length(btrim(s)) > 200) then
    raise exception 'bad_subjects' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct btrim(s) order by btrim(s)), '{}') into v_subjects from unnest(p_subjects) s;
  if cardinality(v_subjects) < 1 then raise exception 'bad_subjects' using errcode = '22023'; end if;
  if cardinality(v_subjects) > 20 then raise exception 'too_many_subjects' using errcode = '22023'; end if;
  -- студент группы (active/pending-членство студента или привязанная запись) преподавателем не становится
  if exists (select 1 from public.memberships m
              where m.user_id = p_user and m.group_id = p_group and m.base_role = 'student' and m.status in ('active', 'pending'))
     or exists (select 1 from public.students s where s.claimed_by = p_user and s.group_id = p_group) then
    raise exception 'is_student' using errcode = 'P0001';
  end if;

  insert into public.memberships (user_id, group_id, student_id, base_role, extra_role, status)
    values (p_user, p_group, null, p_role, null, 'active')
  on conflict (user_id, group_id) do update
    set base_role = excluded.base_role, status = 'active', extra_role = null, student_id = null, updated_at = now();
  delete from public.teacher_assignments ta where ta.user_id = p_user and ta.group_id = p_group;
  insert into public.teacher_assignments (user_id, group_id, subject, lesson_kind)
    select p_user, p_group, s, substr(p_role, 9) from unnest(v_subjects) s;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'teacher_assign',
            jsonb_build_object('user_id', p_user, 'role', p_role, 'subjects', to_jsonb(v_subjects)));
  return jsonb_build_object('ok', true);
end;
$$;

-- 5. Снять преподавателя: членство removed, назначения удалены (чат закрывается политиками по текущей роли)
create function public.sysadmin_remove_teacher(p_user uuid, p_group uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public._assert_sysadmin(true);
  update public.memberships m set status = 'removed', updated_at = now()
   where m.user_id = p_user and m.group_id = p_group and m.base_role in ('teacher_lecture', 'teacher_practice');
  if not found then raise exception 'not_teacher' using errcode = 'P0002'; end if;
  delete from public.teacher_assignments ta where ta.user_id = p_user and ta.group_id = p_group;
  get diagnostics n = row_count;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'teacher_remove', jsonb_build_object('user_id', p_user, 'assignments', n));
  return jsonb_build_object('ok', true, 'assignments', n);
end;
$$;

-- 6. Преподаватели группы (все членства teacher_*, active первыми)
create function public.sysadmin_teachers(p_group uuid)
returns table(user_id uuid, email text, role text, subjects text[], status text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public._assert_sysadmin(false);
  return query
  select m.user_id, u.email::text, m.base_role,
         coalesce((select array_agg(ta.subject order by ta.subject) from public.teacher_assignments ta
                    where ta.user_id = m.user_id and ta.group_id = m.group_id), '{}'),
         m.status
    from public.memberships m
    join auth.users u on u.id = m.user_id
   where m.group_id = p_group and m.base_role in ('teacher_lecture', 'teacher_practice')
   order by (m.status = 'active') desc, u.email;
end;
$$;

-- 7. Сисадмины: добавить (учётная запись должна существовать), снять (не себя и не последнего), список.
-- Снятие под advisory-блокировкой: два сисадмина, снимающие друг друга одновременно, не оставят ноль.
create function public.sysadmin_add_sysadmin(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public._assert_sysadmin(true);
  if not exists (select 1 from auth.users u where u.id = p_user) then raise exception 'user_not_found' using errcode = 'P0002'; end if;
  insert into public.sysadmins (user_id) values (p_user) on conflict do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log (actor, group_id, action, details)
      values (auth.uid(), null, 'sysadmin_add', jsonb_build_object('user_id', p_user));
  end if;
  return jsonb_build_object('ok', true, 'added', n > 0);
end;
$$;

create function public.sysadmin_remove_sysadmin(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(true);
  if p_user = auth.uid() then raise exception 'self' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sysadmins', 0));
  -- после ожидания блокировки: вызывающего могли снять, пока он ждал
  if not exists (select 1 from public.sysadmins s where s.user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sysadmins s where s.user_id = p_user) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.sysadmins) <= 1 then raise exception 'last_sysadmin' using errcode = 'P0001'; end if;
  delete from public.sysadmins s where s.user_id = p_user;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), null, 'sysadmin_remove', jsonb_build_object('user_id', p_user));
  return jsonb_build_object('ok', true);
end;
$$;

create function public.sysadmin_list_sysadmins()
returns table(user_id uuid, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public._assert_sysadmin(false);
  return query
  select s.user_id, u.email::text, s.created_at
    from public.sysadmins s join auth.users u on u.id = s.user_id
   order by s.created_at, u.email;
end;
$$;

-- 8. Новая группа без заявки: группа и студенты (общая часть с одобрением заявки), код группы — один раз
-- в ответе, в базе только хэш. Старосты нет (назначается позже ролями). Имя группы не повторяет
-- действующую или закрытую группу (без учёта регистра и пробелов по краям).
create function public.sysadmin_create_group(p_group jsonb, p_students jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_group uuid; v_code text;
begin
  perform public._assert_sysadmin(true);
  perform public._group_payload_check(p_group, p_students);
  perform pg_advisory_xact_lock(hashtextextended('group_create', 0));       -- две одинаковые формы подряд
  if exists (select 1 from public.groups g
              where g.status <> 'graduated'
                and lower(btrim(g.name)) = lower(btrim(coalesce(p_group ->> 'name', p_group ->> 'group_no')))) then
    raise exception 'duplicate_group' using errcode = 'P0001';
  end if;
  v_group := public._group_create(p_group, p_students, null);
  v_code := public._group_code_set(v_group);
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), v_group, 'group_create',
            jsonb_build_object('name', btrim(coalesce(p_group ->> 'name', p_group ->> 'group_no')),
                               'students', jsonb_array_length(p_students)));
  return jsonb_build_object('group_id', v_group, 'code', v_code);
end;
$$;

-- 9. Отключить/включить группу: closed = только просмотр (group_open() ложно)
create function public.sysadmin_set_group_status(p_group uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform public._assert_sysadmin(true);
  if p_status is null or p_status not in ('active', 'closed') then raise exception 'bad_status' using errcode = '22023'; end if;
  select g.status into v_old from public.groups g where g.id = p_group for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.groups g set status = p_status where g.id = p_group;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'group_status', jsonb_build_object('from', v_old, 'to', p_status));
  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- 10. Предметы группы из расписания (для формы назначения преподавателя)
create function public.sysadmin_group_subjects(p_group uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_sysadmin(false);
  return coalesce((select array_agg(distinct l.subject order by l.subject)
                     from public.schedule_lessons l where l.group_id = p_group), '{}');
end;
$$;

-- 11. Хранение событий 30 дней (cron journal-ops-cleanup) → число удалённых
create function public.ops_cleanup()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.client_events e where e.at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ===== Права на функции =====
do $$
declare f text;
begin
  -- внутренние и триггерные: никому из клиентов
  foreach f in array array['_group_create(jsonb, jsonb, text)', '_group_payload_check(jsonb, jsonb)',
                           '_assert_sysadmin(boolean)', 'ops_state_touch()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- служебные: только service_role (cron вызывает владельцем)
  foreach f in array array['ops_cleanup()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- клиентские: authenticated (сисадмин проверяется внутри)
  foreach f in array array['ops_summary(int)', 'ops_events(text, text, int, int, bigint)', 'sysadmin_find_user(text)',
                           'sysadmin_assign_teacher(uuid, uuid, text, text[])', 'sysadmin_remove_teacher(uuid, uuid)',
                           'sysadmin_teachers(uuid)', 'sysadmin_add_sysadmin(uuid)', 'sysadmin_remove_sysadmin(uuid)',
                           'sysadmin_list_sysadmins()', 'sysadmin_create_group(jsonb, jsonb)',
                           'sysadmin_set_group_status(uuid, text)', 'sysadmin_group_subjects(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ===================================================================================================
-- 4. pg_cron (UTC; Минск круглый год UTC+3)
-- ===================================================================================================
-- Повторный запуск пересоздаёт задания (unschedule по имени). net.http_post асинхронный: ошибка или 404
-- функции попадает в net._http_response и cron.job_run_details и больше ни на что не влияет.
do $$
declare v_job text;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron нет: задания journal-* этапа 5 не созданы';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j
    where j.jobname in ('journal-health', 'journal-ops-report', 'journal-backup', 'journal-ops-cleanup');

  perform cron.schedule('journal-ops-cleanup', '15 1 * * *', 'select public.ops_cleanup()');

  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_net или Vault нет: задания journal-health, journal-ops-report, journal-backup не созданы';
    return;
  end if;
  v_job := $job$
    select net.http_post(
      url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/%s',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := %s
    );
  $job$;
  perform cron.schedule('journal-health', '*/5 * * * *', format(v_job, 'health-check', 30000));
  perform cron.schedule('journal-ops-report', '0 6 * * *', format(v_job, 'ops-report', 60000));
  perform cron.schedule('journal-backup', '30 0 * * *', format(v_job, 'backup-run', 150000));
end $$;
