-- «Слово дня» автоматически: пул слов, откуда берётся слово, источник записи и настройки.
--
-- Аддитивная и идемпотентная: существующие таблицы не меняются, кроме одной новой колонки
-- word_daily.source (старые строки получают 'manual'). Пул заполняет функция word-auto из
-- индекса рейтингов (бакет assoc-ranks), поэтому здесь он пустой.
-- Все три таблицы (word_pool, word_settings и уже существующие word_bank, word_daily) закрыты
-- от anon и authenticated: доступ только у service_role, то есть у Edge Functions
-- word-auto, word-of-day и word-admin (админ определяется там по токену GitHub).

-- ===== Откуда запись о слове дня =====
alter table public.word_daily
  add column if not exists source text not null default 'manual';
alter table public.word_daily drop constraint if exists word_daily_source_check;
alter table public.word_daily
  add constraint word_daily_source_check check (source in ('auto', 'manual'));

-- ===== Пул слов =====
-- Слово — то же, что в индексе рейтингов (out/index.json.gz); status 'disabled' выводит его из выбора.
create table if not exists public.word_pool (
  word      text primary key,
  status    text        not null default 'enabled' check (status in ('enabled', 'disabled')),
  last_used date,
  added_at  timestamptz not null default now()
);
create index if not exists word_pool_pick_idx on public.word_pool (status, last_used);

-- ===== Необязательные опции (по умолчанию выключены: строки нет — значит false) =====
--   notify_admin_telegram — присылать слово админу в Telegram в 00:00
--   allow_reroll          — разрешить замену слова текущего дня до первого ответа игроков
create table if not exists public.word_settings (
  key   text  primary key,
  value jsonb not null default 'false'::jsonb
);

alter table public.word_pool enable row level security;
alter table public.word_settings enable row level security;
alter table public.word_bank enable row level security;
alter table public.word_daily enable row level security;
revoke all on public.word_pool, public.word_settings from anon, authenticated;
revoke all on public.word_bank, public.word_daily from anon, authenticated;

-- ===== Ежедневный запуск в 00:00 по Минску =====
-- 21:00 UTC = 00:00 по Минску: в Беларуси круглый год UTC+3, перевода часов нет.
-- word-auto сначала подводит итоги прошлого дня (finalize_assoc_day), потом ставит новое слово.
-- Секрет x-cron-secret берётся из Vault (cron_secret) — тот же, что у send-reminders
-- (см. 20261001181000_reminders_cron.sql); в файле его нет. Адрес проекта — ваш.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'journal-word-auto') then
      perform cron.unschedule('journal-word-auto');
    end if;
    perform cron.schedule(
      'journal-word-auto',
      '0 21 * * *',
      $job$
      select net.http_post(
        url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/word-auto',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
      $job$
    );
  end if;
end $$;
