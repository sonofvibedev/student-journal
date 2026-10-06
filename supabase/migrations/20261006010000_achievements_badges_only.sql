-- Достижения без баллов и рейтинга: остаются только значки.
--
-- Что изменилось в замысле. Рейтинга группы больше нет, соревнования нет —
-- значит и подделывать нечего. Поэтому серверный пересчёт (Edge Function
-- recalc-achievements, ежечасный cron и зеркала data.json) не нужен:
-- достижение засчитывает сам клиент и записывает его себе.
--
-- Что остаётся:
--   app_events           — что студент сделал в приложении;
--   student_achievements — выданные значки с датой, уже накопленные строки целы.
--
-- Что уходит:
--   leaderboard и rpc_leaderboard() — рейтинга нет, а таблица хранила
--                                     неуважительные часы всей группы;
--   journal_absences, journal_homework — зеркала data.json, нужны были
--                                        только серверному пересчёту;
--   achievement_catalog — справочник значков с баллами. Теперь каталог живёт
--                         в achievements.js: подписи нужны экрану сразу и
--                         без сети, а серверу сверять их больше не с чем.
--
-- Файл самодостаточный: на чистом проекте он создаёт обе таблицы, на рабочем
-- (где их уже создала миграция 1.4) — только убирает лишнее.

-- ===== Ежечасный пересчёт больше не нужен =====
-- На чистом проекте pg_cron может быть не установлен, поэтому через to_regclass
do $$
begin
  if to_regclass('cron.job') is not null
     and exists (select 1 from cron.job where jobname = 'journal-achievements') then
    perform cron.unschedule('journal-achievements');
  end if;
end $$;

-- ===== События приложения: что студент сделал сам =====
create table if not exists public.app_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  student_id text not null,
  kind       text not null check (kind in (
               'first_login', 'avatar_set', 'pass_opened',
               'whats_new_read', 'notifications_on', 'homework_done')),
  ref        text not null default '',                 -- id домашки или номер версии
  created_at timestamptz not null default now()
);

-- Одно событие одного вида на один ref: домашку нельзя отметить дважды
create unique index if not exists app_events_unique on public.app_events (user_id, kind, ref);
create index if not exists app_events_student on public.app_events (student_id, kind);

-- user_id и student_id ставит база, а не клиент: подставить чужие не получится
create or replace function public.app_events_fill_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  if new.user_id is null then
    raise exception 'app_events: нет вошедшего пользователя';
  end if;
  select p.student_id into new.student_id from public.profiles p where p.user_id = new.user_id;
  if new.student_id is null then
    raise exception 'app_events: у пользователя нет профиля';
  end if;
  return new;
end;
$$;

-- Функция нужна только триггеру. Без revoke она торчит наружу как
-- /rest/v1/rpc/app_events_fill_owner — лишняя точка входа с правами владельца.
revoke all on function public.app_events_fill_owner() from public, anon, authenticated;

drop trigger if exists app_events_before_insert on public.app_events;
create trigger app_events_before_insert
  before insert on public.app_events
  for each row execute function public.app_events_fill_owner();

alter table public.app_events enable row level security;

drop policy if exists "Свои события видны" on public.app_events;
create policy "Свои события видны" on public.app_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Раньше «Сделано» сверялось с зеркалом journal_homework. Зеркала нет, а
-- проверять id задания из data.json базе нечем: остаётся только «своё».
drop policy if exists "Свои события добавляются" on public.app_events;
create policy "Свои события добавляются" on public.app_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Снять галочку «Сделано» можно, остальные события не удаляются
drop policy if exists "Отметку о домашке можно снять" on public.app_events;
create policy "Отметку о домашке можно снять" on public.app_events
  for delete to authenticated
  using (user_id = (select auth.uid()) and kind = 'homework_done');

-- Политики update нет: изменить событие нельзя никому, кроме service_role

-- ===== Выданные значки =====
create table if not exists public.student_achievements (
  id         bigint generated always as identity primary key,
  student_id text    not null,
  code       text    not null,
  period     text    not null default '',              -- '' или '2026-10' у повторяемых
  semester   text    not null,
  earned_at  timestamptz not null default now()
);

-- Баллов нет, а код значка сверять больше не с чем: каталог в achievements.js
alter table public.student_achievements drop column if exists points;
alter table public.student_achievements drop constraint if exists student_achievements_code_fkey;

create unique index if not exists student_achievements_unique
  on public.student_achievements (student_id, code, period);
create index if not exists student_achievements_student on public.student_achievements (student_id, semester);

alter table public.student_achievements enable row level security;

-- Студент видит только свои значки: иначе чужие антидостижения были бы видны
drop policy if exists "Свои значки видны" on public.student_achievements;
create policy "Свои значки видны" on public.student_achievements
  for select to authenticated
  using (student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid())));

-- Раньше значки выдавал сервер под service_role: иначе рейтинг можно было бы
-- проставить себе из консоли. Рейтинга больше нет, значок — личная отметка
-- в своей коллекции, поэтому запись открыта владельцу.
-- Чужую строку не вставить: student_id сверяется с profiles.
-- Изменить или удалить выданный значок по-прежнему нельзя никому, кроме сервера.
drop policy if exists "Свои значки добавляются" on public.student_achievements;
create policy "Свои значки добавляются" on public.student_achievements
  for insert to authenticated
  with check (student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid())));

-- ===== Рейтинг, зеркала и справочник больше не нужны =====
drop function if exists public.rpc_leaderboard(text);
drop table if exists public.leaderboard;
drop table if exists public.journal_absences;
drop table if exists public.journal_homework;
drop table if exists public.achievement_catalog;
