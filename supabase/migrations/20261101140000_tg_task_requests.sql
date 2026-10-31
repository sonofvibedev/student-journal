-- Заявки от редакторов на проверку админом (Telegram-бот) и журнал решений.
--
-- Редактор в боте не пишет в data.json сам: создаётся заявка (pending), админ её одобряет
-- или отклоняет, и только после одобрения функция вносит запись в data.json.
-- Миграция только добавляет (миграция 20261101130000 не тронута) и безопасна для повторного запуска.
--
-- Доступ: таблицы закрыты для anon и authenticated; всё делают Edge Functions tg-bot и tg-requests
-- под service_role. Исключение — автор может ЧИТАТЬ свои заявки (на случай кабинета), менять — нет:
-- права insert/update/delete у authenticated отозваны, статус меняется только условным UPDATE
-- из функции (pending → approving → approved и т. д., см. TRANSITIONS в _shared/tgbot.ts).

create table if not exists public.tg_task_requests (
  id                  uuid primary key default gen_random_uuid(),
  author_user_id      uuid references auth.users (id) on delete set null,
  author_student_id   text not null,
  kind                text not null check (kind in ('homework', 'deadline')),
  subtype             text check (subtype is null or subtype in ('ПЗ', 'УСР')),
  subject             text not null check (char_length(subject) between 1 and 200),
  due_date            date not null,
  text                text not null check (char_length(text) between 1 and 500),
  status              text not null default 'pending'
                      check (status in ('pending', 'approving', 'approved', 'rejected', 'withdrawn', 'expired')),
  reject_reason       text check (reject_reason is null or char_length(reject_reason) <= 300),
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,                 -- для approving: когда началось внесение
  decided_by          text,                        -- 'tg:<id>' или 'web'
  admin_message_refs  jsonb not null default '[]'::jsonb check (jsonb_typeof(admin_message_refs) = 'array'),
  record_id           text                         -- id записи в data.json; назначается при «Одобрить»
);
-- Выборка ожидающих (для лимита, /мои, списка в вебе и истечения)
create index if not exists tg_task_requests_pending_idx on public.tg_task_requests (author_student_id, created_at)
  where status = 'pending';
create index if not exists tg_task_requests_status_idx on public.tg_task_requests (status, created_at desc);

alter table public.tg_task_requests enable row level security;
revoke all on public.tg_task_requests from anon, authenticated;
grant select on public.tg_task_requests to authenticated;
drop policy if exists "Свои заявки: чтение" on public.tg_task_requests;
create policy "Свои заявки: чтение" on public.tg_task_requests
  for select to authenticated using ((select auth.uid()) = author_user_id);

-- ===== Журнал решений =====
create table if not exists public.tg_action_log (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in
                  ('request_created', 'approved', 'rejected', 'withdrawn', 'expired', 'admin_direct', 'approve_failed')),
  actor         text,                              -- 'tg:<id>', 'web' или 'system'
  actor_user_id uuid references auth.users (id) on delete set null,
  request_id    uuid,
  record_id     text,
  ts            timestamptz not null default now()
);
create index if not exists tg_action_log_req_idx on public.tg_action_log (request_id);
create index if not exists tg_action_log_ts_idx on public.tg_action_log (ts desc);
alter table public.tg_action_log enable row level security;
revoke all on public.tg_action_log from anon, authenticated;

-- ===== Создание заявки с лимитом =====
-- Не больше p_max неразобранных заявок на автора. Считаем и вставляем под блокировкой автора,
-- чтобы две одновременные заявки не проскочили лимит. Вызывает только service_role.
create or replace function public.tg_submit_request(
  p_user uuid, p_student text, p_kind text, p_subtype text,
  p_subject text, p_due date, p_text text, p_max int default 5
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('tg_req:' || p_student));
  if (select count(*) from public.tg_task_requests
       where author_student_id = p_student and status = 'pending') >= p_max then
    raise exception 'too_many_pending';
  end if;
  insert into public.tg_task_requests
    (author_user_id, author_student_id, kind, subtype, subject, due_date, text)
    values (p_user, p_student, p_kind, p_subtype, p_subject, p_due, p_text)
    returning id into new_id;
  insert into public.tg_action_log (kind, actor, actor_user_id, request_id)
    values ('request_created', 'user', p_user, new_id);
  return new_id;
end;
$$;
revoke all on function public.tg_submit_request(uuid, text, text, text, text, date, text, int)
  from public, anon, authenticated;
grant execute on function public.tg_submit_request(uuid, text, text, text, text, date, text, int) to service_role;

-- ===== Ежедневное истечение заявок =====
-- Заявки без решения 7 суток закрывает функция tg-requests (действие cron-expire) и сообщает авторам.
-- Кроме этого, истечение «ленивое»: бот и веб-раздел закрывают просроченные при каждом обращении.
-- 06:10 UTC = 09:10 по Минску. Секрет x-cron-secret берётся из Vault (cron_secret) — тот же, что у
-- send-reminders (см. 20261001181000_reminders_cron.sql); в файле его нет. Адрес проекта — ваш.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'journal-tg-requests-expire',
  '10 6 * * *',
  $$
  select net.http_post(
    url := 'https://woiqekpuoddxixlrbvkp.supabase.co/functions/v1/tg-requests',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{"action":"cron-expire"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
