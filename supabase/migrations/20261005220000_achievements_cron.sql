-- Ежечасный пересчёт достижений и рейтинга.
--
-- ВНИМАНИЕ. Самого секрета в этом файле нет: он лежит в Vault под именем
-- cron_secret — тот же, что уже используется для send-reminders. Если
-- накатываете миграцию на новый проект, сначала положите секрет в Vault:
--
--   select vault.create_secret('<та же строка, что в CRON_SECRET у функций>',
--                              'cron_secret',
--                              'Заголовок x-cron-secret для Edge Functions');
--
-- И подставьте адрес своего проекта в url ниже.
--
-- Раз в час в начале часа: чаще не нужно, пропуски вносит староста,
-- а свой прогресс студент и так видит сразу — его считает клиент.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('journal-achievements')
where exists (select 1 from cron.job where jobname = 'journal-achievements');

select cron.schedule(
  'journal-achievements',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/recalc-achievements',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
