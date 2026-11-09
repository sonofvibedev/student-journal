-- Откат 2.0.2: колонка pair_no убирается вместе с правами на неё (данные в ней — только номер пары).
revoke insert (pair_no), update (pair_no) on public.absences from authenticated;
alter table public.absences drop column if exists pair_no;
