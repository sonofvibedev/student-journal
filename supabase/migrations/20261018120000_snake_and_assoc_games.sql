-- Новые игры в рекордах: змейка и «Ассоциации».
--
-- У змейки рекорд — длина (больше лучше), сложности нет. У «Ассоциаций» в
-- game_records лежит лучший результат одной попытки; месячный рейтинг
-- считается отдельно, по таблице попыток.
--
-- Писать в таблицу по-прежнему может только Edge Function submit-game-score
-- под service_role: политик insert, update и delete у таблицы нет, и эта
-- миграция их не добавляет.

alter table public.game_records drop constraint if exists game_records_game_check;
alter table public.game_records add constraint game_records_game_check
  check (game in ('sudoku', 'minesweeper', 'flappy', 'snake', 'assoc'));
