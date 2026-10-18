-- «Ассоциации»: слова, слово дня и попытки студентов.
--
-- Загаданное слово, его подсказки и список допустимых ответов — секрет: пока
-- попытка не окончена, студент не должен увидеть ни ответа, ни подсказок
-- вперёд. Поэтому у word_bank и word_daily RLS включён, политик нет, а права
-- у anon и authenticated отозваны: читать и писать их может только
-- service_role, то есть Edge Functions word-of-day и word-admin.
--
-- Слова придумывает администратор журнала в админ-панели. Набор для
-- тренировки лежит там же, но секретом не является — просто отдаётся той же
-- функцией, чтобы ответы и подсказки не копировались в код страницы.

create table if not exists public.word_bank (
  id         bigint generated always as identity primary key,
  kind       text        not null check (kind in ('daily', 'train')),
  word       text        not null,
  -- Шесть подсказок от далёкой к близкой
  hints      text[]      not null check (array_length(hints, 1) = 6),
  -- Синонимы и прочие допустимые ответы; само слово тоже принимается
  answers    text[]      not null default '{}',
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists word_bank_kind_idx on public.word_bank (kind, id);

alter table public.word_bank enable row level security;
revoke all on public.word_bank from anon, authenticated;

-- Слово дня: одно на дату и на всю группу
create table if not exists public.word_daily (
  day        date   primary key,
  word_id    bigint not null references public.word_bank (id) on delete cascade,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.word_daily enable row level security;
revoke all on public.word_daily from anon, authenticated;

-- Попытка студента за день. Одна строка на студента и дату — уникальный
-- индекс не даст сыграть «Слово дня» второй раз за те же сутки.
create table if not exists public.word_attempts (
  id         bigint generated always as identity primary key,
  student_id text        not null,
  day        date        not null,
  hint       integer     not null default 1 check (hint between 1 and 6),
  letter     boolean     not null default false,   -- открыта ли первая буква
  solved     boolean     not null default false,
  finished   boolean     not null default false,
  points     integer     not null default 0 check (points >= 0),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists word_attempts_once
  on public.word_attempts (student_id, day);
create index if not exists word_attempts_month
  on public.word_attempts (day, student_id);

alter table public.word_attempts enable row level security;

-- Свою попытку студент видит (в ней нет ни слова, ни подсказок — только его
-- собственный счёт). Писать в таблицу он не может: политик insert, update и
-- delete нет, строки создаёт Edge Function под service_role.
drop policy if exists "Своя попытка видна" on public.word_attempts;
create policy "Своя попытка видна" on public.word_attempts
  for select to authenticated
  using (student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid())));

-- ===== Месячный рейтинг «Ассоциаций» =====
-- Сумма очков с 1-го числа текущего месяца: 1-го числа рейтинг начинается
-- заново сам собой, потому что считается только текущий месяц.
-- Наружу уходит student_id, сумма очков и число угаданных дней.
create or replace function public.rpc_assoc_board(p_day date default null)
returns table (student_id text, points integer, days integer)
language sql
security definer
set search_path = public
stable
as $$
  select wa.student_id,
         sum(wa.points)::integer as points,
         count(*) filter (where wa.solved)::integer as days
    from public.word_attempts wa
   where wa.day >= date_trunc('month', coalesce(p_day, current_date))::date
     and wa.day <  (date_trunc('month', coalesce(p_day, current_date)) + interval '1 month')::date
   group by wa.student_id
  having sum(wa.points) > 0
   order by points desc, days desc, wa.student_id;
$$;

revoke all on function public.rpc_assoc_board(date) from public, anon;
grant execute on function public.rpc_assoc_board(date) to authenticated;
