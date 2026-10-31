-- Отметка «выполнено» у дедлайнов — на всех устройствах студента.
--
-- Домашка уже хранит отметку в app_events (kind = 'homework_done'). Дедлайны
-- ведут себя так же: kind = 'deadline_done', ref = id дедлайна из data.json.
-- Значков и очков за это событие нет — оно нужно только для синхронизации.
--
-- Миграция только добавляет: новый вид события и право снять свою отметку.
-- Данные не трогаются, повторный запуск ничего не меняет.

-- ===== Допустимые виды событий =====
-- Старые виды: first_login, avatar_set, pass_opened, whats_new_read,
-- notifications_on, homework_done (миграция 20261006010000). Другие миграции
-- app_events не меняли. Прежнее ограничение ищем по определению, а не по имени:
-- на боевой базе оно могло получить другое имя.
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.app_events'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.app_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.app_events
  add constraint app_events_kind_check check (kind in (
    'first_login', 'avatar_set', 'pass_opened',
    'whats_new_read', 'notifications_on', 'homework_done',
    'deadline_done'));

-- ===== Снять отметку можно у домашки и у дедлайна =====
-- Остальные события по-прежнему не удаляются
drop policy if exists "Отметку о домашке можно снять" on public.app_events;
create policy "Отметку о домашке можно снять" on public.app_events
  for delete to authenticated
  using (user_id = (select auth.uid()) and kind in ('homework_done', 'deadline_done'));
