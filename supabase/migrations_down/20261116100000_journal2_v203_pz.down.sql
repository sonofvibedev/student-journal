-- Откат 2.0.3: _lesson_kind_ru снова говорит «практическое» (тело из 20261113100000).
create or replace function public._lesson_kind_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'lecture' then 'лекция' when 'practice' then 'практическое' when 'lab' then 'лабораторная' end;
$$;
