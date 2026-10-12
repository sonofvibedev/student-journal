-- Значки за рекорды в играх.
--
-- Обычные значки студент записывает себе сам: это личная отметка в своей
-- коллекции, и подделывать её незачем. Со значками за рекорды иначе — они
-- дают игровые очки и влияют на общий рейтинг игр, поэтому выдавать их может
-- только Edge Function submit-game-score под service_role, и только после
-- того, как она переиграла партию по зерну и признала результат честным.
--
-- Поэтому у кодов значков за рекорды есть приставка game_, а политика insert
-- для студента такие коды больше не пропускает. Остальные значки он
-- по-прежнему пишет сам.

drop policy if exists "Свои значки добавляются" on public.student_achievements;
create policy "Свои значки добавляются" on public.student_achievements
  for insert to authenticated
  with check (
    student_id = (select p.student_id from public.profiles p where p.user_id = (select auth.uid()))
    and code not like 'game\_%'
  );

-- ===== Рейтинг игровых очков =====
-- Очки лежат в каталоге значков на стороне страницы (games-core.js), поэтому
-- она и передаёт их сюда: codes — коды значков, points — очки за каждый, по
-- порядку. Наружу уходит student_id и сумма очков, но не то, какие именно
-- значки у человека есть.
--
-- Игровые очки к учебным баллам отношения не имеют: учебный рейтинг их не
-- видит и не считает.
create or replace function public.rpc_game_points(codes text[], points integer[])
returns table (student_id text, points integer)
language sql
security definer
set search_path = public
stable
as $$
  select sa.student_id, sum(w.points)::integer as points
    from public.student_achievements sa
    join unnest(codes, points) as w(code, points) on w.code = sa.code
   group by sa.student_id
   order by points desc, sa.student_id;
$$;

revoke all on function public.rpc_game_points(text[], integer[]) from public, anon;
grant execute on function public.rpc_game_points(text[], integer[]) to authenticated;
