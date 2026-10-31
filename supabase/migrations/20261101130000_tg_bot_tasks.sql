-- Telegram-бот для внесения домашки и дедлайнов: права, привязка аккаунта, состояние диалога, журнал.
--
-- Миграция только добавляет и повторный запуск ничего не меняет.
-- Задачи по-прежнему живут в data.json; здесь только «кому можно» и служебное состояние бота.
-- Таблицами бота пользуется Edge Function tg-bot под service_role; клиенту доступа нет,
-- кроме чтения своей привязки (чтобы кабинет мог показать «Telegram привязан»).

-- ===== Право вносить задачи =====
-- Флаг на обычном профиле, а не отдельная роль. Студент профиль только читает (grant select
-- и политика «свой профиль» из student_accounts), поэтому сам себе флаг не выставит.
-- Менять его умеет только Edge Function tg-set-task-editor после проверки токена админа.
alter table public.profiles add column if not exists can_post_tasks boolean not null default false;

-- ===== Привязка Telegram =====
create table if not exists public.tg_links (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  telegram_id bigint not null unique,
  linked_at   timestamptz not null default now()
);
alter table public.tg_links enable row level security;
revoke all on public.tg_links from anon, authenticated;
grant select on public.tg_links to authenticated;
drop policy if exists "Своя привязка Telegram: чтение" on public.tg_links;
create policy "Своя привязка Telegram: чтение" on public.tg_links
  for select to authenticated using ((select auth.uid()) = user_id);

-- Одноразовые коды привязки: хранится только sha-256 кода, живёт 10 минут.
create table if not exists public.tg_link_codes (
  code_hash  text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index if not exists tg_link_codes_user_idx on public.tg_link_codes (user_id);
alter table public.tg_link_codes enable row level security;
revoke all on public.tg_link_codes from anon, authenticated;

-- ===== Состояние диалога =====
-- Edge Function ничего не помнит между запросами, поэтому шаг и введённое лежат здесь.
-- Срок жизни (30 минут) проверяет функция по updated_at.
create table if not exists public.tg_dialog_state (
  telegram_id bigint primary key,
  step        text not null,
  payload     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.tg_dialog_state enable row level security;
revoke all on public.tg_dialog_state from anon, authenticated;

-- ===== Журнал действий бота =====
-- Для лимита (20 записей в час), списка «/мои» и разбора «кто это добавил».
-- Текстов задач тут нет: они только в data.json. link_fail — неудачные коды (защита от перебора).
create table if not exists public.tg_task_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users (id) on delete set null,
  telegram_id bigint not null,
  kind        text not null check (kind in ('homework', 'deadline', 'edit', 'delete', 'link_fail')),
  record_id   text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists tg_task_log_user_idx on public.tg_task_log (user_id, created_at desc);
create index if not exists tg_task_log_tg_idx on public.tg_task_log (telegram_id, kind, created_at desc);
alter table public.tg_task_log enable row level security;
revoke all on public.tg_task_log from anon, authenticated;

-- ===== Код привязки для вошедшего пользователя =====
-- Возвращает код вида ABCD-EFGH (8 символов без 0/O/1/I/L), действует 10 минут, одноразовый.
-- Прежние коды этого пользователя гасит. Открытым текстом код не хранится.
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
revoke all on function public.tg_create_link_code() from public, anon, authenticated;
grant execute on function public.tg_create_link_code() to authenticated;

-- Отвязать свой Telegram
create or replace function public.tg_unlink()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.tg_links where user_id = (select auth.uid());
  delete from public.tg_link_codes where user_id = (select auth.uid());
$$;
revoke all on function public.tg_unlink() from public, anon, authenticated;
grant execute on function public.tg_unlink() to authenticated;
