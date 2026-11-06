-- Откат 20261108100000_journal2_teachers_chat.sql: БД возвращается к состоянию после 20261107100000.
-- Запуск (только тест): npx supabase db query --remote=<TEST_REF> --yes --file <этот файл>
-- ВНИМАНИЕ: удаляет ключи переписки (chat_keys), треды, сообщения, отметки прочтения и темы занятий
-- (lesson_notes) без возможности восстановления. Уведомления kind = 'chat' остаются в колокольчике.
-- Задания, внесённые преподавателями, остаются в tasks (created_by = преподаватель), но преподаватель больше
-- не может их менять и удалять; староста их тоже не удаляет (как до отката).
begin;

-- 1. Таблицы этапа 4 (их политики ссылаются на chat_my_thread_ids, поэтому сначала таблицы), затем функции
drop table public.chat_reads, public.chat_messages, public.chat_threads, public.chat_keys, public.lesson_notes;

drop function public.teacher_group_stats(uuid);
drop function public.chat_mark_read(uuid);
drop function public.chat_send(uuid, text, text, int, int);
drop function public.chat_threads_my();
drop function public.chat_thread_open(uuid, uuid);
drop function public.chat_peer_key(uuid);
drop function public.chat_keys_publish(jsonb, jsonb, boolean);
drop function public.chat_my_thread_ids();
drop function public._chat_b64u_ok(text, int, int);
drop function public._chat_live(uuid, uuid, uuid, text);
drop function public.lesson_notes_touch();

-- 2. tasks: политики преподавателя убираются, чтение — прежний текст (20261105200000)
drop policy "Задания: внесение преподавателем" on public.tasks;
drop policy "Задания: изменение преподавателем" on public.tasks;
drop policy "Задания: удаление преподавателем" on public.tasks;
drop policy "Задания: чтение" on public.tasks;
create policy "Задания: чтение" on public.tasks for select to authenticated
  using (public.is_group_reader(group_id) or public.teaches(group_id, rec ->> 'subject', null));

-- 3. absences: прежние тексты политик (20261105200000)
drop policy "Пропуски: чтение" on public.absences;
create policy "Пропуски: чтение" on public.absences for select to authenticated
  using (public.is_group_reader(group_id)
         or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)));
drop policy "Пропуски: внесение" on public.absences;
create policy "Пропуски: внесение" on public.absences for insert to authenticated
  with check (created_by = (select auth.uid())
              and public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
drop policy "Пропуски: изменение" on public.absences;
create policy "Пропуски: изменение" on public.absences for update to authenticated
  using (public.is_group_staff(group_id)
         or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)))
  with check (public.group_open(group_id)
              and (public.is_group_staff(group_id)
                   or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind))));
drop policy "Пропуски: отмена" on public.absences;
create policy "Пропуски: отмена" on public.absences for delete to authenticated
  using (public.group_open(group_id)
         and ((public.is_group_staff(group_id) and (created_by = (select auth.uid()) or created_by is null))
              or (lesson_kind is not null and public.teaches(group_id, subject, lesson_kind)
                  and (created_by = (select auth.uid()) or public.user_is_staff(group_id, created_by)))));

-- 4. Записи audit_log 'chat_key_publish' остаются (журнал действий не чистится).
-- 5. Запись о миграции: иначе db push не применит её повторно
delete from supabase_migrations.schema_migrations where version = '20261108100000';

commit;
