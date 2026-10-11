-- Рекорды игр и рейтинги.
--
-- Три игры: судоку, сапёр и flappy. У судоку и сапёра рекорд — лучшее время
-- в секундах (меньше лучше), у flappy — число пройденных труб (больше лучше).
--
-- Записывает рекорды только Edge Function submit-game-score под service_role:
-- она переигрывает партию по зерну и ходам и сверяет результат. Поэтому у
-- таблицы нет политик insert, update и delete — ни студент, ни админ не может
-- вписать результат напрямую или поставить рекорд за другого.
--
-- Читать рейтинг может любой вошедший студент: в таблице нет ничего личного,
-- кроме student_id, а ФИО подставляет страница из data.json.

create table if not exists public.game_records (
  id         bigint generated always as identity primary key,
  student_id text        not null,
  game       text        not null check (game in ('sudoku', 'minesweeper', 'flappy')),
  difficulty text        not null check (difficulty in ('easy', 'medium', 'hard', 'none')),
  score      integer     not null check (score >= 0),   -- секунды или трубы
  proof      jsonb       not null default '{}'::jsonb,  -- зерно и ходы проверенной партии
  played_at  timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- У студента один рекорд на игру и сложность — лучший
create unique index if not exists game_records_unique
  on public.game_records (student_id, game, difficulty);
create index if not exists game_records_board on public.game_records (game, difficulty, score);

alter table public.game_records enable row level security;

-- Рейтинг виден всем вошедшим
drop policy if exists "Рекорды видны вошедшим" on public.game_records;
create policy "Рекорды видны вошедшим" on public.game_records
  for select to authenticated using (true);

-- Политик insert/update/delete нет: пишет только service_role (Edge Function)

-- ===== Рейтинг достижений =====
-- Значки студента видны только ему (политика в миграции достижений), поэтому
-- общий счёт отдаёт функция: наружу уходит student_id и число значков, но не
-- то, какие именно значки у человека есть.
-- exclude_codes — коды антидостижений: их в общий счёт не берём, их список
-- живёт в achievements.js на стороне страницы.
create or replace function public.rpc_ach_board(exclude_codes text[] default '{}')
returns table (student_id text, badges integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, count(*)::integer as badges
    from public.student_achievements sa
   where not (sa.code = any (coalesce(exclude_codes, '{}')))
   group by sa.student_id
   order by badges desc, sa.student_id;
$$;

revoke all on function public.rpc_ach_board(text[]) from public, anon;
grant execute on function public.rpc_ach_board(text[]) to authenticated;
