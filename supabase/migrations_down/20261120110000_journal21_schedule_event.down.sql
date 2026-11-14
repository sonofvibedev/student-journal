-- Откат 2.1 п.5: колонка event убирается (данные расписания остаются, импорт восстановит kind).
alter table public.schedule_lessons drop column if exists event;
