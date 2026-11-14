-- Журнал 2.1, п.5: экзамены, зачёты и консультации в расписании. bseu.by отдаёт их в поле ClassType («Экзамен», «Зачет», «Консультация»),
-- раньше парсер сводил всё, что не лекция, практика и лабораторная, в kind = 'other'. Новая колонка event хранит тип события; kind не трогаем.
-- Колонка заполняется ночным импортом; до него у старых строк event = null (ничего не ломается). Откат: migrations_down/20261120110000_*.down.sql.
alter table public.schedule_lessons
  add column event text check (event in ('exam', 'consultation', 'credit'));
comment on column public.schedule_lessons.event is 'exam | consultation | credit: из ClassType bseu.by; consultation может быть выведена по правилу «занятие по предмету в учебный день перед экзаменом»';
