-- Тесты 2.0.1: след отмены пропусков (absence_cancellations), доступ студента к внесению домашки
-- (homework_editors, can_add_homework, homework_access_set, политики tasks), пропуски по лабораторным.
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 5 препод лекций A, 7 сисадмин, 8 староста B,
-- 9 студент B, 10 студент 24ДММ-2; t-a5 — свободная запись группы A.

-- значение выражения под пользователем текстом ('ERR:<sqlstate>' при ошибке)
create function pg_temp.val_as(u uuid, expr text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(u);
  begin execute 'select (' || expr || ')::text' into v; exception when others then v := 'ERR:' || sqlstate; end;
  execute 'reset role';
  return v;
end $$;
-- оператор под пользователем: 'ok:<строк>' или sqlstate ошибки
create function pg_temp.state_as(u uuid, stmt text) returns text language plpgsql as $$
declare n bigint; v text;
begin
  perform pg_temp.as_user(u);
  begin execute stmt; get diagnostics n = row_count; v := 'ok:' || n;
  exception when others then v := sqlstate || ':' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.is(t text, got text, want text) returns void language sql as
$$ insert into pg_temp.res values (t, got is not distinct from want, 'ожидалось ' || want || ', получено ' || coalesce(got, 'null')) $$;
create function pg_temp.starts(t text, got text, want text) returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(got like want || '%', false), 'ожидалось ' || want || '…, получено ' || coalesce(left(got, 40), 'null')) $$;
create function pg_temp.ok(t text, c boolean, d text default '') returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(c, false), coalesce(d, 'null')) $$;
-- вставка домашки/дедлайна в tasks
create function pg_temp.task(id text, kind text, grp text, by_expr text default 'auth.uid()') returns text language sql as
$$ select format('insert into public.tasks (id, kind, rec, group_id, created_by) values (%L, %L, %L::jsonb, %L, %s)',
                 id, kind, jsonb_build_object('id', id, 'subject', 'Статистика', 'text', 'тест'), grp, by_expr) $$;

-- триггеры tasks (tasks_notify, zz_fill_group_id) prelude выключил: включаем — вставка студентом должна их пройти
alter table public.tasks enable trigger user;

-- ===================================================================================================
-- 1. Отмена пропуска старостой: след, исчезновение, пересчёт часов
-- ===================================================================================================
select pg_temp.expect_allowed('отмена: староста вносит пропуск (сегодня, 3 ч)', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, comment)
    values ('v2-abs', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', (now() at time zone 'Europe/Minsk')::date,
            'Статистика', 3, 'lecture', 'опоздал')$$);
create temp table h0 as select
  pg_temp.val_as(pg_temp.u(3), $$public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a') ->> 'total'$$)::numeric as my,
  pg_temp.val_as(pg_temp.u(1), $$(select total from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null) where student_id = 't-a3')$$)::numeric as sm;
select pg_temp.expect_allowed('отмена: староста удаляет свою запись (DELETE, как клиент)', pg_temp.u(1),
  $$delete from public.absences where id = 'v2-abs'$$);
select pg_temp.ok('отмена: пропуска больше нет', not exists (select 1 from public.absences where id = 'v2-abs'));
select pg_temp.ok('отмена: след — кто, когда, группа, студент',
  exists (select 1 from public.absence_cancellations where absence_id = 'v2-abs' and cancelled_by = pg_temp.u(1)
           and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and student_id = 't-a3'
           and cancelled_at > now() - interval '1 minute'));
select pg_temp.ok('отмена: в следе пропуск целиком (jsonb)',
  exists (select 1 from public.absence_cancellations where absence_id = 'v2-abs'
           and (absence ->> 'hours')::numeric = 3 and absence ->> 'subject' = 'Статистика'
           and absence ->> 'lesson_kind' = 'lecture' and absence ->> 'comment' = 'опоздал'
           and absence ->> 'created_by' = pg_temp.u(1)::text));
select pg_temp.is('отмена: absence_hours_my уменьшились на 3',
  (pg_temp.val_as(pg_temp.u(3), $$public.absence_hours_my('aaaaaaaa-0000-4000-8000-00000000000a') ->> 'total'$$)::numeric
     - (select my from h0))::text, '-3');
select pg_temp.is('отмена: group_absence_summary уменьшилась на 3',
  (pg_temp.val_as(pg_temp.u(1), $$(select total from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null) where student_id = 't-a3')$$)::numeric
     - (select sm from h0))::text, '-3');
-- удаление владельцем / service_role (импорт, Edge Function): след с cancelled_by null
-- (клеймы прошлого as_user живут до конца транзакции — ставим клеймы service_role без sub)
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
delete from public.absences where id = 'abs-b1';
select pg_temp.ok('отмена сервером: след без автора',
  exists (select 1 from public.absence_cancellations where absence_id = 'abs-b1' and cancelled_by is null));
select pg_temp.expect_denied('отмена: студент по-прежнему не удаляет пропуск', pg_temp.u(3),
  $$delete from public.absences where id = 'abs-a1'$$);
select pg_temp.ok('отмена: отказанное удаление следа не оставляет',
  not exists (select 1 from public.absence_cancellations where absence_id = 'abs-a1'));

-- кто читает след
select pg_temp.expect_count('след: студент не читает', pg_temp.u(3), 'select 1 from public.absence_cancellations', 0);
select pg_temp.expect_count('след: староста A видит свою группу', pg_temp.u(1),
  $$select 1 from public.absence_cancellations where absence_id = 'v2-abs'$$, 1);
select pg_temp.expect_count('след: заместитель A видит', pg_temp.u(2),
  $$select 1 from public.absence_cancellations where absence_id = 'v2-abs'$$, 1);
select pg_temp.expect_count('след: староста A не видит группу B', pg_temp.u(1),
  $$select 1 from public.absence_cancellations where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0);
select pg_temp.expect_count('след: староста B не видит группу A', pg_temp.u(8),
  $$select 1 from public.absence_cancellations where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0);
select pg_temp.expect_count('след: преподаватель не читает', pg_temp.u(5), 'select 1 from public.absence_cancellations', 0);
select pg_temp.expect_min('след: сисадмин видит всё', pg_temp.u(7),
  $$select 1 from public.absence_cancellations where absence_id in ('v2-abs', 'abs-b1')$$, 2);
select pg_temp.expect_denied('след: клиент не пишет', pg_temp.u(1),
  $$insert into public.absence_cancellations (absence_id, group_id, student_id, absence)
    values ('x', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '{}')$$);
select pg_temp.expect_denied('след: клиент не правит', pg_temp.u(1), $$update public.absence_cancellations set absence = '{}'$$);
select pg_temp.expect_denied('след: клиент не удаляет', pg_temp.u(7), $$delete from public.absence_cancellations$$);

-- ===================================================================================================
-- 2. Доступ к домашке
-- ===================================================================================================
select pg_temp.starts('без права: студент не вносит домашку', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw0', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a')), '42501');
select pg_temp.is('без права: can_add_homework = false',
  pg_temp.val_as(pg_temp.u(3), $$public.can_add_homework('aaaaaaaa-0000-4000-8000-00000000000a')$$), 'false');

-- кто не выдаёт
select pg_temp.starts('выдача: студент не выдаёт', pg_temp.state_as(pg_temp.u(3), $$select public.homework_access_set('t-a3', true)$$), '42501');
select pg_temp.starts('выдача: староста B не выдаёт студенту A', pg_temp.state_as(pg_temp.u(8), $$select public.homework_access_set('t-a3', true)$$), '42501');
select pg_temp.starts('выдача: преподаватель не выдаёт', pg_temp.state_as(pg_temp.u(5), $$select public.homework_access_set('t-a3', true)$$), '42501');
select pg_temp.starts('выдача: нет записи → not_found', pg_temp.state_as(pg_temp.u(1), $$select public.homework_access_set('t-nope', true)$$), 'P0002');
select pg_temp.starts('выдача: null → bad_request', pg_temp.state_as(pg_temp.u(1), $$select public.homework_access_set('t-a3', null)$$), '22023');
do $$ declare failed boolean := false; begin
  perform pg_temp.as_anon();
  begin perform public.homework_access_set('t-a3', true); exception when others then failed := true; end;
  execute 'reset role';
  insert into pg_temp.res values ('выдача: anon не вызывает', failed, case when failed then 'отказ' else 'вызов прошёл' end);
end $$;
select pg_temp.ok('права: anon не исполняет can_add_homework/homework_access_set',
  not has_function_privilege('anon', 'public.can_add_homework(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.homework_access_set(text, boolean)', 'execute'));
select pg_temp.ok('права: триггерные функции закрыты для клиентов',
  not has_function_privilege('authenticated', 'public.absences_log_cancel()', 'execute')
  and not has_function_privilege('authenticated', 'public.students_erased_v201_cleanup()', 'execute')
  and not has_function_privilege('anon', 'public.absences_log_cancel()', 'execute'));
select pg_temp.ok('права: клиент не пишет homework_editors напрямую',
  not has_table_privilege('authenticated', 'public.homework_editors', 'insert')
  and not has_table_privilege('authenticated', 'public.homework_editors', 'delete'));

-- выдача
select pg_temp.is('выдача: староста → студент', pg_temp.state_as(pg_temp.u(1), $$select public.homework_access_set('t-a3', true)$$), 'ok:1');
select pg_temp.is('выдача: повтор не ошибка', pg_temp.state_as(pg_temp.u(1), $$select public.homework_access_set('t-a3', true)$$), 'ok:1');
select pg_temp.is('выдача: заместитель → свободная запись', pg_temp.state_as(pg_temp.u(2), $$select public.homework_access_set('t-a5', true)$$), 'ok:1');
select pg_temp.ok('выдача: строка и granted_by',
  exists (select 1 from public.homework_editors where student_id = 't-a3' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
           and granted_by = pg_temp.u(1)));
select pg_temp.ok('выдача: audit_log',
  exists (select 1 from public.audit_log where action = 'homework_access_set' and actor = pg_temp.u(1)
           and details ->> 'student_id' = 't-a3' and details ->> 'on' = 'true'));
select pg_temp.is('с правом: can_add_homework = true',
  pg_temp.val_as(pg_temp.u(3), $$public.can_add_homework('aaaaaaaa-0000-4000-8000-00000000000a')$$), 'true');

-- кто видит права
select pg_temp.expect_count('доступы: студент видит свою строку', pg_temp.u(3), 'select 1 from public.homework_editors', 1);
select pg_temp.expect_count('доступы: студент не видит чужую', pg_temp.u(3),
  $$select 1 from public.homework_editors where student_id = 't-a5'$$, 0);
select pg_temp.expect_count('доступы: староста видит все в группе', pg_temp.u(1), 'select 1 from public.homework_editors', 2);
select pg_temp.expect_count('доступы: студент B не видит', pg_temp.u(9), 'select 1 from public.homework_editors', 0);
select pg_temp.expect_count('доступы: староста B не видит', pg_temp.u(8), 'select 1 from public.homework_editors', 0);

-- что может студент с правом
select pg_temp.is('с правом: домашка вносится', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw1', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a')), 'ok:1');
select pg_temp.ok('с правом: уведомление группе ушло (tasks_notify)',
  exists (select 1 from public.notifications where ref ->> 'task_id' = 'v2-hw1' and user_id = pg_temp.u(1)));
select pg_temp.starts('с правом: дедлайн — отказ', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-dl1', 'deadline', 'aaaaaaaa-0000-4000-8000-00000000000a')), '42501');
select pg_temp.starts('с правом: чужой created_by — отказ', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw2', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a', quote_literal(pg_temp.u(1)) || '::uuid')), '42501');
select pg_temp.starts('с правом: created_by null — отказ', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw3', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a', 'null')), '42501');
select pg_temp.starts('с правом: чужая группа — отказ', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw4', 'homework', 'bbbbbbbb-0000-4000-8000-00000000000b')), '42501');
select pg_temp.expect_allowed('с правом: правит свою домашку', pg_temp.u(3),
  $$update public.tasks set rec = rec || '{"text":"исправлено"}' where id = 'v2-hw1'$$);
select pg_temp.expect_denied('с правом: свою домашку в дедлайн не переводит', pg_temp.u(3),
  $$update public.tasks set kind = 'deadline' where id = 'v2-hw1'$$);
select pg_temp.expect_denied('с правом: автора не меняет', pg_temp.u(3),
  $$update public.tasks set created_by = null where id = 'v2-hw1'$$);
select pg_temp.expect_denied('с правом: легаси-задание не правит', pg_temp.u(3),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'tk-a1'$$);
select pg_temp.expect_denied('с правом: легаси-задание не удаляет', pg_temp.u(3), $$delete from public.tasks where id = 'tk-a1'$$);
select pg_temp.expect_allowed('староста вносит своё задание', pg_temp.u(1),
  pg_temp.task('v2-head', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_denied('с правом: задание старосты не правит', pg_temp.u(3),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'v2-head'$$);
select pg_temp.expect_denied('с правом: задание старосты не удаляет', pg_temp.u(3), $$delete from public.tasks where id = 'v2-head'$$);
select pg_temp.is('право в группе A не действует для студента B',
  pg_temp.val_as(pg_temp.u(9), $$public.can_add_homework('aaaaaaaa-0000-4000-8000-00000000000a')$$), 'false');
select pg_temp.starts('без права: студент B не вносит в свою группу', pg_temp.state_as(pg_temp.u(9),
  pg_temp.task('v2-hwb', 'homework', 'bbbbbbbb-0000-4000-8000-00000000000b')), '42501');
select pg_temp.expect_allowed('с правом: вносит вторую', pg_temp.u(3),
  pg_temp.task('v2-hw5', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a'));
select pg_temp.expect_allowed('с правом: удаляет свою', pg_temp.u(3), $$delete from public.tasks where id = 'v2-hw5'$$);

-- закрытая группа
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.starts('закрытая группа: студент с правом не вносит', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw6', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a')), '42501');
select pg_temp.expect_denied('закрытая группа: не правит свою', pg_temp.u(3),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'v2-hw1'$$);
select pg_temp.starts('закрытая группа: выдача → group_closed', pg_temp.state_as(pg_temp.u(1),
  $$select public.homework_access_set('t-a3', false)$$), '42501:group_closed');
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- отзыв
select pg_temp.is('отзыв: староста снимает право', pg_temp.state_as(pg_temp.u(1), $$select public.homework_access_set('t-a3', false)$$), 'ok:1');
select pg_temp.ok('отзыв: строки нет, audit_log on=false',
  not exists (select 1 from public.homework_editors where student_id = 't-a3')
  and exists (select 1 from public.audit_log where action = 'homework_access_set' and details ->> 'student_id' = 't-a3'
               and details ->> 'on' = 'false'));
select pg_temp.starts('отзыв: студент снова не вносит', pg_temp.state_as(pg_temp.u(3),
  pg_temp.task('v2-hw7', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a')), '42501');
select pg_temp.expect_denied('отзыв: свою прежнюю домашку больше не правит', pg_temp.u(3),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'v2-hw1'$$);

-- стирание студента: право снимается, свободный текст из следа отмен убирается, повторная выдача — not_found
insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, comment)
  values ('v2-a5', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a5', '2026-11-02', 'Статистика', 2, 'lecture', 'личное');
delete from public.absences where id = 'v2-a5';
update public.students set erased_at = now(), claim_status = 'erased' where id = 't-a5';
select pg_temp.ok('стирание: право снято', not exists (select 1 from public.homework_editors where student_id = 't-a5'));
select pg_temp.ok('стирание: comment убран из следа, остальное осталось',
  exists (select 1 from public.absence_cancellations where absence_id = 'v2-a5'
           and not (absence ? 'comment') and (absence ->> 'hours')::numeric = 2));
select pg_temp.starts('стирание: выдача стёртому → not_found', pg_temp.state_as(pg_temp.u(1),
  $$select public.homework_access_set('t-a5', true)$$), 'P0002');

-- ===================================================================================================
-- 3. Техработы (общий режим пропускает только сисадмина и старосту 24ДММ-2 — проверяем на 24ДММ-2)
-- ===================================================================================================
do $$ begin
  if not exists (select 1 from public.memberships where group_id = '00000000-0000-4000-8000-000000000024'
                  and status = 'active' and extra_role = 'headman') then
    insert into public.students (id, group_id, last_name, first_name, claim_status, claimed_by)
      values ('t-l2', '00000000-0000-4000-8000-000000000024', 'Легаси', 'Староста', 'active', pg_temp.u(11));
    insert into public.memberships (user_id, group_id, student_id, base_role, extra_role, status)
      values (pg_temp.u(11), '00000000-0000-4000-8000-000000000024', 't-l2', 'student', 'headman', 'active');
  end if;
end $$;
create temp table g24h as select user_id as id from public.memberships
  where group_id = '00000000-0000-4000-8000-000000000024' and status = 'active' and extra_role = 'headman';
grant select on g24h to public;
select pg_temp.is('24ДММ-2: староста выдаёт право студенту', pg_temp.state_as((select id from g24h),
  $$select public.homework_access_set('t-l1', true)$$), 'ok:1');
select pg_temp.is('24ДММ-2: студент с правом вносит без техработ', pg_temp.state_as(pg_temp.u(10),
  pg_temp.task('v2-g1', 'homework', '00000000-0000-4000-8000-000000000024')), 'ok:1');
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.starts('техработы: студент с правом не вносит', pg_temp.state_as(pg_temp.u(10),
  pg_temp.task('v2-g2', 'homework', '00000000-0000-4000-8000-000000000024')), '42501');
select pg_temp.expect_denied('техработы: студент с правом не удаляет свою', pg_temp.u(10), $$delete from public.tasks where id = 'v2-g1'$$);
select pg_temp.is('техработы: староста 24ДММ-2 вносит', pg_temp.state_as((select id from g24h),
  pg_temp.task('v2-g3', 'homework', '00000000-0000-4000-8000-000000000024')), 'ok:1');
select pg_temp.expect_count('техработы: студент не читает доступы', pg_temp.u(10), 'select 1 from public.homework_editors', 0);
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===================================================================================================
-- 4. Лабораторные
-- ===================================================================================================
select pg_temp.is('лаб: староста вносит пропуск lab', pg_temp.state_as(pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind)
    values ('v2-lab', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'lab')$$), 'ok:1');
select pg_temp.starts('лаб: вид other — check (23514)', pg_temp.state_as(pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind)
    values ('v2-oth', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'other')$$), '23514');
select pg_temp.expect_count('лаб: лектор этой дисциплины не видит lab-пропуск', pg_temp.u(5),
  $$select 1 from public.absences where id = 'v2-lab'$$, 0);
select pg_temp.expect_count('лаб: студент видит свой lab-пропуск', pg_temp.u(3),
  $$select 1 from public.absences where id = 'v2-lab'$$, 1);
select pg_temp.ok('лаб: уведомление студенту «лабораторная»',
  exists (select 1 from public.notifications where user_id = pg_temp.u(3) and ref ->> 'absence_id' = 'v2-lab'
           and body like '%лабораторная%'));
select pg_temp.is('лаб: _lesson_kind_ru прежние значения', public._lesson_kind_ru('lecture') || '/' || public._lesson_kind_ru('practice'),
  'лекция/практическое');
select pg_temp.ok('лаб: _lesson_kind_ru закрыта для клиентов',
  not has_function_privilege('authenticated', 'public._lesson_kind_ru(text)', 'execute'));
