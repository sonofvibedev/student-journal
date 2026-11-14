-- Откат 2.1 п.2: лог активности и уведомления сисадмину убираются. Таблицы usage_events и sysadmin_prefs удаляются вместе с данными (это только журнал нажатий).
do $$ begin
  if to_regclass('cron.job') is not null then perform cron.unschedule(j.jobname) from cron.job j where j.jobname = 'journal-sysadmin-digest'; end if;
end $$;
drop trigger if exists client_events_usage_alert on public.client_events;
drop trigger if exists absence_cancellations_usage_alert on public.absence_cancellations;
drop trigger if exists audit_log_usage_alert on public.audit_log;
drop function if exists public.usage_error_alert();
drop function if exists public.usage_cancel_alert();
drop function if exists public.usage_audit_alert();
drop function if exists public.sysadmin_digest();
drop function if exists public.sysadmin_usage_people();
drop function if exists public.sysadmin_usage_log(uuid, text, text, date, date, text, int, int);
drop function if exists public.usage_log_batch(jsonb);
drop function if exists public.sysadmin_prefs_set(text, boolean);
drop function if exists public.sysadmin_prefs_get();
drop function if exists public._sys_alert(text, text, text, text);
drop table if exists public.sysadmin_prefs;
drop table if exists public.usage_events;
create or replace function public.ops_cleanup()
returns integer language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.client_events e where e.at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
delete from public.notifications where kind in ('sys_alert');
