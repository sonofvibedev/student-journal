-- Личные данные группы: список студентов (ФИО, роль, Telegram) и пропуски.
-- Раньше лежали в открытом data.json, и их мог прочитать кто угодно по прямой ссылке.
-- Теперь читают только вошедшие студенты группы (есть строка в profiles).
-- Пишет только Edge Function journal-save (секретный ключ) после проверки GitHub-токена админа.
--
-- Одна строка с двумя jsonb: админка и раньше сохраняла весь список целиком.
-- ponytail: последнее сохранение побеждает, как и с data.json; если админов станет много,
-- нужны строки на каждый пропуск или проверка updated_at перед записью.
create table public.journal_private (
  id         text primary key default 'main' check (id = 'main'),
  students   jsonb not null default '[]'::jsonb check (jsonb_typeof(students) = 'array'),
  absences   jsonb not null default '[]'::jsonb check (jsonb_typeof(absences) = 'array'),
  updated_at timestamptz not null default now()
);
alter table public.journal_private enable row level security;
revoke all on public.journal_private from anon, authenticated;
grant select on public.journal_private to authenticated;

create policy "Студент группы читает журнал" on public.journal_private
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid())));

insert into public.journal_private (id) values ('main');
