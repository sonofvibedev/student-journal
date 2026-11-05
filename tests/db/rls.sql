-- Тесты прав доступа этапа 1. Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Сценарии: раздел 8 ТЗ и матрица прав из раздела «Роли и права».

-- ===== 1. Разделение групп: пользователь A не видит и не пишет данные B (по каждой таблице) =====
do $$
declare
  t text;
  ga constant text := 'aaaaaaaa-0000-4000-8000-00000000000a';
  gb constant text := 'bbbbbbbb-0000-4000-8000-00000000000b';
  tbls text[] := array['students', 'absences', 'tasks', 'app_events', 'student_achievements', 'game_records', 'study_days'];
begin
  foreach t in array tbls loop
    -- студент A и староста A: чужих строк нет
    perform pg_temp.expect_count('изоляция: студент A не читает ' || t || ' группы B', pg_temp.u(3),
      format('select 1 from public.%I where group_id = %L', t, gb), 0);
    perform pg_temp.expect_count('изоляция: староста A не читает ' || t || ' группы B', pg_temp.u(1),
      format('select 1 from public.%I where group_id = %L', t, gb), 0);
    -- а своих читают
    perform pg_temp.expect_min('своя группа: студент A читает ' || t, pg_temp.u(3),
      format('select 1 from public.%I where group_id = %L', t, ga), 1);
    -- сисадмин видит обе
    perform pg_temp.expect_min('сисадмин читает ' || t || ' группы B', pg_temp.u(7),
      format('select 1 from public.%I where group_id = %L', t, gb), 1);
  end loop;
  perform pg_temp.expect_count('изоляция: студент B не читает memberships группы A', pg_temp.u(9),
    format('select 1 from public.memberships where group_id = %L', ga), 0);
  perform pg_temp.expect_count('изоляция: староста B не читает teacher_assignments группы A', pg_temp.u(8),
    format('select 1 from public.teacher_assignments where group_id = %L', ga), 0);
  perform pg_temp.expect_count('group_invites закрыта для студента', pg_temp.u(3), 'select 1 from public.group_invites', 0);
  perform pg_temp.expect_count('group_invites закрыта для старосты (только хэши, через RPC)', pg_temp.u(1), 'select 1 from public.group_invites', 0);
end $$;

-- запись в чужую группу
select pg_temp.expect_denied('староста A не вносит пропуск в группу B', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-1', 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', '2026-11-05', 'Логистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_denied('староста A не меняет пропуск группы B', pg_temp.u(1),
  $$update public.absences set hours = 9 where id = 'abs-b1'$$);
select pg_temp.expect_denied('староста A не удаляет пропуск группы B', pg_temp.u(1),
  $$delete from public.absences where id = 'abs-b1'$$);
select pg_temp.expect_denied('студент A не меняет студентов группы B', pg_temp.u(3),
  $$update public.students set first_name = 'взлом' where id = 't-b2'$$);

-- ===== 2. Ожидающий подтверждения не видит ничего из данных группы =====
do $$
declare
  t text;
  tbls text[] := array['students', 'absences', 'tasks', 'app_events', 'student_achievements', 'game_records', 'study_days'];
begin
  foreach t in array tbls loop
    perform pg_temp.expect_count('pending не читает ' || t || ' своей группы', pg_temp.u(4),
      format('select 1 from public.%I where group_id = %L', t, 'aaaaaaaa-0000-4000-8000-00000000000a'), 0);
  end loop;
end $$;
-- вся таблица целиком (без фильтра): ничего, кроме своей записи
select pg_temp.expect_count('pending: из students виден только он сам', pg_temp.u(4), 'select 1 from public.students', 1);
select pg_temp.expect_count('pending не читает журнал легаси-группы', pg_temp.u(4), 'select 1 from public.journal_private', 0);
select pg_temp.expect_min('pending видит свою строку memberships', pg_temp.u(4), 'select 1 from public.memberships where user_id = auth.uid()', 1);
select pg_temp.expect_count('пользователь без групп не читает students', pg_temp.u(11), 'select 1 from public.students', 0);
select pg_temp.expect_count('пользователь без групп не читает absences', pg_temp.u(11), 'select 1 from public.absences', 0);
select pg_temp.expect_denied('pending не вносит пропуск', pg_temp.u(4),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, created_by)
    values ('x-2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, auth.uid())$$);

-- ===== 3. Студент не вносит и не меняет пропуски =====
select pg_temp.expect_denied('студент не вносит пропуск', pg_temp.u(3),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-3', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_denied('студент не меняет пропуск', pg_temp.u(3), $$update public.absences set is_excused = true where id = 'abs-a1'$$);
select pg_temp.expect_denied('студент не удаляет пропуск', pg_temp.u(3), $$delete from public.absences where id = 'abs-a1'$$);
select pg_temp.expect_denied('студент не меняет список студентов', pg_temp.u(3), $$update public.students set first_name = 'x' where id = 't-a1'$$);
select pg_temp.expect_denied('студент не выдаёт себе роль старосты', pg_temp.u(3),
  $$update public.memberships set extra_role = 'headman' where user_id = auth.uid()$$);
select pg_temp.expect_denied('студент не повышает статус pending → active', pg_temp.u(4),
  $$update public.memberships set status = 'active' where user_id = auth.uid()$$);

-- ===== 4. Староста и заместитель: права группы, но не чужой; ролей не выдают =====
select pg_temp.expect_allowed('староста вносит пропуск своей группы', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-4', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_allowed('заместитель вносит пропуск своей группы (те же права)', pg_temp.u(2),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-5', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_allowed('староста отменяет свою запись', pg_temp.u(1), $$delete from public.absences where id = 'x-4'$$);
select pg_temp.expect_denied('староста не отменяет запись, внесённую другим пользователем (заместитель)', pg_temp.u(1),
  $$delete from public.absences where id = 'x-5'$$);
select pg_temp.expect_denied('староста не меняет extra_role напрямую', pg_temp.u(1),
  $$update public.memberships set extra_role = 'headman' where user_id = pg_temp.u(3)$$);
select pg_temp.expect_call_fail('староста не вызывает sysadmin_set_group_role', pg_temp.u(1),
  format($$select public.sysadmin_set_group_role(%L::uuid, %L::uuid, 'deputy')$$, 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(3)));
select pg_temp.expect_call_fail('староста не вызывает sysadmin_set_thresholds', pg_temp.u(1),
  format($$select public.sysadmin_set_thresholds(%L::uuid, 6, 10)$$, 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_denied('староста не меняет пороги группы напрямую', pg_temp.u(1),
  $$update public.groups set warn_hours = 1 where id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$);
select pg_temp.expect_denied('староста не создаёт группу', pg_temp.u(1), $$insert into public.groups (name) values ('самозванец')$$);
select pg_temp.expect_denied('староста не создаёт членство в чужой группе', pg_temp.u(1),
  $$insert into public.memberships (user_id, group_id, base_role, status) values (pg_temp.u(11), 'bbbbbbbb-0000-4000-8000-00000000000b', 'student', 'active')$$);

-- ===== 5. Преподаватели: только свои дисциплины и свой вид занятий =====
select pg_temp.expect_count('преподаватель лекций видит только лекции своей дисциплины', pg_temp.u(5),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);
select pg_temp.expect_count('преподаватель ПЗ видит только ПЗ своей дисциплины', pg_temp.u(6),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);
select pg_temp.expect_count('преподаватель не видит чужую группу', pg_temp.u(5),
  $$select 1 from public.absences where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0);
select pg_temp.expect_allowed('преподаватель лекций вносит пропуск по своей лекции', pg_temp.u(5),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-6', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_denied('преподаватель лекций не вносит ПЗ', pg_temp.u(5),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-7', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'practice', auth.uid())$$);
select pg_temp.expect_denied('преподаватель лекций не вносит пропуск по чужой дисциплине', pg_temp.u(5),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-8', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_allowed('преподаватель лекций меняет «уважительный» по своей дисциплине', pg_temp.u(5),
  $$update public.absences set is_excused = true where id = 'abs-a1'$$);
select pg_temp.expect_denied('преподаватель лекций не меняет ПЗ-пропуск', pg_temp.u(5),
  $$update public.absences set is_excused = true where id = 'abs-a2'$$);
select pg_temp.expect_allowed('преподаватель отменяет запись старосты по своей дисциплине', pg_temp.u(5),
  $$delete from public.absences where id = 'abs-a1'$$);
select pg_temp.expect_denied('преподаватель не меняет роли', pg_temp.u(5),
  $$update public.memberships set extra_role = 'headman' where user_id = auth.uid()$$);

-- ===== 6. Сисадмин =====
select pg_temp.expect_min('сисадмин видит все группы', pg_temp.u(7), 'select 1 from public.groups', 3);
select pg_temp.expect_min('сисадмин видит все членства', pg_temp.u(7), 'select 1 from public.memberships', 9);
select pg_temp.expect_call_ok('сисадмин вызывает sysadmin_set_thresholds', pg_temp.u(7),
  format($$select public.sysadmin_set_thresholds(%L::uuid, 7, 11)$$, 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_count('порог группы изменён сисадмином', pg_temp.u(1),
  $$select 1 from public.groups where id = 'aaaaaaaa-0000-4000-8000-00000000000a' and warn_hours = 7 and dean_hours = 11$$, 1);
select pg_temp.expect_denied('обычный пользователь не читает sysadmins', pg_temp.u(3), $$delete from public.sysadmins$$);
select pg_temp.expect_count('студент не читает таблицу sysadmins', pg_temp.u(3), 'select 1 from public.sysadmins', 0);

-- ===== 7. Подтверждение студентов старостой =====
select pg_temp.expect_call_fail('староста B не подтверждает студента группы A', pg_temp.u(8), $$select public.membership_approve('t-a4')$$);
select pg_temp.expect_call_fail('студент не подтверждает сам себя', pg_temp.u(4), $$select public.membership_approve('t-a4')$$);
select pg_temp.expect_call_fail('студент A не подтверждает другого', pg_temp.u(3), $$select public.membership_approve('t-a4')$$);
select pg_temp.expect_call_ok('староста A подтверждает «Это он»', pg_temp.u(1), $$select public.membership_approve('t-a4')$$);
select pg_temp.expect_min('после подтверждения студент читает данные группы', pg_temp.u(4),
  $$select 1 from public.students where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 2);
select pg_temp.expect_min('после подтверждения студент видит пропуски группы', pg_temp.u(4),
  $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);

-- «Не он»: запись освобождается
update public.students set claim_status = 'pending', claimed_by = pg_temp.u(11) where id = 't-a5';
insert into public.memberships (user_id, group_id, student_id, base_role, status)
  values (pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a5', 'student', 'pending');
select pg_temp.expect_call_ok('староста A отклоняет «Не он»', pg_temp.u(1), $$select public.membership_reject('t-a5')$$);
select pg_temp.expect_count('после «Не он» запись снова свободна', pg_temp.u(1),
  $$select 1 from public.students where id = 't-a5' and claim_status = 'free' and claimed_by is null$$, 1);
select pg_temp.expect_count('отклонённый не читает данные группы', pg_temp.u(11), 'select 1 from public.absences', 0);

-- сброс привязки
select pg_temp.expect_call_fail('студент не сбрасывает привязку другого', pg_temp.u(3), $$select public.student_reset_binding('t-a2')$$);
select pg_temp.expect_call_ok('староста сбрасывает привязку студента', pg_temp.u(1), $$select public.student_reset_binding('t-a3')$$);
select pg_temp.expect_count('после сброса студент A3 не читает данные группы', pg_temp.u(3), 'select 1 from public.absences', 0);
select pg_temp.expect_count('после сброса запись свободна', pg_temp.u(1),
  $$select 1 from public.students where id = 't-a3' and claimed_by is null and claim_status = 'free'$$, 1);
select pg_temp.expect_min('пропуски студента после сброса сохранились', pg_temp.u(1),
  $$select 1 from public.absences where student_id = 't-a3'$$, 1);

-- ===== 8. Ограничения целостности =====
select pg_temp.expect_error('одну запись студента не занять двум людям', $$update public.students set claimed_by = pg_temp.u(2) where id = 't-a5'$$);
select pg_temp.expect_error('в группе не больше одного старосты', $$insert into public.memberships (user_id, group_id, base_role, extra_role, status)
  values (pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 'student', 'headman', 'active')$$);
select pg_temp.expect_error('в группе не больше одного заместителя', $$insert into public.memberships (user_id, group_id, base_role, extra_role, status)
  values (pg_temp.u(11), 'aaaaaaaa-0000-4000-8000-00000000000a', 'student', 'deputy', 'active')$$);
select pg_temp.expect_error('дубль ФИО в группе запрещён', $$insert into public.students (id, group_id, last_name, first_name)
  values ('t-dup', 'aaaaaaaa-0000-4000-8000-00000000000a', ' тестов ', 'ЗАМ')$$);

-- ===== 9. Журнал закрыт = только просмотр =====
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_denied('закрытая группа: староста не вносит пропуск', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-9', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);
select pg_temp.expect_min('закрытая группа: чтение работает', pg_temp.u(1), $$select 1 from public.absences where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- ===== 10. Режим техработ =====
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_count('техработы: студент B не читает данные', pg_temp.u(9), 'select 1 from public.students', 0);
select pg_temp.expect_min('техработы: староста группы читает данные', pg_temp.u(1), 'select 1 from public.students', 1);
select pg_temp.expect_min('техработы: сисадмин читает данные', pg_temp.u(7), 'select 1 from public.students', 1);
select pg_temp.expect_denied('техработы: студент не пишет', pg_temp.u(9), $$update public.students set subgroup = '1' where id = 't-b2'$$);
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===== 11. Совместимость: легаси-группа 24ДММ-2 работает как раньше =====
select pg_temp.expect_min('легаси: студент 24ДММ-2 читает свои события', pg_temp.u(10),
  $$select 1 from public.app_events where group_id = '00000000-0000-4000-8000-000000000024'$$, 1);
select pg_temp.expect_count('легаси: студент группы A не читает события 24ДММ-2', pg_temp.u(3),
  $$select 1 from public.app_events where group_id = '00000000-0000-4000-8000-000000000024'$$, 0);
select pg_temp.expect_count('легаси: студент группы A не читает journal_private', pg_temp.u(3), 'select 1 from public.journal_private', 0);
select pg_temp.expect_count('легаси: студент группы B не читает journal_private', pg_temp.u(9), 'select 1 from public.journal_private', 0);
select pg_temp.expect_count('легаси: студент 24ДММ-2 читает journal_private', pg_temp.u(10), 'select 1 from public.journal_private', 1);
select pg_temp.expect_call_ok('легаси: maintenance_status() работает без изменений', pg_temp.u(10), 'select public.maintenance_status()');

-- ===== 12. Служебные функции закрыты =====
select pg_temp.expect_call_fail('journal2_import_legacy недоступна студенту', pg_temp.u(3), 'select public.journal2_import_legacy()');
select pg_temp.expect_call_fail('sysadmin_bootstrap недоступна студенту', pg_temp.u(3), format('select public.sysadmin_bootstrap(%L::uuid)', pg_temp.u(3)));
select pg_temp.expect_call_fail('sysadmin_bootstrap недоступна сисадмину через клиент', pg_temp.u(7), format('select public.sysadmin_bootstrap(%L::uuid)', pg_temp.u(3)));
select pg_temp.expect_count('join_attempts закрыта для клиента', pg_temp.u(1), 'select 1 from public.join_attempts', 0);
select pg_temp.expect_denied('audit_log: запись клиентом запрещена', pg_temp.u(1), $$insert into public.audit_log (action) values ('подделка')$$);
select pg_temp.expect_count('audit_log: студент не читает', pg_temp.u(3), 'select 1 from public.audit_log', 0);
