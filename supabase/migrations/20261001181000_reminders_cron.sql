-- Ежедневный запуск рассылки напоминаний.
-- 06:00 UTC = 09:00 по Минску: в Беларуси круглый год UTC+3, перевода часов нет.
--
-- ВНИМАНИЕ. В этом файле нет самого секрета: он лежит в Vault под именем
-- cron_secret, а задание читает его оттуда. Когда накатываете миграцию
-- на новый проект, сначала положите секрет в Vault:
--
--   select vault.create_secret('<та же строка, что в CRON_SECRET у функции>',
--                              'cron_secret',
--                              'Заголовок x-cron-secret для send-reminders');
--
-- И подставьте адрес своего проекта в url ниже.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'journal-reminders',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
