-- Журнал 2.0.3: «Логи» сисадмина по всем пользователям. Одна лента из audit_log, пропусков (внесены и отменены), оценок, заданий
-- и ошибок браузера/сервера: кто (имя и роль), группа, что, над чем (предмет, студент, дата), результат.
-- Только чтение и только сисадмин (_assert_sysadmin). Новых таблиц нет, данные не копируются.
-- Персональные данные: имя студента сокращено до «Фамилия И.»; значения оценок и причины справок в ленту не попадают;
-- ошибки клиента остаются без привязки к пользователю (так устроен client_events).
-- Откат: supabase/migrations_down/20261116110000_journal2_v203_activity_log.down.sql.

-- Роль автора в группе события: sysadmin, teacher, headman, deputy, student; system — действие без пользователя
create function public._actor_role(p_user uuid, p_group uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_user is null then 'system'
    when exists (select 1 from public.sysadmins s where s.user_id = p_user) then 'sysadmin'
    else coalesce((select case when m.base_role in ('teacher_lecture', 'teacher_practice') then 'teacher'
                               when m.extra_role = 'headman' then 'headman'
                               when m.extra_role = 'deputy' then 'deputy' else 'student' end
                     from public.memberships m
                    where m.user_id = p_user and (p_group is null or m.group_id = p_group)
                    order by (m.status = 'active') desc, m.created_at limit 1), 'unknown')
  end;
$$;

-- Имя автора: ФИО студента, иначе почта (преподавателя и сисадмина сисадмин и так видит в «Ролях»)
create function public._actor_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_user is null then 'Система' else coalesce(
    (select nullif(btrim(concat_ws(' ', s.last_name, s.first_name)), '') from public.students s where s.claimed_by = p_user limit 1),
    (select u.email::text from auth.users u where u.id = p_user),
    'Удалённый пользователь') end;
$$;

create function public._student_short(p_student text)
returns text language sql stable security definer set search_path = '' as $$
  select nullif(btrim(concat_ws(' ', s.last_name, case when coalesce(s.first_name, '') <> '' then left(s.first_name, 1) || '.' end)), '')
    from public.students s where s.id = p_student;
$$;

-- Лента. Окно по умолчанию — 90 дней. kind: admin, absence, cancel, grade, task, error. Страницы: p_limit (до 500) и p_offset.
-- ponytail: страницы через offset, ленту целиком строит каждый запрос; при росте данных заменить на курсор по (at, id).
create function public.sysadmin_activity_log(p_role text default null, p_user uuid default null, p_kind text default null,
                                             p_from date default null, p_to date default null, p_q text default null,
                                             p_limit int default 100, p_offset int default 0)
returns table(at timestamptz, kind text, action text, actor uuid, actor_name text, actor_role text, group_name text,
              target text, subject text, on_date date, qty numeric, ok boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_from timestamptz := coalesce(p_from, current_date - 90)::timestamptz;
        v_to   timestamptz := (coalesce(p_to, current_date) + 1)::timestamptz;
        v_q    text := nullif(lower(btrim(coalesce(p_q, ''))), '');
begin
  perform public._assert_sysadmin(false);
  if p_role is not null and p_role not in ('student', 'headman', 'deputy', 'teacher', 'sysadmin', 'system', 'unknown') then raise exception 'bad_role' using errcode = '22023'; end if;
  if p_kind is not null and p_kind not in ('admin', 'absence', 'cancel', 'grade', 'task', 'error') then raise exception 'bad_kind' using errcode = '22023'; end if;
  return query
  with ev as (
    select a.at, 'admin'::text kind, a.action, a.actor, a.group_id, null::text target, null::text subject, null::date on_date,
           null::numeric qty, true ok, nullif(a.details::text, '{}') detail
      from public.audit_log a where a.at >= v_from and a.at < v_to
    union all
    select b.created_at, 'absence', 'absence_add', b.created_by, b.group_id, public._student_short(b.student_id), b.subject, b.date,
           b.hours, true, case when b.is_excused then 'уважительный' end
      from public.absences b where b.created_at >= v_from and b.created_at < v_to
    union all
    select c.cancelled_at, 'cancel', 'absence_cancel', c.cancelled_by, c.group_id, public._student_short(c.student_id), c.absence ->> 'subject',
           nullif(c.absence ->> 'date', '')::date, nullif(c.absence ->> 'hours', '')::numeric, true, null
      from public.absence_cancellations c where c.cancelled_at >= v_from and c.cancelled_at < v_to
    union all
    select g.created_at, 'grade', 'grade_set', g.created_by, g.group_id, public._student_short(g.student_id), g.subject, g.lesson_date, null, true, null
      from public.grades g where g.created_at >= v_from and g.created_at < v_to
    union all
    select t.updated_at, 'task', 'task_' || t.kind, t.created_by, t.group_id, null, t.rec ->> 'subject', nullif(t.rec ->> 'dueDate', '')::date, null, true, t.rec ->> 'type'
      from public.tasks t where t.updated_at >= v_from and t.updated_at < v_to
    union all
    select e.at, 'error', e.name, null, e.group_id, null, null, null, e.ms, false, e.message
      from public.client_events e where e.kind = 'error' and e.at >= v_from and e.at < v_to
  ), full_ev as (
    select ev.*, public._actor_name(ev.actor) an, public._actor_role(ev.actor, ev.group_id) ar, gr.name gn
      from ev left join public.groups gr on gr.id = ev.group_id
     where (p_kind is null or ev.kind = p_kind) and (p_user is null or ev.actor = p_user)
  )
  select f.at, f.kind, f.action, f.actor, f.an, f.ar, f.gn, f.target, f.subject, f.on_date, f.qty, f.ok, f.detail
    from full_ev f
   where (p_role is null or f.ar = p_role)
     and (v_q is null or position(v_q in lower(concat_ws(' ', f.an, f.gn, f.action, f.target, f.subject, f.detail))) > 0)
   order by f.at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['_actor_role(uuid, uuid)', '_actor_name(uuid)', '_student_short(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  revoke all on function public.sysadmin_activity_log(text, uuid, text, date, date, text, int, int) from public, anon;
  grant execute on function public.sysadmin_activity_log(text, uuid, text, date, date, text, int, int) to authenticated, service_role;
end $$;
