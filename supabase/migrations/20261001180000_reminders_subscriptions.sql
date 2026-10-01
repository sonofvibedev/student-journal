-- Напоминания о дедлайнах и домашке: кому и куда слать.
-- Сами дедлайны и домашка остаются в data.json — в базе только подписки.

-- Подписки Web Push. Студент видит и меняет только свои строки;
-- рассылка читает их из Edge Function секретным ключом в обход RLS.
create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create policy "Своя подписка: чтение" on public.push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Своя подписка: добавление" on public.push_subscriptions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Своя подписка: обновление" on public.push_subscriptions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Своя подписка: удаление" on public.push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Получатели сообщений от бота. Пишет только Edge Function subscribe-telegram
-- после проверки подписи initData: клиенту доступа к таблице нет.
create table public.tg_subscribers (
  id         bigint generated always as identity primary key,
  chat_id    bigint not null unique,
  tg_user_id bigint,
  tg_name    text,
  created_at timestamptz not null default now()
);
alter table public.tg_subscribers enable row level security;
revoke all on public.tg_subscribers from anon, authenticated;

-- Что уже отправлено: защита от повторов, если рассылка запустится дважды.
create table public.notify_log (
  id      bigint generated always as identity primary key,
  item_id text not null,
  stage   text not null check (stage in ('day1', 'due')),
  target  text not null,
  sent_at timestamptz not null default now(),
  unique (item_id, stage, target)
);
create index notify_log_sent_idx on public.notify_log (sent_at);
alter table public.notify_log enable row level security;
revoke all on public.notify_log from anon, authenticated;
