-- Откат 2.0.3 (логи): лента и вспомогательные функции убираются, таблиц и данных миграция не создавала.
drop function if exists public.sysadmin_activity_log(text, uuid, text, date, date, text, int, int);
drop function if exists public._student_short(text);
drop function if exists public._actor_name(uuid);
drop function if exists public._actor_role(uuid, uuid);
