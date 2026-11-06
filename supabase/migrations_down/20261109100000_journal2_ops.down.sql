-- Откат 20261109100000_journal2_ops.sql: БД возвращается к состоянию после 20261108100000.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
-- ВНИМАНИЕ: удаляет события и замеры (client_events), служебное состояние (ops_state) и журнал резервных копий
-- (backups) без восстановления. Файлы копий в Storage `backups` НЕ удаляются: хранилище убирается, только если
-- оно пустое (иначе notice — сначала скачайте и удалите файлы через Storage API). Группы, созданные
-- sysadmin_create_group, назначения преподавателей, добавленные сисадмины, статусы групп и записи audit_log остаются.
begin;

-- 1. cron
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobname) from cron.job j
      where j.jobname in ('journal-health', 'journal-ops-report', 'journal-backup', 'journal-ops-cleanup');
  end if;
end $$;

-- 2. Функции этапа 5 (ops_events возвращает строки client_events, поэтому до таблиц)
drop function public.ops_cleanup();
drop function public.sysadmin_group_subjects(uuid);
drop function public.sysadmin_set_group_status(uuid, text);
drop function public.sysadmin_create_group(jsonb, jsonb);
drop function public.sysadmin_list_sysadmins();
drop function public.sysadmin_remove_sysadmin(uuid);
drop function public.sysadmin_add_sysadmin(uuid);
drop function public.sysadmin_teachers(uuid);
drop function public.sysadmin_remove_teacher(uuid, uuid);
drop function public.sysadmin_assign_teacher(uuid, uuid, text, text[]);
drop function public.sysadmin_find_user(text);
drop function public.ops_events(text, text, int, int, bigint);
drop function public.ops_summary(int);
drop function public._assert_sysadmin(boolean);
drop function public._group_payload_check(jsonb, jsonb);

-- 3. sysadmin_approve_registration — прежний текст (20261105200000), затем общая часть
create or replace function public.sysadmin_approve_registration(p_request uuid)
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
drop function public._group_create(jsonb, jsonb, text);

-- 4. Таблицы (политики и триггер уходят вместе с ними)
drop table public.client_events, public.ops_state, public.backups;
drop function public.ops_state_touch();

-- 5. Хранилище копий — только пустое (файлы копий не удаляем молча)
do $$
begin
  if exists (select 1 from storage.objects o where o.bucket_id = 'backups') then
    raise notice 'Storage backups не пустое: хранилище оставлено';
  else
    -- storage.protect_delete запрещает прямое удаление ради «осиротевших» файлов; хранилище пустое, файлов нет
    perform set_config('storage.allow_delete_query', 'true', true);
    delete from storage.buckets b where b.id = 'backups';
  end if;
end $$;

-- 6. Запись о миграции: иначе db push не применит её повторно
delete from supabase_migrations.schema_migrations where version = '20261109100000';

commit;
