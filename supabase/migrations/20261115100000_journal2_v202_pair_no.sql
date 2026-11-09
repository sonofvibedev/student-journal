-- Журнал 2.0.2: номер пары в пропуске. Только добавление: nullable-колонка, существующие строки и политики не меняются.
-- Пропуск, внесённый из расписания, помнит пару (pair_no). Так две подряд идущие пары одного предмета и вида (сдвоенная
-- лабораторная) не сливаются в одну отметку, а повторная отметка той же пары находит свои записи.
-- Записи без pair_no (старые, преподавателя) считаются относящимися к любой паре предмета в этот день.
-- Откат: supabase/migrations_down/20261115100000_journal2_v202_pair_no.down.sql.
alter table public.absences add column pair_no smallint check (pair_no between 1 and 12);
grant insert (pair_no), update (pair_no) on public.absences to authenticated;
