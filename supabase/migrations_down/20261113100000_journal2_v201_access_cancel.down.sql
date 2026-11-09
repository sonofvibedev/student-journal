-- Откат 20261113100000_journal2_v201_access_cancel.sql: БД возвращается к состоянию после 20261112100000.
-- Удаляются вместе с таблицами: след отмен пропусков (absence_cancellations) и выданные права на домашку
-- (homework_editors). Задания, внесённые студентами, остаются (created_by — студент). Записи homework_access_set
-- в audit_log остаются.
-- Пропуски по лабораторным: lesson_kind = 'lab' → null (иначе прежний check не встанет); число строк — в notice.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
begin;

drop policy "Задания: внесение студентом с доступом" on public.tasks;
drop policy "Задания: изменение студентом с доступом" on public.tasks;
drop policy "Задания: удаление студентом с доступом" on public.tasks;

drop trigger absences_log_cancel on public.absences;
drop trigger students_erased_v201_cleanup on public.students;
drop function public.absences_log_cancel();
drop function public.students_erased_v201_cleanup();
drop function public.homework_access_set(text, boolean);
drop function public.can_add_homework(uuid);

drop table public.homework_editors;
drop table public.absence_cancellations;

do $$
declare n int;
begin
  update public.absences set lesson_kind = null where lesson_kind = 'lab';
  get diagnostics n = row_count;
  raise notice 'absences: lesson_kind lab → null, строк: %', n;
end $$;
alter table public.absences drop constraint absences_lesson_kind_check;
alter table public.absences add constraint absences_lesson_kind_check check (lesson_kind in ('lecture', 'practice'));

create or replace function public._lesson_kind_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'lecture' then 'лекция' when 'practice' then 'практическое' end;
$$;

delete from supabase_migrations.schema_migrations where version = '20261113100000';

commit;
