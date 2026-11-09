-- Журнал 2.0.1: староста/заместитель правит и удаляет домашки, которые внесли студенты с доступом.
-- Только новые политики и функция. Задания преподавателей по-прежнему не меняются: правка только там, где автор — активный студент группы.
-- Откат: supabase/migrations_down/20261114100000_journal2_v201_headman_edits_hw.down.sql.

-- Автор u — active-студент группы g (security definer: memberships читаются в обход RLS)
create function public.is_student_author(g uuid, u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select u is not null and exists (
    select 1 from public.memberships m
     where m.user_id = u and m.group_id = g and m.status = 'active' and m.base_role = 'student');
$$;
revoke all on function public.is_student_author(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_student_author(uuid, uuid) to authenticated, service_role;

create policy "Задания: правка старостой домашки студента" on public.tasks for update to authenticated
  using (public.is_group_staff(group_id) and kind = 'homework' and public.is_student_author(group_id, created_by))
  with check (public.is_group_staff(group_id) and public.group_open(group_id) and kind = 'homework'
              and public.is_student_author(group_id, created_by));
create policy "Задания: удаление старостой домашки студента" on public.tasks for delete to authenticated
  using (public.is_group_staff(group_id) and public.group_open(group_id) and kind = 'homework'
         and public.is_student_author(group_id, created_by));
