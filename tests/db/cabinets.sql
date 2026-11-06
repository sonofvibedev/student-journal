-- Тесты этапа 2 (кабинеты студента и старосты). Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A («Маркетинг услуг»),
-- 6 препод ПЗ A, 7 сисадмин, 8 староста B, 9 студент B, 10 студент 24ДММ-2, 11 без групп.

-- ===== фикстуры этапа 2 (владелец) =====
-- prelude выключил пользовательские триггеры этих таблиц; триггеры этапа 2 включаем обратно
alter table public.tasks enable trigger zz_fill_group_id;
alter table public.tasks enable trigger tasks_notify;
alter table public.app_events enable trigger app_events_before_insert;
alter table public.app_events enable trigger zz_fill_group_id;
alter table public.student_achievements enable trigger zz_fill_group_id;
alter table public.game_records enable trigger zz_fill_group_id;

-- у тестового аккаунта 3 остался легаси-профиль 24ДММ-2 из сида: убираем, он теперь студент новой группы A
delete from public.profiles where user_id = pg_temp.u(3);
update public.students set subgroup = 1 where id = 't-a3';
update public.students set subgroup = 2 where id = 't-a2';

insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject, kind) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 1, 'Маркетинг услуг', 'lecture'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 2, 'Статистика', 'lecture'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '2026-11-10', 1, 'Логистика', 'lecture');
insert into public.schedule_meta (group_id, semester_start, semester_end, last_status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-09-01', '2026-12-20', 'ok');

insert into public.certificates (id, group_id, student_id, kind, date_from, date_to, due_date, created_by) values
  ('ce-a3', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick', '2026-11-03', '2026-11-04', '2026-11-20', pg_temp.u(1)),
  ('ce-a3b', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'statement', '2026-11-03', '2026-11-03', null, pg_temp.u(1)),
  ('ce-a2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', 'other', null, null, null, pg_temp.u(1)),
  ('ce-b2', 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', 'sick', null, null, null, pg_temp.u(8));

insert into public.grades (id, group_id, student_id, subject, lesson_kind, value, passed, created_by) values
  ('gr-a3l', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 8, null, pg_temp.u(5)),
  ('gr-a3p', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'practice', null, true, pg_temp.u(6)),
  ('gr-a2l', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', 'Маркетинг услуг', 'lecture', 5, null, pg_temp.u(5)),
  ('gr-b2', 'bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', 'Логистика', 'lecture', 9, null, pg_temp.u(8));

-- ===== 1. Расписание: читает группа, преподаватель — свои дисциплины, пишет только service_role =====
select pg_temp.expect_count('расписание: студент A видит пары своей группы', pg_temp.u(3),
  $$select 1 from public.schedule_lessons where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 2);
select pg_temp.expect_count('расписание: студент A не видит группу B', pg_temp.u(3),
  $$select 1 from public.schedule_lessons where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0);
select pg_temp.expect_count('расписание: pending не видит ничего', pg_temp.u(4), 'select 1 from public.schedule_lessons', 0);
select pg_temp.expect_count('расписание: без группы не видит ничего', pg_temp.u(11), 'select 1 from public.schedule_lessons', 0);
select pg_temp.expect_count('расписание: преподаватель видит только свою дисциплину', pg_temp.u(5), 'select 1 from public.schedule_lessons', 1);
select pg_temp.expect_min('расписание: сисадмин видит группу B', pg_temp.u(7),
  $$select 1 from public.schedule_lessons where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 1);
select pg_temp.expect_denied('расписание: староста не пишет напрямую', pg_temp.u(1),
  $$insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject) values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-11', 1, 'x')$$);
select pg_temp.expect_denied('расписание: сисадмин не пишет напрямую (только импорт)', pg_temp.u(7),
  $$update public.schedule_lessons set room = 'x'$$);
select pg_temp.expect_count('расписание: состояние импорта видит своя группа', pg_temp.u(3), 'select 1 from public.schedule_meta', 1);
select pg_temp.expect_count('расписание: состояние импорта чужой группе не видно', pg_temp.u(9), 'select 1 from public.schedule_meta', 0);
select pg_temp.expect_error('расписание: дубль занятия (та же пара, предмет, вся группа) запрещён',
  $$insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject) values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 1, 'Маркетинг услуг')$$);

-- ===== 2. Справки: студент — свои, староста — группа, преподаватель — нет =====
select pg_temp.expect_count('справки: студент видит только свои', pg_temp.u(3), 'select 1 from public.certificates', 2);
select pg_temp.expect_count('справки: студент B не видит справки A', pg_temp.u(9),
  $$select 1 from public.certificates where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_count('справки: pending не видит', pg_temp.u(4), 'select 1 from public.certificates', 0);
select pg_temp.expect_count('справки: преподаватель не видит', pg_temp.u(5), 'select 1 from public.certificates', 0);
select pg_temp.expect_count('справки: староста видит справки группы', pg_temp.u(1), 'select 1 from public.certificates', 3);
select pg_temp.expect_count('справки: заместитель видит справки группы', pg_temp.u(2), 'select 1 from public.certificates', 3);
select pg_temp.expect_count('справки: староста B не видит справки A', pg_temp.u(8),
  $$select 1 from public.certificates where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_min('справки: сисадмин видит все', pg_temp.u(7), 'select 1 from public.certificates', 4);
select pg_temp.expect_denied('справки: студент не вставляет напрямую', pg_temp.u(3),
  $$insert into public.certificates (group_id, student_id, kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick')$$);
select pg_temp.expect_denied('справки: староста не вставляет напрямую (только RPC)', pg_temp.u(1),
  $$insert into public.certificates (group_id, student_id, kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick')$$);
select pg_temp.expect_denied('справки: староста не меняет статус напрямую', pg_temp.u(1),
  $$update public.certificates set status = 'received' where id = 'ce-a2'$$);
select pg_temp.expect_allowed('справки: староста правит описание ожидающей', pg_temp.u(1),
  $$update public.certificates set note = 'принесёт в пятницу' where id = 'ce-a2'$$);
select pg_temp.expect_denied('справки: студент не правит свою справку', pg_temp.u(3),
  $$update public.certificates set note = 'x' where id = 'ce-a3'$$);
select pg_temp.expect_call_fail('справки: студент не создаёт через RPC', pg_temp.u(3),
  $$select public.certificate_create('t-a3', 'sick', '2026-11-01', '2026-11-02', null, null)$$);
select pg_temp.expect_call_fail('справки: преподаватель не создаёт через RPC', pg_temp.u(5),
  $$select public.certificate_create('t-a3', 'sick', null, null, null, null)$$);
select pg_temp.expect_call_fail('справки: староста B не создаёт справку студенту A', pg_temp.u(8),
  $$select public.certificate_create('t-a3', 'sick', null, null, null, null)$$);
select pg_temp.expect_call_fail('справки: неверный вид отклоняется', pg_temp.u(1),
  $$select public.certificate_create('t-a3', 'fake', null, null, null, null)$$);
select pg_temp.expect_call_fail('справки: дата «с» позже «по» отклоняется', pg_temp.u(1),
  $$select public.certificate_create('t-a3', 'sick', '2026-11-05', '2026-11-01', null, null)$$);
select pg_temp.expect_count('справки: староста создаёт через RPC (id ce-…)', pg_temp.u(1),
  $$select 1 where public.certificate_create('t-a1', 'sick', '2026-11-01', '2026-11-02', '2026-11-15', 'тест') like 'ce-%'$$, 1);
select pg_temp.expect_call_ok('справки: заместитель создаёт через RPC', pg_temp.u(2),
  $$select public.certificate_create('t-a3', 'other', null, null, null, null)$$);
select pg_temp.expect_min('справки: созданное через RPC записано в audit_log', pg_temp.u(1),
  $$select 1 from public.audit_log where action = 'certificate_create'$$, 2);

-- закрытие справки
select pg_temp.expect_call_fail('справки: студент не закрывает справку', pg_temp.u(3),
  $$select public.certificate_resolve('ce-a3', 'received', array['abs-a1'])$$);
select pg_temp.expect_call_fail('справки: староста B не закрывает справку A', pg_temp.u(8),
  $$select public.certificate_resolve('ce-a3', 'received', array['abs-a1'])$$);
select pg_temp.expect_call_fail('справки: преподаватель не закрывает справку', pg_temp.u(5),
  $$select public.certificate_resolve('ce-a3', 'received', array['abs-a1'])$$);
select pg_temp.expect_call_fail('справки: чужой пропуск (группа B) в списке → отказ целиком', pg_temp.u(1),
  $$select public.certificate_resolve('ce-a3', 'received', array['abs-a1', 'abs-b1'])$$);
select pg_temp.expect_call_fail('справки: пропуск другого студента той же группы → отказ', pg_temp.u(1),
  $$select public.certificate_resolve('ce-a2', 'received', array['abs-a1'])$$);
select pg_temp.expect_count('справки: после отказа пропуск не тронут', pg_temp.u(1),
  $$select 1 from public.absences where id = 'abs-a1' and certificate_id is null and not is_excused$$, 1);
select pg_temp.expect_call_fail('справки: неверный статус отклоняется', pg_temp.u(1),
  $$select public.certificate_resolve('ce-a3', 'waiting', null)$$);
-- abs-a1 внёс староста, abs-a3 — заместитель: RPC проходит absences_guard и для чужой записи группы
select pg_temp.expect_count('справки: «получена» закрывает переданные пропуски, возвращает часы', pg_temp.u(1),
  $$select 1 where (public.certificate_resolve('ce-a3', 'received', array['abs-a1', 'abs-a3'])) @> '{"ok": true, "closed": 2, "hours": 4}'$$, 1);
select pg_temp.expect_count('справки: закрытые пропуски уважительные, справка сдана, связаны со справкой', pg_temp.u(1),
  $$select 1 from public.absences where certificate_id = 'ce-a3' and is_excused and cert_submitted and cert_type = 'Больничный'$$, 2);
select pg_temp.expect_count('справки: незакрытый пропуск того же студента не тронут', pg_temp.u(1),
  $$select 1 from public.absences where id = 'abs-a2' and certificate_id is null and not is_excused$$, 1);
select pg_temp.expect_count('справки: статус received и время получения', pg_temp.u(3),
  $$select 1 from public.certificates where id = 'ce-a3' and status = 'received' and received_at is not null$$, 1);
select pg_temp.expect_call_fail('справки: повторное «получена» → already_received', pg_temp.u(1),
  $$select public.certificate_resolve('ce-a3', 'none', null)$$);
select pg_temp.expect_count('справки: «нет справки» ничего не открывает и не закрывает', pg_temp.u(2),
  $$select 1 where (public.certificate_resolve('ce-a3b', 'none', array['abs-a2'])) @> '{"ok": true, "closed": 0}'$$, 1);
select pg_temp.expect_count('справки: после «нет справки» пропуск прежний', pg_temp.u(1),
  $$select 1 from public.absences where id = 'abs-a2' and certificate_id is null and not is_excused and not cert_submitted$$, 1);
select pg_temp.expect_count('справки: после «нет справки» статус none', pg_temp.u(3),
  $$select 1 from public.certificates where id = 'ce-a3b' and status = 'none'$$, 1);
select pg_temp.expect_denied('справки: закрытый справкой пропуск нельзя сделать неуважительным напрямую', pg_temp.u(1),
  $$update public.absences set is_excused = false where id = 'abs-a1'$$);
select pg_temp.expect_denied('справки: certificate_id клиент не пишет (староста)', pg_temp.u(1),
  $$update public.absences set certificate_id = 'ce-a2' where id = 'abs-a2'$$);
select pg_temp.expect_denied('справки: certificate_id клиент не пишет (преподаватель)', pg_temp.u(6),
  $$update public.absences set certificate_id = null where id = 'abs-a2'$$);
select pg_temp.expect_denied('справки: certificate_id не задать при вставке', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by, certificate_id)
    values ('x-c1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid(), 'ce-a2')$$);
select pg_temp.expect_error('справки: FK не даёт связать пропуск со справкой другого студента',
  $$update public.absences set certificate_id = 'ce-a2' where id = 'abs-a2'$$);
select pg_temp.expect_denied('справки: полученную справку удалить нельзя', pg_temp.u(1), $$delete from public.certificates where id = 'ce-a3'$$);
select pg_temp.expect_allowed('справки: ожидающую справку староста удаляет', pg_temp.u(1), $$delete from public.certificates where id = 'ce-a2'$$);
select pg_temp.expect_denied('справки: староста A не удаляет справку B', pg_temp.u(1), $$delete from public.certificates where id = 'ce-b2'$$);

-- ===== 3. Оценки =====
select pg_temp.expect_count('оценки: студент видит только свои', pg_temp.u(3), 'select 1 from public.grades', 2);
select pg_temp.expect_count('оценки: студент B не видит оценки A', pg_temp.u(9),
  $$select 1 from public.grades where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_count('оценки: pending не видит', pg_temp.u(4), 'select 1 from public.grades', 0);
select pg_temp.expect_count('оценки: староста видит группу', pg_temp.u(1), 'select 1 from public.grades', 3);
select pg_temp.expect_count('оценки: староста B не видит A', pg_temp.u(8),
  $$select 1 from public.grades where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_count('оценки: преподаватель лекций видит только лекции своей дисциплины', pg_temp.u(5), 'select 1 from public.grades', 2);
select pg_temp.expect_count('оценки: преподаватель ПЗ видит только ПЗ', pg_temp.u(6), 'select 1 from public.grades', 1);
select pg_temp.expect_min('оценки: сисадмин видит все', pg_temp.u(7), 'select 1 from public.grades', 4);
select pg_temp.expect_allowed('оценки: преподаватель лекций ставит оценку по своей лекции', pg_temp.u(5),
  $$insert into public.grades (id, group_id, student_id, subject, lesson_kind, value, lesson_date)
    values ('gr-new', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 7, '2026-11-05')$$);
select pg_temp.expect_denied('оценки: преподаватель лекций не ставит за ПЗ', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'practice', 7)$$);
select pg_temp.expect_denied('оценки: преподаватель не ставит по чужой дисциплине', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Статистика', 'lecture', 7)$$);
select pg_temp.expect_denied('оценки: преподаватель не ставит в чужой группе', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', 'Маркетинг услуг', 'lecture', 7)$$);
select pg_temp.expect_denied('оценки: студент не ставит оценки', pg_temp.u(3),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 10)$$);
select pg_temp.expect_denied('оценки: староста не ставит оценки', pg_temp.u(1),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 10)$$);
select pg_temp.expect_denied('оценки: преподаватель не подставляет чужой created_by', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value, created_by) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 7, pg_temp.u(6))$$);
select pg_temp.expect_allowed('оценки: преподаватель меняет свою оценку', pg_temp.u(5), $$update public.grades set value = 9 where id = 'gr-a3l'$$);
select pg_temp.expect_denied('оценки: преподаватель лекций не меняет оценку ПЗ', pg_temp.u(5), $$update public.grades set passed = false where id = 'gr-a3p'$$);
select pg_temp.expect_denied('оценки: преподаватель не переносит оценку другому студенту', pg_temp.u(5),
  $$update public.grades set student_id = 't-a2' where id = 'gr-a3l'$$);
select pg_temp.expect_denied('оценки: студент не меняет свою оценку', pg_temp.u(3), $$update public.grades set value = 10 where id = 'gr-a3l'$$);
select pg_temp.expect_error('оценки: и балл, и зачёт одновременно запрещены',
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value, passed) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'x', 'lecture', 5, true)$$);
select pg_temp.expect_error('оценки: без балла и без зачёта запрещено',
  $$insert into public.grades (group_id, student_id, subject, lesson_kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'x', 'lecture')$$);
select pg_temp.expect_error('оценки: балл вне 1..10 запрещён',
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'x', 'lecture', 11)$$);
select pg_temp.expect_error('оценки: студент другой группы запрещён (составной FK)',
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-b2', 'x', 'lecture', 5)$$);

-- ===== 4. Уведомления =====
select pg_temp.expect_count('уведомления: пропуск от старосты → студенту, текст «предмет, вид: N ч»', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'absence' and title = 'Внесён пропуск' and body = 'Маркетинг услуг, лекция: 2 ч'$$, 1);
select pg_temp.expect_count('уведомления: оценка → студенту', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'grade' and body = 'Маркетинг услуг, лекция: 7' and ref ->> 'grade_id' = 'gr-new'$$, 1);
select pg_temp.expect_count('уведомления: справка получена → студенту', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'certificate' and title = 'Справка подтверждена' and ref ->> 'certificate_id' = 'ce-a3'$$, 1);
select pg_temp.expect_count('уведомления: справка получена → старосте (с ФИО)', pg_temp.u(1),
  $$select 1 from public.notifications where kind = 'certificate' and ref ->> 'certificate_id' = 'ce-a3' and body like 'Тестов Студент: Больничный%'$$, 1);
select pg_temp.expect_count('уведомления: справка получена → заместителю', pg_temp.u(2),
  $$select 1 from public.notifications where kind = 'certificate' and ref ->> 'certificate_id' = 'ce-a3'$$, 1);
select pg_temp.expect_count('уведомления: «нет справки» → студенту', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'certificate' and title = 'Справка не подтверждена' and ref ->> 'certificate_id' = 'ce-a3b'$$, 1);
select pg_temp.expect_count('уведомления: студент видит только свои', pg_temp.u(3),
  $$select 1 from public.notifications where user_id <> auth.uid()$$, 0);
select pg_temp.expect_count('уведомления: студент B не видит уведомления студента A', pg_temp.u(9),
  format('select 1 from public.notifications where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_count('уведомления: староста не видит уведомления студента', pg_temp.u(1),
  format('select 1 from public.notifications where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_count('уведомления: сисадмин не читает чужие уведомления', pg_temp.u(7),
  format('select 1 from public.notifications where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_count('уведомления: pending ничего не получил', pg_temp.u(4), 'select 1 from public.notifications', 0);
select pg_temp.expect_denied('уведомления: клиент не вставляет', pg_temp.u(3),
  $$insert into public.notifications (user_id, kind, title) values (auth.uid(), 'x', 'подделка')$$);
select pg_temp.expect_denied('уведомления: клиент не пишет read_at напрямую', pg_temp.u(3),
  $$update public.notifications set read_at = now()$$);
select pg_temp.expect_denied('уведомления: клиент не удаляет', pg_temp.u(3), $$delete from public.notifications$$);
select pg_temp.expect_count('уведомления: студент B не отмечает прочитанными чужие (0 строк)', pg_temp.u(9),
  format($$select 1 where public.notifications_mark_read(array(select id from public.notifications where user_id = %L)) = 0$$, pg_temp.u(3)), 1);
-- массив id берём под владельцем: студенту B чужие id не видны, поэтому подставляем их явно
do $$
declare ids uuid[]; n int;
begin
  select array_agg(id) into ids from public.notifications where user_id = pg_temp.u(3);
  perform pg_temp.as_user(pg_temp.u(9));
  n := public.notifications_mark_read(ids);
  execute 'reset role';
  insert into pg_temp.res values ('уведомления: чужие id в notifications_mark_read не отмечаются', n = 0 and
    not exists (select 1 from public.notifications where user_id = pg_temp.u(3) and read_at is not null), 'отмечено ' || n);
  perform pg_temp.as_user(pg_temp.u(3));
  n := public.notifications_mark_read(ids[1:1]);
  execute 'reset role';
  insert into pg_temp.res values ('уведомления: своё одно отмечается', n = 1, 'отмечено ' || n);
end $$;
select pg_temp.expect_count('уведомления: notifications_mark_all_read отмечает остальные свои', pg_temp.u(3),
  $$select 1 where public.notifications_mark_all_read() >= 1$$, 1);
select pg_temp.expect_count('уведомления: непрочитанных не осталось', pg_temp.u(3),
  $$select 1 from public.notifications where read_at is null$$, 0);
select pg_temp.expect_min('уведомления: у студента B свои непрочитанные остались', pg_temp.u(9),
  $$select 1 from public.notifications where read_at is null$$, 1);
-- легаси-импорт (created_by null) не шлёт уведомлений
insert into public.absences (id, group_id, student_id, date, subject, hours, created_by)
  values ('abs-legacy-n', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, null);
insert into pg_temp.res select 'уведомления: пропуск без created_by (импорт) не шлёт уведомление',
  not exists (select 1 from public.notifications where ref ->> 'absence_id' = 'abs-legacy-n'), '';

-- задания: всем active-студентам группы, кроме автора и другой подгруппы (t-a3 — 1, t-a2 — 2)
select pg_temp.expect_allowed('задания: староста вносит задание подгруппе 1 без group_id', pg_temp.u(1),
  $$insert into public.tasks (id, kind, rec) values ('tk-n1', 'homework', '{"id":"tk-n1","subject":"Статистика","text":"№5","subgroup":1}')$$);
select pg_temp.expect_count('задания: group_id заполнен из членства старосты', pg_temp.u(1),
  $$select 1 from public.tasks where id = 'tk-n1' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);
select pg_temp.expect_count('задания: студент подгруппы 1 получил уведомление', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'task' and ref ->> 'task_id' = 'tk-n1' and body = 'Статистика: №5'$$, 1);
select pg_temp.expect_count('задания: студент подгруппы 2 не получил', pg_temp.u(2),
  $$select 1 from public.notifications where ref ->> 'task_id' = 'tk-n1'$$, 0);
select pg_temp.expect_count('задания: автор не получил', pg_temp.u(1),
  $$select 1 from public.notifications where ref ->> 'task_id' = 'tk-n1'$$, 0);
select pg_temp.expect_allowed('задания: заместитель вносит задание всей группе', pg_temp.u(2),
  $$insert into public.tasks (id, kind, rec) values ('tk-n2', 'deadline', '{"id":"tk-n2","subject":"Статистика","text":"КР","subgroup":0}')$$);
select pg_temp.expect_count('задания: всей группе — получил староста', pg_temp.u(1),
  $$select 1 from public.notifications where ref ->> 'task_id' = 'tk-n2' and title = 'Новый дедлайн'$$, 1);
select pg_temp.expect_count('задания: всей группе — получил студент', pg_temp.u(3),
  $$select 1 from public.notifications where ref ->> 'task_id' = 'tk-n2'$$, 1);
select pg_temp.expect_count('задания: группа B не получила', pg_temp.u(9),
  $$select 1 from public.notifications where kind = 'task'$$, 0);

-- ===== 5. Подгруппа =====
select pg_temp.expect_call_ok('подгруппа: студент выбирает 2', pg_temp.u(3), 'select public.student_set_subgroup(2::smallint)');
select pg_temp.expect_count('подгруппа: записана', pg_temp.u(3), $$select 1 from public.students where id = 't-a3' and subgroup = 2$$, 1);
select pg_temp.expect_call_ok('подгруппа: можно сбросить (null)', pg_temp.u(3), 'select public.student_set_subgroup(null)');
select pg_temp.expect_count('подгруппа: сброшена', pg_temp.u(3), $$select 1 from public.students where id = 't-a3' and subgroup is null$$, 1);
select pg_temp.expect_call_fail('подгруппа: 3 не бывает', pg_temp.u(3), 'select public.student_set_subgroup(3::smallint)');
select pg_temp.expect_call_fail('подгруппа: pending не выбирает', pg_temp.u(4), 'select public.student_set_subgroup(1::smallint)');
select pg_temp.expect_call_fail('подгруппа: преподаватель не выбирает', pg_temp.u(5), 'select public.student_set_subgroup(1::smallint)');
select pg_temp.expect_call_fail('подгруппа: без группы не выбирает', pg_temp.u(11), 'select public.student_set_subgroup(1::smallint)');
select pg_temp.expect_denied('подгруппа: прямой update students запрещён', pg_temp.u(3),
  $$update public.students set subgroup = 1 where id = 't-a3'$$);
select pg_temp.expect_error('подгруппа: в таблице только 1/2', $$update public.students set subgroup = 5 where id = 't-a3'$$);

-- ===== 6. Агрегаты =====
insert into public.absences (id, group_id, student_id, date, subject, hours, is_excused, lesson_kind, created_by) values
  ('abs-now-1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', (now() at time zone 'Europe/Minsk')::date, 'Статистика', 2, false, 'lecture', pg_temp.u(1)),
  ('abs-now-2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', (now() at time zone 'Europe/Minsk')::date, 'Статистика', 1.5, true, 'practice', pg_temp.u(1));
create temp table exp as
  select coalesce(sum(hours), 0) as total, coalesce(sum(hours) filter (where is_excused), 0) as excused,
         coalesce(sum(hours) filter (where not is_excused), 0) as unexcused
    from public.absences
   where student_id = 't-a3' and date >= date_trunc('month', now() at time zone 'Europe/Minsk')::date
     and date < (date_trunc('month', now() at time zone 'Europe/Minsk') + interval '1 month')::date;
grant select on exp to public;
select pg_temp.expect_count('часы: absence_hours_my = суммы за текущий месяц по Минску, пороги группы', pg_temp.u(3),
  $$select 1 from pg_temp.exp e, (select public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a') r) x
     where (x.r ->> 'total')::numeric = e.total and (x.r ->> 'excused')::numeric = e.excused
       and (x.r ->> 'unexcused')::numeric = e.unexcused and e.unexcused >= 2 and e.excused >= 1.5
       and (x.r ->> 'warn_hours')::int = 8 and (x.r ->> 'dean_hours')::int = 12$$, 1);
select pg_temp.expect_call_fail('часы: студент B не считает часы группы A', pg_temp.u(9),
  $$select public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_call_fail('часы: pending не считает', pg_temp.u(4),
  $$select public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_call_fail('часы: преподаватель не считает', pg_temp.u(5),
  $$select public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_count('сводка: староста получает всех студентов группы', pg_temp.u(1),
  $$select 1 from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null)$$, 5);
select pg_temp.expect_count('сводка: суммы за период и ожидающие справки', pg_temp.u(2),
  $$select 1 from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-03', '2026-11-04') s
     where s.student_id = 't-a3' and s.student_name = 'Тестов Студент' and s.total = 6 and s.excused = 4 and s.cert_waiting = 1$$, 1);
select pg_temp.expect_count('сводка: сисадмин получает', pg_temp.u(7),
  $$select 1 from public.group_absence_summary('bbbbbbbb-0000-4000-8000-00000000000b', null, null)$$, 2);
select pg_temp.expect_call_fail('сводка: студент не получает', pg_temp.u(3),
  $$select * from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null)$$);
select pg_temp.expect_call_fail('сводка: староста B не получает сводку A', pg_temp.u(8),
  $$select * from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null)$$);
select pg_temp.expect_call_fail('сводка: преподаватель не получает', pg_temp.u(5),
  $$select * from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null)$$);

-- ===== 7. Закрытая группа = только просмотр =====
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_call_fail('закрыта: староста не создаёт справку', pg_temp.u(1),
  $$select public.certificate_create('t-a3', 'sick', null, null, null, null)$$);
select pg_temp.expect_call_fail('закрыта: староста не закрывает справку', pg_temp.u(1),
  $$select public.certificate_resolve((select id from public.certificates where student_id = 't-a1' limit 1), 'none', null)$$);
select pg_temp.expect_denied('закрыта: преподаватель не ставит оценку', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 7)$$);
select pg_temp.expect_denied('закрыта: преподаватель не меняет оценку', pg_temp.u(5), $$update public.grades set value = 3 where id = 'gr-a3l'$$);
select pg_temp.expect_call_fail('закрыта: студент не меняет подгруппу', pg_temp.u(3), 'select public.student_set_subgroup(1::smallint)');
select pg_temp.expect_min('закрыта: оценки читаются', pg_temp.u(3), 'select 1 from public.grades', 1);
select pg_temp.expect_min('закрыта: справки читаются', pg_temp.u(3), 'select 1 from public.certificates', 1);
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- ===== 8. Техработы =====
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_count('техработы: студент не читает уведомления', pg_temp.u(9), 'select 1 from public.notifications', 0);
select pg_temp.expect_count('техработы: студент не читает оценки', pg_temp.u(3), 'select 1 from public.grades', 0);
select pg_temp.expect_count('техработы: студент не читает расписание', pg_temp.u(3), 'select 1 from public.schedule_lessons', 0);
select pg_temp.expect_count('техработы: староста новой группы не читает справки', pg_temp.u(1), 'select 1 from public.certificates', 0);
select pg_temp.expect_call_fail('техработы: староста новой группы не создаёт справку (RPC)', pg_temp.u(1),
  $$select public.certificate_create('t-a3', 'sick', null, null, null, null)$$);
select pg_temp.expect_call_fail('техработы: студент не считает часы (RPC)', pg_temp.u(3),
  $$select public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_call_fail('техработы: староста не получает сводку (RPC)', pg_temp.u(1),
  $$select * from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null)$$);
select pg_temp.expect_call_fail('техработы: студент не меняет подгруппу (RPC)', pg_temp.u(3), 'select public.student_set_subgroup(1::smallint)');
select pg_temp.expect_denied('техработы: преподаватель не ставит оценку', pg_temp.u(5),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 7)$$);
select pg_temp.expect_min('техработы: сисадмин читает оценки', pg_temp.u(7), 'select 1 from public.grades', 1);
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===== 9. group_id в старых таблицах: триггер вместо default G24 =====
select pg_temp.expect_allowed('group_id: студент новой группы пишет событие без group_id (и без профиля)', pg_temp.u(3),
  $$insert into public.app_events (kind, ref) values ('homework_done', 'tk-n2')$$);
select pg_temp.expect_count('group_id: событие записано в группу A на свою запись', pg_temp.u(3),
  $$select 1 from public.app_events where ref = 'tk-n2' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and student_id = 't-a3'$$, 1);
select pg_temp.expect_denied('group_id: пользователь без группы не пишет событие', pg_temp.u(11),
  $$insert into public.app_events (kind, ref) values ('homework_done', 'zz')$$);
select pg_temp.expect_allowed('group_id: студент пишет свой значок без group_id', pg_temp.u(3),
  $$insert into public.student_achievements (student_id, code, period, semester) values ('t-a3', 'test_fill', '', 's')$$);
select pg_temp.expect_count('group_id: значок в группе студента', pg_temp.u(3),
  $$select 1 from public.student_achievements where code = 'test_fill' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1);
select pg_temp.expect_denied('group_id: студент A не пишет значок студенту B', pg_temp.u(3),
  $$insert into public.student_achievements (student_id, code, period, semester) values ('t-b2', 'test_fill2', '', 's')$$);
-- дальше пишет «сервис»: без вошедшего пользователя (as_user оставляет claims до конца транзакции)
select set_config('request.jwt.claims', '', true);
insert into public.game_records (student_id, game, difficulty, score) values ('t-b2', 'snake', 'none', 5);
insert into pg_temp.res select 'group_id: service-писатель рекорда без group_id → группа студента',
  exists (select 1 from public.game_records where student_id = 't-b2' and game = 'snake' and group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'), '';
insert into public.tasks (id, kind, rec) values ('tk-legacy', 'homework', '{"id":"tk-legacy","subject":"x"}');
insert into pg_temp.res select 'group_id: легаси-задание (taskstore, не клиент) без group_id → 24ДММ-2',
  exists (select 1 from public.tasks where id = 'tk-legacy' and group_id = '00000000-0000-4000-8000-000000000024'), '';
select pg_temp.expect_error('group_id: учебный день без group_id → ошибка, а не 24ДММ-2',
  $$insert into public.study_days (day, semester) values ('2099-02-01', 'x')$$);
select pg_temp.expect_error('group_id: значок несуществующего студента без group_id → ошибка',
  $$insert into public.student_achievements (student_id, code, period, semester) values ('нет-такого', 'x', '', 's')$$);

-- ===== 10. Значки посещаемости по группам =====
insert into public.study_days (group_id, day, semester) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-10-01', 'fall-test'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-10-02', 'fall-test'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-10-05', 'fall-test');
insert into pg_temp.res select 'значки: учебные дни группы A дают серию её студенту',
  exists (select 1 from public.attendance_badges_deserved() d
           where d.group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and d.student_id = 't-a3' and d.code = 'streak_3'), '';
insert into pg_temp.res select 'значки: группа B без учебных дней ничего не заслуживает',
  not exists (select 1 from public.attendance_badges_deserved() d where d.group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'), '';
insert into pg_temp.res select 'значки: 24ДММ-2 по-прежнему считается (journal_private)',
  exists (select 1 from public.attendance_badges_deserved() d where d.group_id = '00000000-0000-4000-8000-000000000024'), '';
insert into public.absences (id, group_id, student_id, date, subject, hours, created_by)
  values ('abs-oct', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-10-02', 'Статистика', 2, pg_temp.u(1));
insert into pg_temp.res select 'значки: пропуск группы A сам пересчитал значки (серия прервана, значок не выдан)',
  not exists (select 1 from public.student_achievements where student_id = 't-a3' and code = 'streak_3'), '';
insert into pg_temp.res select 'значки: пропуск группы A даёт anti_m2 за месяц с group_id A',
  exists (select 1 from public.student_achievements where student_id = 't-a3' and code = 'anti_m2' and period = '2026-10'
            and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and semester = 'fall-test'), '';
delete from public.absences where id = 'abs-oct';
insert into pg_temp.res select 'значки: отмена пропуска вернула серию и сняла anti_m2',
  exists (select 1 from public.student_achievements where student_id = 't-a3' and code = 'streak_3')
  and not exists (select 1 from public.student_achievements where student_id = 't-a3' and code = 'anti_m2' and period = '2026-10'), '';

-- ===== 11. Зеркало в journal_private (только 24ДММ-2) =====
create temp table jp0 as select students, absences from public.journal_private where id = 'main';
create temp table g24 as select id from public.students where group_id = '00000000-0000-4000-8000-000000000024' and id <> 't-l1' order by id limit 1;

-- чужая группа не трогает jsonb
insert into public.absences (id, group_id, student_id, date, subject, hours, created_by)
  values ('abs-m-a', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, pg_temp.u(1));
update public.absences set hours = 4 where id = 'abs-m-a';
delete from public.absences where id = 'abs-m-a';
insert into pg_temp.res select 'зеркало: пропуски группы A не попадают в journal_private',
  (select absences from public.journal_private) = (select absences from jp0), '';

-- вставка G24
insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
  select 'abs-m-1', '00000000-0000-4000-8000-000000000024', id, '2026-11-05', 'Тест-зеркало', 2, 'lecture', pg_temp.u(7) from g24;
insert into pg_temp.res select 'зеркало: вставка G24 добавила один элемент в формате 1.x',
  (select count(*) from public.journal_private, jsonb_array_elements(absences) e
    where e ->> 'id' = 'abs-m-1' and e ->> 'studentId' = (select id from g24) and e ->> 'date' = '2026-11-05'
      and (e ->> 'totalHours')::numeric = 2 and e ->> 'isExcused' = 'false' and e ->> 'subject' = 'Тест-зеркало') = 1
  and jsonb_array_length((select absences from public.journal_private)) = jsonb_array_length((select absences from jp0)) + 1, '';
-- правка
update public.absences set hours = 3, is_excused = true, cert_type = 'Больничный', cert_submitted = false where id = 'abs-m-1';
insert into pg_temp.res select 'зеркало: правка G24 обновила элемент без дубля',
  (select count(*) from public.journal_private, jsonb_array_elements(absences) e
    where e ->> 'id' = 'abs-m-1' and (e ->> 'totalHours')::numeric = 3 and e ->> 'isExcused' = 'true' and e ->> 'certType' = 'Больничный') = 1
  and (select count(*) from public.journal_private, jsonb_array_elements(absences) e where e ->> 'id' = 'abs-m-1') = 1, '';
-- повтор той же правки: jsonb не меняется (идемпотентность) и journal_private не переписывается
create temp table jp1 as select absences, updated_at from public.journal_private where id = 'main';
update public.absences set hours = 3, is_excused = true where id = 'abs-m-1';
insert into pg_temp.res select 'зеркало: повтор той же правки ничего не меняет',
  (select absences from public.journal_private) = (select absences from jp1), '';
-- правка легаси-пропуска: чужие ключи элемента сохраняются
create temp table leg as
  select e.v as before from public.journal_private j, jsonb_array_elements(j.absences) e(v)
    join public.absences a on a.id = e.v ->> 'id' and a.created_by is null
   order by e.v ->> 'id' limit 1;
update public.absences set comment = 'правка из кабинета' where id = (select before ->> 'id' from leg);
insert into pg_temp.res select 'зеркало: правка легаси-пропуска обновила комментарий и сохранила прочие ключи',
  exists (select 1 from public.journal_private, jsonb_array_elements(absences) e, leg
           where e ->> 'id' = leg.before ->> 'id' and e ->> 'comment' = 'правка из кабинета'
             and (select array_agg(k order by k) from jsonb_object_keys(leg.before) k) <@ (select array_agg(k) from jsonb_object_keys(e) k)), '';
-- удаление
delete from public.absences where id = 'abs-m-1';
insert into pg_temp.res select 'зеркало: удаление G24 убрало элемент',
  not exists (select 1 from public.journal_private, jsonb_array_elements(absences) e where e ->> 'id' = 'abs-m-1')
  and jsonb_array_length((select absences from public.journal_private)) = jsonb_array_length((select absences from jp0)), '';
-- студенты: правка имени доходит, isAdmin/role сохраняются; студент другой группы не попадает
create temp table st0 as select e.v as before from public.journal_private j, jsonb_array_elements(j.students) e(v)
  where e.v ->> 'id' = (select id from g24);
update public.students set first_name = 'Переименован' where id = (select id from g24);
insert into pg_temp.res select 'зеркало: правка студента G24 дошла, прочие ключи на месте',
  exists (select 1 from public.journal_private, jsonb_array_elements(students) e, st0
           where e ->> 'id' = (select id from g24) and e ->> 'firstName' = 'Переименован'
             and (select array_agg(k) from jsonb_object_keys(st0.before) k) <@ (select array_agg(k) from jsonb_object_keys(e) k)), '';
insert into pg_temp.res select 'зеркало: студенты других групп в journal_private не попадают',
  not exists (select 1 from public.journal_private, jsonb_array_elements(students) e where e ->> 'id' in ('t-a1', 't-a3', 't-b2')), '';
select pg_temp.expect_allowed('зеркало: староста новой группы пишет пропуск, триггер под его ролью не падает', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('x-m2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Статистика', 2, 'lecture', auth.uid())$$);

-- ===== 12. Служебные функции закрыты =====
select pg_temp.expect_call_fail('служебное: _notify_student недоступна клиенту', pg_temp.u(1),
  $$select public._notify_student('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'x', 'подделка', null, null)$$);
select pg_temp.expect_call_fail('служебное: recompute_attendance_badges недоступна клиенту', pg_temp.u(7),
  'select * from public.recompute_attendance_badges()');
select pg_temp.expect_call_fail('служебное: attendance_badges_deserved недоступна клиенту', pg_temp.u(3),
  'select * from public.attendance_badges_deserved()');
select pg_temp.expect_call_fail('служебное: journal_private_mirror недоступна клиенту', pg_temp.u(1),
  'select public.journal_private_mirror()');
