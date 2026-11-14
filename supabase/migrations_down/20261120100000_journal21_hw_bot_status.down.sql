-- Откат 2.1 п.1: функция убирается, данных миграция не меняла.
drop function if exists public.homework_bot_status(uuid);
