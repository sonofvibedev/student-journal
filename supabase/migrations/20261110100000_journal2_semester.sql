-- Журнал 2.0, этап 6: закрытие семестра.
-- Группа автоматически становится closed (только просмотр), когда последний день семестра прошёл,
-- и открывается снова, когда импорт расписания приносит новый семестр. Старые данные остаются.
-- Откат: supabase/migrations_down/20261110100000_journal2_semester.down.sql.

-- 1. Для какого семестра группа закрыта автоматически. Закрытая вручную (сисадмином) сама не откроется.
alter table public.groups add column semester_closed_for date;

-- 2. Закрытие и открытие (cron 04:05 по Минску, после ночного импорта)
-- «Сегодня» по Минску. Закрыть: группа active, schedule_meta.semester_end < сегодня, и именно для этого конца
-- ещё не закрывали (вручную открытая после закрытия не закроется повторно). Открыть: группа closed с отметкой
-- автозакрытия и новый конец семестра позже прежнего и не в прошлом. Староста и заместитель получают уведомление.
create function public.semester_tick()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Minsk')::date;
  n_close int; n_open int;
begin
  with c as (
    update public.groups g set status = 'closed', semester_closed_for = sm.semester_end
      from public.schedule_meta sm
     where sm.group_id = g.id and g.status = 'active' and sm.semester_end < v_today
       and g.semester_closed_for is distinct from sm.semester_end
    returning g.id as gid, sm.semester_end as e
  ), a as (
    insert into public.audit_log (group_id, action, details)
    select gid, 'group_status', jsonb_build_object('from', 'active', 'to', 'closed', 'reason', 'semester_end', 'semester_end', e) from c
    returning 1
  ), n as (
    insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    select m.user_id, c.gid, 'semester', 'Журнал закрыт до нового семестра',
           'Семестр закончился ' || to_char(c.e, 'DD.MM.YYYY') || '. Данные можно смотреть, вносить и менять нельзя. Отчёт для деканата доступен в кабинете. Журнал откроется, когда в расписании появится новый семестр.',
           jsonb_build_object('semester_end', c.e, 'state', 'closed'),
           'semester-closed:' || c.gid || ':' || c.e
      from c join public.memberships m on m.group_id = c.gid and m.status = 'active' and m.extra_role in ('headman', 'deputy')
    on conflict (user_id, dedupe_key) do nothing
    returning 1
  )
  select count(*) into n_close from c;

  with o as (
    update public.groups g set status = 'active', semester_closed_for = null
      from public.schedule_meta sm
     where sm.group_id = g.id and g.status = 'closed' and g.semester_closed_for is not null
       and sm.semester_end > g.semester_closed_for and sm.semester_end >= v_today
    returning g.id as gid, sm.semester_end as e
  ), a as (
    insert into public.audit_log (group_id, action, details)
    select gid, 'group_status', jsonb_build_object('from', 'closed', 'to', 'active', 'reason', 'new_semester', 'semester_end', e) from o
    returning 1
  ), n as (
    insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    select m.user_id, o.gid, 'semester', 'Начался новый семестр',
           'Журнал снова открыт. Последний день семестра: ' || to_char(o.e, 'DD.MM.YYYY') || '. Данные прошлого семестра остались в архиве.',
           jsonb_build_object('semester_end', o.e, 'state', 'open'),
           'semester-open:' || o.gid || ':' || o.e
      from o join public.memberships m on m.group_id = o.gid and m.status = 'active' and m.extra_role in ('headman', 'deputy')
    on conflict (user_id, dedupe_key) do nothing
    returning 1
  )
  select count(*) into n_open from o;

  return jsonb_build_object('closed', n_close, 'opened', n_open);
end;
$$;

-- 3. Ручное «Отключить» сисадмином снимает отметку автозакрытия: такая группа сама не откроется
create or replace function public.sysadmin_set_group_status(p_group uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform public._assert_sysadmin(true);
  if p_status is null or p_status not in ('active', 'closed') then raise exception 'bad_status' using errcode = '22023'; end if;
  select g.status into v_old from public.groups g where g.id = p_group for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.groups g
     set status = p_status,
         semester_closed_for = case when p_status = 'closed' then null else g.semester_closed_for end
   where g.id = p_group;
  insert into public.audit_log (actor, group_id, action, details)
    values (auth.uid(), p_group, 'group_status', jsonb_build_object('from', v_old, 'to', p_status));
  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- 4. notify_daily: в предупреждении за 14 и 7 дней сказано, что журнал закроется, и куда идти за отчётом
create or replace function public.notify_daily()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Europe/Minsk')::date;
  v_tom   text := to_char((now() at time zone 'Europe/Minsk')::date + 1, 'YYYY-MM-DD');
  n_dl int; n_cert int; n_sem int;
begin
  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, t.group_id, 'deadline_soon',
         case t.kind when 'deadline' then 'Завтра дедлайн' else 'Завтра сдавать задание' end,
         left(concat_ws(': ', nullif(btrim(t.rec ->> 'subject'), ''), nullif(btrim(t.rec ->> 'text'), '')), 300),
         jsonb_build_object('task_id', t.id, 'kind', t.kind, 'due', v_tom),
         'deadline:' || t.id || ':' || v_tom
    from public.tasks t
    join public.groups g on g.id = t.group_id and g.status = 'active'
    join public.memberships m on m.group_id = t.group_id and m.status = 'active' and m.base_role = 'student'
    left join public.students s on s.id = m.student_id and s.group_id = m.group_id
   where left(t.rec ->> 'dueDate', 10) = v_tom
     and not (coalesce(t.rec ->> 'subgroup', '') in ('1', '2') and s.subgroup is not null
              and s.subgroup::text <> t.rec ->> 'subgroup')
     and not exists (select 1 from public.app_events e
                      where e.user_id = m.user_id and e.ref = t.id and e.kind in ('homework_done', 'deadline_done'))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_dl = row_count;

  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, c.group_id, 'certificate', 'Завтра срок сдачи справки',
         case when m.base_role = 'student' and m.student_id = c.student_id then c.what else c.name || ': ' || c.what end,
         jsonb_build_object('certificate_id', c.id, 'status', c.status, 'student_id', c.student_id, 'due', c.due_date),
         'cert-due:' || c.id || ':' || c.due_date
    from (select c.*, concat_ws(' ', s.last_name, s.first_name) as name,
                 concat_ws(', ',
                   case c.kind when 'sick' then 'Больничный' when 'statement' then 'Заявление' else 'Справка' end,
                   case when c.date_from is not null or c.date_to is not null
                        then concat_ws('–', to_char(c.date_from, 'DD.MM.YYYY'), to_char(c.date_to, 'DD.MM.YYYY')) end) as what
            from public.certificates c
            join public.groups g on g.id = c.group_id and g.status = 'active'
            join public.students s on s.id = c.student_id and s.group_id = c.group_id
           where c.status = 'waiting' and c.due_date = v_today + 1) c
    join public.memberships m on m.group_id = c.group_id and m.status = 'active'
     and ((m.base_role = 'student' and m.student_id = c.student_id) or m.extra_role in ('headman', 'deputy'))
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_cert = row_count;

  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
  select m.user_id, sm.group_id, 'semester', 'Скоро конец семестра',
         'Последний день семестра — ' || to_char(sm.semester_end, 'DD.MM.YYYY') || ' (через ' || (sm.semester_end - v_today) || ' дн.). Журнал закроется до начала следующего семестра: скачайте отчёт для деканата.',
         jsonb_build_object('semester_end', sm.semester_end, 'days_left', sm.semester_end - v_today),
         'semester:' || sm.group_id || ':' || sm.semester_end || ':' || case when sm.semester_end - v_today > 7 then '14' else '7' end
    from public.schedule_meta sm
    join public.groups g on g.id = sm.group_id and g.status = 'active'
    join public.memberships m on m.group_id = sm.group_id and m.status = 'active' and m.extra_role in ('headman', 'deputy')
   where sm.semester_end - v_today between 1 and 14
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n_sem = row_count;

  return jsonb_build_object('deadline_soon', n_dl, 'certificate', n_cert, 'semester', n_sem);
end;
$$;

-- 5. Права: только service_role (cron вызывает владельцем)
revoke all on function public.semester_tick() from public, anon, authenticated;
grant execute on function public.semester_tick() to service_role;

-- 6. cron (UTC; Минск круглый год UTC+3): 01:05 UTC = 04:05 по Минску
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron нет: задание journal-semester не создано';
    return;
  end if;
  perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-semester';
  perform cron.schedule('journal-semester', '5 1 * * *', 'select public.semester_tick()');
end $$;
