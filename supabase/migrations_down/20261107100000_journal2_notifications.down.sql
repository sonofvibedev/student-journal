-- Откат 20261107100000_journal2_notifications.sql: БД возвращается к состоянию после 20261106100000.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
-- ВНИМАНИЕ: удаляет настройки уведомлений (notification_prefs), строки перепривязки (tg_rebind) и колонки очереди
-- Telegram в notifications (dedupe_key, tg_*). Сами уведомления, в том числе созданные notify_daily и триггером
-- порога деканата, остаются в колокольчике. Привязки, удалённые tg_reset_all, не восстанавливаются.
begin;

-- 1. cron
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobname) from cron.job j
      where j.jobname in ('journal-tg-dispatch', 'journal-schedule-nightly', 'journal-notify-daily');
  end if;
end $$;

-- 2. Триггеры и функции этапа 3
drop trigger absences_dean_notify on public.absences;
drop trigger notifications_dedupe on public.notifications;
drop function public.absences_dean_notify();
drop function public.notify_daily();
drop function public.tg_notification_done(uuid, boolean, text);
drop function public.tg_claim_notifications(int);
drop function public.tg_rebind_dismiss();
drop function public.tg_reset_all();
drop function public.notifications_dedupe();

-- 3. Таблицы (политики уходят вместе с ними)
drop table public.tg_rebind, public.notification_prefs;

-- 4. notifications: колонки очереди (индекс и ограничения уходят вместе с колонками)
alter table public.notifications
  drop column dedupe_key, drop column tg_status, drop column tg_sent_at,
  drop column tg_attempts, drop column tg_claimed_at, drop column tg_error;

-- 5. tg_create_link_code — прежний текст (20261103130000_maintenance_mode.sql)
create or replace function public.tg_create_link_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  uid  uuid := (select auth.uid());
  raw  text := '';
  b    bytea;
  i    int;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.app_open() then
    raise exception 'maintenance' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where user_id = uid) then
    raise exception 'no_profile';
  end if;
  b := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    raw := raw || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  delete from public.tg_link_codes where user_id = uid or expires_at < now() - interval '1 day';
  insert into public.tg_link_codes (code_hash, user_id, expires_at)
    values (encode(extensions.digest(raw, 'sha256'), 'hex'), uid, now() + interval '10 minutes');
  return substr(raw, 1, 4) || '-' || substr(raw, 5, 4);
end;
$$;

-- 6. Запись о миграции: иначе db push не применит её повторно
delete from supabase_migrations.schema_migrations where version = '20261107100000';

commit;
