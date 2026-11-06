-- Откат 20261111100000_journal2_erasure.sql: БД возвращается к состоянию после 20261110100000 (схема и функции).
-- СТЁРТЫЕ ДАННЫЕ НЕ ВОССТАНАВЛИВАЮТСЯ: удалённые аккаунты, события, значки, уведомления, чат, ФИО обезличенных
-- студентов. Обезличенные записи студентов остаются со статусом 'erased' (ограничение claim_status возвращается
-- как NOT VALID, чтобы не падать на них; join-group их по-прежнему не показывает — он берёт только 'free').
-- Выпущенные группы (graduated) остаются graduated, graduated_at сохраняется; вернуть — вручную в базе.
-- Заявки на удаление (data_deletion_requests) удаляются вместе с таблицей.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
begin;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-graduates';
  end if;
end $$;

drop function public.graduates_cleanup();
drop function public.sysadmin_erase_student(text);
drop function public.resolve_data_deletion(uuid, boolean, text);
drop function public.data_deletion_requests_list(uuid);
drop function public.withdraw_data_deletion();
drop function public.my_data_deletion();
drop function public.request_data_deletion(uuid);
drop function public._erase_student(uuid, text);
drop function public._delete_accounts(uuid[]);

drop trigger erased_student_guard on public.absences;
drop trigger erased_student_guard on public.grades;
drop trigger erased_student_guard on public.certificates;
drop trigger erased_student_guard on public.student_achievements;
drop function public.erased_student_guard();
drop trigger students_erased_freeze on public.students;
drop function public.students_erased_freeze();

drop table public.data_deletion_requests;

-- Статус группы: как в 20261110100000 (active | closed)
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

alter table public.students drop constraint students_claim_status_check;
alter table public.students add constraint students_claim_status_check
  check (claim_status in ('free', 'pending', 'active')) not valid;

alter table public.students drop column erased_at;
alter table public.groups drop column erased_at;

delete from supabase_migrations.schema_migrations where version = '20261111100000';

commit;
