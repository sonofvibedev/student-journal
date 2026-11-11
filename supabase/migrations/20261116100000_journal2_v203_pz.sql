-- Журнал 2.0.3: в серверных текстах (уведомления о пропусках) вид занятия «практическое» называется «ПЗ».
-- Меняется только тело _lesson_kind_ru; сигнатура, права (закрыта для клиентов) и данные не затрагиваются.
-- Откат: supabase/migrations_down/20261116100000_journal2_v203_pz.down.sql.
create or replace function public._lesson_kind_ru(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'lecture' then 'лекция' when 'practice' then 'ПЗ' when 'lab' then 'лабораторная' end;
$$;
