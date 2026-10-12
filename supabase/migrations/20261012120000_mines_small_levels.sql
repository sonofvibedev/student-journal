-- Телефонные поля сапёра: отдельные ключи сложности.
--
-- На узком экране полное поле (до 10×18) не влезает целиком, и игра получает
-- поле меньше, но с той же долей мин: easy_s 8×8, medium_s 9×12, hard_s 10×14.
-- Время на меньшем поле с полным не сравнивается, поэтому рекорды у них свои —
-- для этого и нужен отдельный ключ сложности, а не флажок у записи.
--
-- Что уже записано, не меняется: easy, medium, hard остаются как были.

alter table public.game_records
  drop constraint if exists game_records_difficulty_check;

alter table public.game_records
  add constraint game_records_difficulty_check
  check (difficulty in ('easy', 'medium', 'hard', 'none', 'easy_s', 'medium_s', 'hard_s'));
