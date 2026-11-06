-- Откат 20261110100000_journal2_semester.sql: БД возвращается к состоянию после 20261109100000.
-- Группы, закрытые автоматически, остаются closed (откройте вручную через sysadmin_set_group_status);
-- уведомления и записи audit_log не удаляются.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
begin;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-semester';
  end if;
end $$;

drop function public.semester_tick();

-- 9. Отключить/включить группу: closed = только просмотр (group_open() ложно)
create or replace function public.sysadmin_set_group_status(p_group uuid, p_status text)
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
         'Последний день семестра — ' || to_char(sm.semester_end, 'DD.MM.YYYY') || ' (через ' || (sm.semester_end - v_today) || ' дн.)',
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

alter table public.groups drop column semester_closed_for;

delete from supabase_migrations.schema_migrations where version = '20261110100000';

commit;
