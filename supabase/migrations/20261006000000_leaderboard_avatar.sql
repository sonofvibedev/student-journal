-- Аватарки в рейтинге.
--
-- Файл аватарки лежит в бакете avatars под именем <user_id>.jpg, а в рейтинге
-- есть только student_id. Сопоставить одно с другим через profiles не выйдет:
-- политика «Студент читает свой профиль» отдаёт лишь свою строку, поэтому
-- у всех, кроме себя, оставались инициалы.
--
-- Открывать profiles всей группе ради картинок — плохой размен: таблица
-- связывает user_id с логином. Вместо этого сервер кладёт user_id прямо
-- в рейтинг, а rpc_leaderboard() его возвращает. Наружу уходит только
-- непредсказуемый UUID; сами файлы и так читает любой вошедший по уже
-- существующей политике бакета.

alter table public.leaderboard add column if not exists user_id uuid;

-- Набор колонок в возвращаемой таблице меняется, поэтому функцию пересоздаём
drop function if exists public.rpc_leaderboard(text);

create function public.rpc_leaderboard(p_semester text default null)
returns table (place integer, student_id text, user_id uuid, points integer, badges_count integer)
language sql
security definer
set search_path = public
stable
as $$
  select l.place, l.student_id, l.user_id, l.points, l.badges_count
  from public.leaderboard l
  where l.semester = coalesce(p_semester, (select max(l2.semester) from public.leaderboard l2))
  order by l.place, l.student_id;
$$;

revoke all on function public.rpc_leaderboard(text) from public, anon;
grant execute on function public.rpc_leaderboard(text) to authenticated;
