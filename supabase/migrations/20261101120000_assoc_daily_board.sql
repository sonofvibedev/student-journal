-- «Ассоциации»: таблица за календарный день и общий зачёт.
--
-- Очки за «Слово дня» считаются за сутки по Минску (word_attempts.day уже
-- хранит минскую дату): каждый день таблица начинается с нуля. В общий зачёт
-- идут только бонусы за топ-3 дня; сколько дают за место — лежит в
-- assoc_settings и меняется без кода. Итоги дня подводит finalize_assoc_day:
-- сама по cron в 00:00 по Минску (21:00 UTC) и только за вчерашний день.
-- Прошлые дни задним числом не пересчитываются; месячный rpc_assoc_board
-- остаётся как есть, чтобы старый клиент не падал.

-- ===== Сколько очков в общий зачёт за место =====
-- Число строк = число призовых мест. Хотите топ-5 — добавьте строки 4 и 5.
create table if not exists public.assoc_settings (
  place integer primary key check (place > 0),
  bonus integer not null check (bonus >= 0)
);
insert into public.assoc_settings (place, bonus) values (1, 3), (2, 2), (3, 1)
on conflict (place) do nothing;

alter table public.assoc_settings enable row level security;
revoke all on public.assoc_settings from anon;
revoke insert, update, delete, truncate on public.assoc_settings from authenticated;
drop policy if exists "Бонусы видят вошедшие" on public.assoc_settings;
create policy "Бонусы видят вошедшие" on public.assoc_settings
  for select to authenticated using (true);

-- ===== Итоги дней: призёры и их бонус =====
-- bonus хранится на момент подведения итогов: правка assoc_settings историю
-- не меняет. Уникальность «день + студент» и «день + место» делает повторный
-- запуск безвредным.
create table if not exists public.assoc_daily_results (
  day         date        not null,
  student_id  text        not null,
  place       integer     not null check (place > 0),
  points      integer     not null check (points >= 0),
  bonus       integer     not null check (bonus >= 0),
  finished_at timestamptz not null,
  primary key (day, student_id),
  unique (day, place)
);

alter table public.assoc_daily_results enable row level security;
revoke all on public.assoc_daily_results from anon;
revoke insert, update, delete, truncate on public.assoc_daily_results from authenticated;
drop policy if exists "Итоги дней видят вошедшие" on public.assoc_daily_results;
create policy "Итоги дней видят вошедшие" on public.assoc_daily_results
  for select to authenticated using (true);

-- ===== Подведение итогов дня =====
-- Ранжирует угаданные слова дня из word_attempts (режим 'ranks', как и
-- месячный рейтинг): больше очков — выше, при равенстве выше тот, кто
-- закончил раньше (updated_at завершённой попытки больше не меняется), затем
-- student_id для детерминированности. Пишет топ по числу строк assoc_settings.
-- Текущий и будущие дни не подводит. Возвращает, сколько строк добавлено.
create or replace function public.finalize_assoc_day(p_day date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_day is null or p_day >= (now() at time zone 'Europe/Minsk')::date then
    return 0;
  end if;

  insert into public.assoc_daily_results (day, student_id, place, points, bonus, finished_at)
  select p_day, r.student_id, r.place, r.points, s.bonus, r.finished_at
    from (
      select wa.student_id,
             wa.points,
             wa.updated_at as finished_at,
             row_number() over (order by wa.points desc, wa.updated_at asc, wa.student_id asc)::integer as place
        from public.word_attempts wa
       where wa.day = p_day
         and wa.mode = 'ranks'
         and wa.solved
         and wa.points > 0
    ) r
    join public.assoc_settings s on s.place = r.place
  on conflict do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.finalize_assoc_day(date) from public, anon, authenticated;
grant execute on function public.finalize_assoc_day(date) to service_role;

-- ===== Таблица за день =====
-- По умолчанию сегодняшний день по Минску. place и bonus — за что играют:
-- у подведённого дня берётся записанный бонус, у идущего — по настройкам.
drop function if exists public.rpc_assoc_day_board(date);
create or replace function public.rpc_assoc_day_board(p_day date default null)
returns table (student_id text, place integer, points integer, tries integer, finished_at timestamptz, bonus integer)
language sql
security definer
set search_path = public
stable
as $$
  with d as (select coalesce(p_day, (now() at time zone 'Europe/Minsk')::date) as day),
  ranked as (
    select wa.student_id, wa.points, wa.tries, wa.updated_at as finished_at,
           row_number() over (order by wa.points desc, wa.updated_at asc, wa.student_id asc)::integer as place
      from public.word_attempts wa, d
     where wa.day = d.day and wa.mode = 'ranks' and wa.solved and wa.points > 0
  )
  select r.student_id, r.place, r.points, r.tries, r.finished_at,
         coalesce(res.bonus, s.bonus, 0) as bonus
    from ranked r
    cross join d
    left join public.assoc_daily_results res on res.day = d.day and res.student_id = r.student_id
    left join public.assoc_settings s on s.place = r.place
   order by r.place;
$$;

revoke all on function public.rpc_assoc_day_board(date) from public, anon;
grant execute on function public.rpc_assoc_day_board(date) to authenticated;

-- ===== Общий зачёт: за всё время =====
-- Сумма бонусов за подведённые дни. При равенстве выше тот, у кого больше
-- первых мест, затем вторых, затем больше призовых дней.
drop function if exists public.rpc_assoc_total_board();
create or replace function public.rpc_assoc_total_board()
returns table (student_id text, bonus integer, wins integer, days integer)
language sql
security definer
set search_path = public
stable
as $$
  select r.student_id,
         sum(r.bonus)::integer as bonus,
         count(*) filter (where r.place = 1)::integer as wins,
         count(*)::integer as days
    from public.assoc_daily_results r
   group by r.student_id
  having sum(r.bonus) > 0
   order by bonus desc, wins desc, count(*) filter (where r.place = 2) desc, days desc, r.student_id;
$$;

revoke all on function public.rpc_assoc_total_board() from public, anon;
grant execute on function public.rpc_assoc_total_board() to authenticated;

-- ===== Ежедневный запуск =====
-- 21:00 UTC = 00:00 по Минску (UTC+3 круглый год): к этому моменту по Минску
-- уже новый день, подводим вчерашний. Старые дни не трогаем: backfill нет.
-- pg_cron уже подключён миграцией reminders_cron; без него задание не ставится.
do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'assoc-daily-finalize') then
      perform cron.unschedule('assoc-daily-finalize');
    end if;
    perform cron.schedule(
      'assoc-daily-finalize',
      '0 21 * * *',
      $cron$select public.finalize_assoc_day(((now() at time zone 'Europe/Minsk')::date - 1))$cron$
    );
  end if;
end $$;
