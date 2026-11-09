-- Откат 20261114100000_journal2_v201_headman_edits_hw.sql
begin;
drop policy "Задания: правка старостой домашки студента" on public.tasks;
drop policy "Задания: удаление старостой домашки студента" on public.tasks;
drop function public.is_student_author(uuid, uuid);
delete from supabase_migrations.schema_migrations where version = '20261114100000';
commit;
