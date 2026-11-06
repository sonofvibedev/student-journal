-- Тесты этапа 6: удаление персональных данных (заявки, стирание студента, выпускники через год).
-- Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё, в т. ч. удаление из auth.users).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A, 6 препод ПЗ A,
-- 7 сисадмин, 8 староста B, 9 студент B, 10 студент 24ДММ-2, 11 без групп.
-- Номера пользователей фиксируются заранее: pg_temp.u(n) из prelude считает по порядку email и «съехал» бы
-- после удаления аккаунтов.

create temp table uu as select i, pg_temp.u(i) as id from generate_series(1, 11) i;
grant select on uu to public;
create or replace function pg_temp.u(n int) returns uuid language sql as $$ select uu.id from pg_temp.uu where uu.i = n $$;

create temp table kv (k text primary key, v jsonb);
grant all on kv to public;

-- ===== помощники этого набора (как в ops.sql) =====
create function pg_temp.val_as(u uuid, q text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(u);
  begin execute 'select (' || q || ')::text' into v; exception when others then v := 'ERR:' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create function pg_temp.expect_err(t text, u uuid, q text, code text) returns void language plpgsql as $$
declare got text := pg_temp.val_as(u, q);
begin
  insert into pg_temp.res values (t, got = 'ERR:' || code, 'ожидалось ERR:' || code || ', получено ' || coalesce(got, 'null'));
end $$;
create function pg_temp.expect_val(t text, u uuid, q text, want text) returns void language plpgsql as $$
declare got text := pg_temp.val_as(u, q);
begin
  insert into pg_temp.res values (t, got is not distinct from want, 'ожидалось ' || coalesce(want, 'null') || ', получено ' || coalesce(got, 'null'));
end $$;
-- вызов под пользователем с сохранением ответа в kv
create function pg_temp.keep(p_k text, u uuid, q text) returns void language plpgsql as $$
declare got text := pg_temp.val_as(u, q);
begin
  insert into pg_temp.kv values (p_k, case when got like 'ERR:%' then to_jsonb(got) else got::jsonb end)
    on conflict (k) do update set v = excluded.v;
end $$;
create function pg_temp.ok(t text, c boolean, d text default '') returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(c, false), coalesce(d, 'null')) $$;
create function pg_temp.anon_fails(t text, q text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  perform pg_temp.as_anon();
  begin execute 'select ' || q; exception when others then failed := true; end;
  execute 'reset role';
  insert into pg_temp.res values (t, failed, case when failed then 'отказ' else 'вызов прошёл' end);
end $$;
create function pg_temp.alive(n int) returns boolean language sql as
$$ select exists (select 1 from auth.users where id = pg_temp.u(n)) $$;
-- сколько строк во всех таблицах public содержат подстроку (имена таблиц экранирует %I)
create function pg_temp.text_hits(p text) returns bigint language plpgsql as $$
declare t text; n bigint; total bigint := 0;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop
    execute format('select count(*) from public.%I x where x::text like %L', t, '%' || p || '%') into n;
    total := total + n;
  end loop;
  return total;
end $$;

-- ===== фикстуры: студент 3 (t-a3) с узнаваемым ФИО и следами везде =====
update public.students set last_name = 'Эрасов', first_name = 'Феликс', telegram = '{"username":"erasov_f"}' where id = 't-a3';
update public.absences set comment = 'Эрасов опоздал' where id = 'abs-a1';
insert into public.certificates (id, group_id, student_id, kind, note, created_by)
  values ('ce-er1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick', 'Эрасов Феликс болел', pg_temp.u(1));
insert into public.grades (id, group_id, student_id, subject, lesson_kind, value, comment, created_by)
  values ('gr-er1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 7, 'Феликс Эрасов молодец', pg_temp.u(5));
insert into public.notification_prefs (user_id, kind, enabled) values (pg_temp.u(3), 'task', false);
insert into public.tg_links (user_id, telegram_id) values (pg_temp.u(3), 777000001);
insert into public.tg_rebind (user_id, old_telegram_id) values (pg_temp.u(3), 777000001);
insert into public.tg_subscribers (chat_id, tg_user_id, tg_name) values (777000001, 777000001, 'Феликс Эрасов');
insert into public.tg_dialog_state (telegram_id, step) values (777000001, 'x');
insert into public.tg_task_log (user_id, telegram_id, kind) values (pg_temp.u(3), 777000001, 'homework');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (pg_temp.u(3), 'https://push.test/erasov', 'p', 'a');
insert into public.notify_log (item_id, stage, target) values ('it-er', 'day1', 'https://push.test/erasov'), ('it-er', 'due', 'tg:777000001');
insert into public.pass_tokens (token_hash, user_id, student_id, expires_at)
  values (encode(extensions.digest('erasov', 'sha256'), 'hex'), pg_temp.u(3), 't-a3', now() + interval '1 hour');
insert into public.invite_codes (student_id, code_hash) values ('t-a3', encode(extensions.digest('erasov-code', 'sha256'), 'hex'));
insert into public.word_attempts (student_id, day, mode) values ('t-a3', '2099-01-01', 'ranks');
insert into public.assoc_daily_results (day, student_id, place, points, bonus, finished_at) values ('2099-01-01', 't-a3', 1, 10, 5, now());
insert into public.remind_log (group_id, student_id, last_at) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', now());
insert into public.consents (user_id, group_id, version) values (pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'v1');
insert into public.audit_log (actor, group_id, action, details)
  values (pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 'test_note', '{"text": "звонил Эрасов Феликс"}');
insert into public.registration_requests (owner_user_id, status, group_id, payload) values (pg_temp.u(1), 'approved',
  'aaaaaaaa-0000-4000-8000-00000000000a',
  '{"group": {"name": "ТЕСТ-1"}, "owner": {"name": "Тестов Староста", "studentIndex": 0},
    "students": [{"last_name": "Тестов", "first_name": "Староста"}, {"last_name": "Эрасов", "first_name": "Феликс", "study_form": "budget"}]}');
insert into public.notifications (user_id, group_id, kind, title, body, ref)
  values (pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 'certificate', 'Справка подтверждена', 'Эрасов Феликс: Больничный',
          '{"student_id": "t-a3"}');
-- чат заместителя 2 с преподавателем 5
insert into public.chat_keys (user_id, public_jwk, backup) values (pg_temp.u(2), '{"kty": "EC"}', '{}'), (pg_temp.u(5), '{"kty": "EC"}', '{}');
insert into public.chat_threads (id, group_id, student_user_id, teacher_user_id, kind)
  values ('dddddddd-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(2), pg_temp.u(5), 'lecture');
insert into public.chat_messages (thread_id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext)
  values ('dddddddd-0000-4000-8000-0000000000c1', pg_temp.u(5), 1, 1, 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA');
insert into public.chat_reads (thread_id, user_id) values ('dddddddd-0000-4000-8000-0000000000c1', pg_temp.u(5));

select pg_temp.ok('фикстуры: поиск по тексту находит ФИО до стирания', pg_temp.text_hits('Эрасов') >= 6, pg_temp.text_hits('Эрасов')::text);

-- ===== 1. Права =====
select pg_temp.anon_fails('права: аноним не подаёт заявку', $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.anon_fails('права: аноним не читает заявки', $$public.data_deletion_requests_list(null)$$);
select pg_temp.anon_fails('права: аноним не стирает', $$public.sysadmin_erase_student('t-a3')$$);
select pg_temp.expect_call_fail('права: студент не вызывает _erase_student', pg_temp.u(3),
  $$select public._erase_student('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3')$$);
select pg_temp.expect_call_fail('права: сисадмин тоже не вызывает _erase_student', pg_temp.u(7),
  $$select public._erase_student('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3')$$);
select pg_temp.expect_call_fail('права: студент не вызывает _delete_accounts', pg_temp.u(3),
  $$select public._delete_accounts(array[pg_temp.u(9)])$$);
select pg_temp.expect_call_fail('права: студент не вызывает graduates_cleanup', pg_temp.u(3), $$select public.graduates_cleanup()$$);
select pg_temp.expect_call_fail('права: сисадмин не вызывает graduates_cleanup', pg_temp.u(7), $$select public.graduates_cleanup()$$);
select pg_temp.ok('права: после отказов t-a3 не стёрт и аккаунт 3 жив',
  (select erased_at is null from public.students where id = 't-a3') and pg_temp.alive(3));
select pg_temp.expect_err('права: студент не стирает студента чужой группы', pg_temp.u(3), $$public.sysadmin_erase_student('t-b2')$$, 'forbidden');
select pg_temp.expect_err('права: староста не стирает напрямую', pg_temp.u(1), $$public.sysadmin_erase_student('t-a3')$$, 'forbidden');
select pg_temp.expect_err('права: студент B не подаёт заявку в группу A', pg_temp.u(9),
  $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'not_student');
select pg_temp.expect_err('права: преподаватель не подаёт заявку', pg_temp.u(5),
  $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'not_student');
select pg_temp.expect_err('права: ожидающий подтверждения не подаёт заявку', pg_temp.u(4),
  $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'not_student');
select pg_temp.expect_err('права: староста B не видит заявки A', pg_temp.u(8),
  $$public.data_deletion_requests_list('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'forbidden');
select pg_temp.expect_err('права: студент не видит заявки группы', pg_temp.u(3),
  $$public.data_deletion_requests_list('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'forbidden');
select pg_temp.expect_err('права: все группы — только сисадмин', pg_temp.u(1),
  $$public.data_deletion_requests_list(null)$$, 'forbidden');
select pg_temp.ok('права: клиентам нет execute на внутренние и служебные',
  not has_function_privilege('authenticated', 'public._erase_student(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public._erase_student(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public._delete_accounts(uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.graduates_cleanup()', 'execute')
  and has_function_privilege('service_role', 'public.graduates_cleanup()', 'execute')
  and not has_function_privilege('anon', 'public.request_data_deletion(uuid)', 'execute'));
select pg_temp.expect_count('права: студент напрямую в таблицу заявок не пишет', pg_temp.u(3),
  $$select 1 from information_schema.role_table_grants where table_name = 'data_deletion_requests' and grantee = 'authenticated' and privilege_type <> 'SELECT'$$, 0);

-- ===== 2. Заявка, повтор, отзыв, отказ =====
select pg_temp.keep('r1', pg_temp.u(3), $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.keep('r1b', pg_temp.u(3), $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.ok('заявка: подана', (select v ->> 'status' = 'pending' and (v ->> 'already')::boolean = false from pg_temp.kv where k = 'r1'),
  (select v::text from pg_temp.kv where k = 'r1'));
select pg_temp.ok('заявка: повтор возвращает ту же открытую',
  (select (b.v ->> 'already')::boolean and b.v ->> 'request_id' = a.v ->> 'request_id' from pg_temp.kv a, pg_temp.kv b where a.k = 'r1' and b.k = 'r1b'));
select pg_temp.ok('заявка: староста и зам получили уведомление без ФИО',
  (select count(*) from public.notifications where kind = 'erasure' and user_id in (pg_temp.u(1), pg_temp.u(2))
     and body not like '%Эрасов%') = 2);
select pg_temp.expect_val('заявка: студент видит свою', pg_temp.u(3), $$public.my_data_deletion() ->> 'status'$$, 'pending');
select pg_temp.expect_count('заявка: студент читает только свою строку', pg_temp.u(3), $$select 1 from public.data_deletion_requests$$, 1);
select pg_temp.expect_count('заявка: студент B чужих строк не видит', pg_temp.u(9), $$select 1 from public.data_deletion_requests$$, 0);
select pg_temp.expect_val('отзыв: студент отзывает', pg_temp.u(3), $$public.withdraw_data_deletion() ->> 'ok'$$, 'true');
select pg_temp.expect_val('отзыв: статус withdrawn', pg_temp.u(3), $$public.my_data_deletion() ->> 'status'$$, 'withdrawn');
select pg_temp.expect_err('отзыв: повторно → not_pending', pg_temp.u(3), $$public.withdraw_data_deletion()$$, 'not_pending');
-- внутри транзакции now() один: «раньше» задаём явно
update public.data_deletion_requests set created_at = now() - interval '1 hour' where id = (select (v ->> 'request_id')::uuid from pg_temp.kv where k = 'r1');
select pg_temp.keep('r2', pg_temp.u(3), $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.ok('заявка: после отзыва — новая', (select a.v ->> 'request_id' <> b.v ->> 'request_id' from pg_temp.kv a, pg_temp.kv b where a.k = 'r1' and b.k = 'r2'));
select pg_temp.expect_val('список: староста видит обе, открытую может решить', pg_temp.u(1),
  $$(select count(*) || ':' || count(*) filter (where can_resolve and status = 'pending' and requester_role = 'student' and student_name = 'Эрасов Феликс') from public.data_deletion_requests_list('aaaaaaaa-0000-4000-8000-00000000000a'))$$, '2:1');
select pg_temp.expect_val('отказ: староста отклоняет', pg_temp.u(1),
  format($$public.resolve_data_deletion(%L, false, 'нужно заявление в деканат') ->> 'status'$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r2')), 'rejected');
select pg_temp.expect_err('отказ: повторное решение → not_pending', pg_temp.u(1),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r2')), 'not_pending');
select pg_temp.ok('отказ: студенту пришло уведомление с причиной',
  exists (select 1 from public.notifications where user_id = pg_temp.u(3) and kind = 'erasure' and body = 'нужно заявление в деканат'));
select pg_temp.expect_val('отказ: студент видит rejected и причину', pg_temp.u(3),
  $$public.my_data_deletion() ->> 'status' || '|' || (public.my_data_deletion() ->> 'note')$$, 'rejected|нужно заявление в деканат');
select pg_temp.ok('отказ: аккаунт и запись целы', pg_temp.alive(3) and (select erased_at is null from public.students where id = 't-a3'));
select pg_temp.keep('r3', pg_temp.u(3), $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_err('решение: староста B → forbidden', pg_temp.u(8),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'forbidden');
select pg_temp.expect_err('решение: сам студент → forbidden', pg_temp.u(3),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'forbidden');
select pg_temp.expect_err('решение: преподаватель → forbidden', pg_temp.u(5),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'forbidden');
select pg_temp.expect_err('решение: без решения → bad_decision', pg_temp.u(1),
  format($$public.resolve_data_deletion(%L, null, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'bad_decision');
select pg_temp.expect_err('решение: неизвестная заявка → not_found', pg_temp.u(1),
  $$public.resolve_data_deletion('dddddddd-0000-4000-8000-0000000000ff', true, null)$$, 'not_found');

-- ===== 3. Заявку заместителя решает только сисадмин; чат заместителя исчезает =====
select pg_temp.keep('d1', pg_temp.u(2), $$public.request_data_deletion('aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.ok('зам: уведомление сисадмину', exists (select 1 from public.notifications where user_id = pg_temp.u(7) and kind = 'erasure'
  and ref ->> 'request_id' = (select v ->> 'request_id' from pg_temp.kv where k = 'd1')));
select pg_temp.expect_err('зам: староста не решает заявку заместителя', pg_temp.u(1),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'd1')), 'forbidden');
select pg_temp.expect_val('зам: у старосты can_resolve = false', pg_temp.u(1),
  format($$(select can_resolve from public.data_deletion_requests_list('aaaaaaaa-0000-4000-8000-00000000000a') where id = %L)$$,
         (select v ->> 'request_id' from pg_temp.kv where k = 'd1')), 'false');
select pg_temp.expect_val('зам: сисадмин одобряет', pg_temp.u(7),
  format($$public.resolve_data_deletion(%L, true, null) ->> 'status'$$, (select v ->> 'request_id' from pg_temp.kv where k = 'd1')), 'done');
select pg_temp.ok('зам: аккаунт удалён, запись обезличена', not pg_temp.alive(2)
  and (select claim_status = 'erased' and last_name = 'Удалён' and erased_at is not null from public.students where id = 't-a2'));
select pg_temp.ok('зам: тред, сообщения, отметки и ключи заместителя удалены',
  not exists (select 1 from public.chat_threads where id = 'dddddddd-0000-4000-8000-0000000000c1')
  and not exists (select 1 from public.chat_messages where thread_id = 'dddddddd-0000-4000-8000-0000000000c1')
  and not exists (select 1 from public.chat_reads where thread_id = 'dddddddd-0000-4000-8000-0000000000c1')
  and not exists (select 1 from public.chat_keys where user_id = pg_temp.u(2)));
select pg_temp.ok('зам: преподаватель и его ключ целы', pg_temp.alive(5) and exists (select 1 from public.chat_keys where user_id = pg_temp.u(5)));
select pg_temp.ok('зам: староста остался единственным, заместителя нет',
  (select count(*) from public.memberships where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and status = 'active' and extra_role = 'headman' and user_id = pg_temp.u(1)) = 1
  and not exists (select 1 from public.memberships where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and extra_role = 'deputy'));
select pg_temp.ok('зам: пропуски, внесённые заместителем, стали «легаси» (created_by null)',
  (select created_by is null from public.absences where id = 'abs-a3'));
select pg_temp.ok('зам: заявка done, user_id обнулён вместе с аккаунтом',
  (select status = 'done' and user_id is null and reviewed_by = pg_temp.u(7) from public.data_deletion_requests
    where id = (select (v ->> 'request_id')::uuid from pg_temp.kv where k = 'd1')));

-- ===== 4. Староста одобряет заявку студента: стирание =====
select pg_temp.expect_val('стирание: староста одобряет', pg_temp.u(1),
  format($$public.resolve_data_deletion(%L, true, 'по заявлению') ->> 'status'$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'done');
select pg_temp.ok('стирание: аккаунт удалён', not pg_temp.alive(3));
select pg_temp.ok('стирание: запись обезличена', (select last_name = 'Удалён' and first_name like 'студент-%' and telegram is null
  and claimed_by is null and claimed_at is null and claim_status = 'erased' and erased_at is not null from public.students where id = 't-a3'));
select pg_temp.ok('стирание: членство, согласия, уведомления, настройки удалены',
  not exists (select 1 from public.memberships where user_id = pg_temp.u(3) or student_id = 't-a3')
  and not exists (select 1 from public.consents where user_id = pg_temp.u(3))
  and not exists (select 1 from public.notifications where user_id = pg_temp.u(3))
  and not exists (select 1 from public.notification_prefs where user_id = pg_temp.u(3)));
select pg_temp.ok('стирание: Telegram и push удалены (в т. ч. легаси-таблицы без FK)',
  not exists (select 1 from public.tg_links where user_id = pg_temp.u(3))
  and not exists (select 1 from public.tg_rebind where user_id = pg_temp.u(3))
  and not exists (select 1 from public.tg_subscribers where chat_id = 777000001)
  and not exists (select 1 from public.tg_dialog_state where telegram_id = 777000001)
  and not exists (select 1 from public.tg_task_log where telegram_id = 777000001)
  and not exists (select 1 from public.push_subscriptions where user_id = pg_temp.u(3))
  and not exists (select 1 from public.notify_log where item_id = 'it-er'));
select pg_temp.ok('стирание: личное по записи удалено (события, значки, игры, слова, токены, коды, напоминания)',
  not exists (select 1 from public.app_events where student_id = 't-a3')
  and not exists (select 1 from public.student_achievements where student_id = 't-a3')
  and not exists (select 1 from public.game_records where student_id = 't-a3')
  and not exists (select 1 from public.word_attempts where student_id = 't-a3')
  and not exists (select 1 from public.assoc_daily_results where student_id = 't-a3')
  and not exists (select 1 from public.pass_tokens where student_id = 't-a3')
  and not exists (select 1 from public.invite_codes where student_id = 't-a3')
  and not exists (select 1 from public.remind_log where student_id = 't-a3'));
select pg_temp.ok('стирание: пропуски, справка и оценка остались, без текста',
  (select count(*) from public.absences where student_id = 't-a3') = 3
  and not exists (select 1 from public.absences where student_id = 't-a3' and comment is not null)
  and (select note is null from public.certificates where id = 'ce-er1')
  and (select comment is null and value = 7 from public.grades where id = 'gr-er1'));
select pg_temp.ok('стирание: уведомление старосте с ФИО студента удалено',
  not exists (select 1 from public.notifications where ref ->> 'student_id' = 't-a3'));
select pg_temp.ok('стирание: payload заявки на регистрацию — элемент обезличен, остальные целы',
  (select payload -> 'students' -> 1 ->> 'last_name' = 'Удалён' and payload -> 'students' -> 0 ->> 'last_name' = 'Тестов'
     from public.registration_requests where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and payload -> 'group' ->> 'name' = 'ТЕСТ-1'));
select pg_temp.ok('стирание: ФИО нигде в public не осталось', pg_temp.text_hits('Эрасов') = 0 and pg_temp.text_hits('Феликс') = 0
  and pg_temp.text_hits('erasov') = 0, pg_temp.text_hits('Эрасов') || '/' || pg_temp.text_hits('Феликс') || '/' || pg_temp.text_hits('erasov'));
select pg_temp.ok('стирание: audit_log — запись student_erase и решение, без ФИО',
  exists (select 1 from public.audit_log where action = 'student_erase' and details ->> 'student_id' = 't-a3' and (details ->> 'accounts_deleted')::int = 1)
  and exists (select 1 from public.audit_log where action = 'erasure_resolve' and details ->> 'student_id' = 't-a3' and (details ->> 'approve')::boolean));
select pg_temp.expect_min('стирание: староста видит обезличенную строку в сводке', pg_temp.u(1),
  $$select 1 from public.group_absence_summary('aaaaaaaa-0000-4000-8000-00000000000a', null, null) where student_id = 't-a3' and student_name like 'Удалён студент-%' and total = 6$$, 1);
select pg_temp.ok('стирание: студент B и его данные не тронуты', pg_temp.alive(9)
  and exists (select 1 from public.student_achievements where student_id = 't-b2')
  and (select erased_at is null from public.students where id = 't-b2'));

-- Идемпотентность и неизменность
select pg_temp.keep('e2', pg_temp.u(7), $$public.sysadmin_erase_student('t-a3')$$);
select pg_temp.ok('повтор: already, аккаунтов не удалено', (select (v ->> 'already')::boolean and (v ->> 'accounts_deleted')::int = 0 from pg_temp.kv where k = 'e2'),
  (select v::text from pg_temp.kv where k = 'e2'));
select pg_temp.ok('повтор: student_erase записан один раз',
  (select count(*) from public.audit_log where action = 'student_erase' and details ->> 'student_id' = 't-a3') = 1);
update public.students set claim_status = 'free', claimed_by = pg_temp.u(11), last_name = 'Новый' where id = 't-a3';
select pg_temp.ok('заморозка: стёртую запись не «оживить» ни привязкой, ни правкой',
  (select claim_status = 'erased' and claimed_by is null and last_name = 'Удалён' from public.students where id = 't-a3'));
select pg_temp.ok('вход: стёртой записи нет в списке «выберите себя» (join-group берёт free)',
  not exists (select 1 from public.students where id = 't-a3' and claim_status = 'free'));
select pg_temp.expect_denied('охрана: староста не вносит пропуск стёртому', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', current_date, 'Статистика', 2)$$);
alter table public.student_achievements enable trigger erased_student_guard;
insert into public.student_achievements (student_id, code, period, semester, group_id)
  values ('t-a3', 'test_x', 'p', 's', 'aaaaaaaa-0000-4000-8000-00000000000a');
select pg_temp.ok('охрана: сервисная выдача значка стёртому молча пропускается',
  not exists (select 1 from public.student_achievements where student_id = 't-a3'));
alter table public.student_achievements disable trigger erased_student_guard;
select pg_temp.expect_err('повтор: заявка уже done → not_pending', pg_temp.u(7),
  format($$public.resolve_data_deletion(%L, true, null)$$, (select v ->> 'request_id' from pg_temp.kv where k = 'r3')), 'not_pending');

-- ===== 5. Сисадмин стирает напрямую; аккаунт с другой группой остаётся; легаси-зеркало =====
insert into public.memberships (user_id, group_id, base_role, status)
  values (pg_temp.u(10), 'bbbbbbbb-0000-4000-8000-00000000000b', 'teacher_practice', 'active');
update public.students set last_name = 'Легасов', first_name = 'Лиодор', telegram = '{"username":"legasov_l"}' where id = 't-l1';
alter table public.profiles disable trigger profiles_legacy_sync;
insert into public.profiles (user_id, student_id, login) values (pg_temp.u(10), 't-l1', 'legasov_l')
  on conflict (user_id) do update set student_id = excluded.student_id;
alter table public.profiles enable trigger profiles_legacy_sync;
select pg_temp.keep('e3', pg_temp.u(7), $$public.sysadmin_erase_student('t-l1')$$);
select pg_temp.ok('сисадмин: стёр, аккаунт преподавателя другой группы оставлен',
  (select (v ->> 'accounts_deleted')::int = 0 and (v ->> 'accounts_kept')::int = 1 and (v ->> 'ok')::boolean from pg_temp.kv where k = 'e3')
  and pg_temp.alive(10), (select v::text from pg_temp.kv where k = 'e3'));
select pg_temp.ok('сисадмин: у оставленного аккаунта снята только эта группа',
  not exists (select 1 from public.memberships where user_id = pg_temp.u(10) and group_id = '00000000-0000-4000-8000-000000000024')
  and exists (select 1 from public.memberships where user_id = pg_temp.u(10) and group_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and status = 'active')
  and not exists (select 1 from public.profiles where student_id = 't-l1')
  and not exists (select 1 from public.app_events where student_id = 't-l1'));
select pg_temp.ok('легаси: элемент студента в journal_private заменён целиком',
  not exists (select 1 from public.journal_private where id = 'main')
  or ((select count(*) from public.journal_private j, jsonb_array_elements(j.students) e
        where j.id = 'main' and e ->> 'id' = 't-l1' and e ->> 'lastName' = 'Удалён' and not e ? 'telegramUsername') = 1
      and not exists (select 1 from public.journal_private where students::text like '%Легасов%' or students::text like '%legasov%')));
select pg_temp.ok('сисадмин: ФИО легаси-студента нигде не осталось', pg_temp.text_hits('Легасов') = 0 and pg_temp.text_hits('legasov') = 0,
  pg_temp.text_hits('Легасов') || '/' || pg_temp.text_hits('legasov'));
select pg_temp.expect_err('сисадмин: неизвестная запись → not_found', pg_temp.u(7), $$public.sysadmin_erase_student('t-nope')$$, 'not_found');

-- ===== 6. Выпуск и стирание через год =====
insert into public.memberships (user_id, group_id, base_role, status)
  values (pg_temp.u(6), 'bbbbbbbb-0000-4000-8000-00000000000b', 'teacher_practice', 'active'),
         (pg_temp.u(11), 'bbbbbbbb-0000-4000-8000-00000000000b', 'student', 'rejected');
insert into public.teacher_assignments (user_id, group_id, subject, lesson_kind)
  values (pg_temp.u(6), 'bbbbbbbb-0000-4000-8000-00000000000b', 'Логистика', 'practice');
insert into public.chat_threads (group_id, student_user_id, teacher_user_id, kind)
  values ('bbbbbbbb-0000-4000-8000-00000000000b', pg_temp.u(8), pg_temp.u(6), 'practice');
delete from public.schedule_meta where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b';
insert into public.schedule_meta (group_id, semester_end) values ('bbbbbbbb-0000-4000-8000-00000000000b', current_date + 30);
insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject) values ('bbbbbbbb-0000-4000-8000-00000000000b', '2099-01-01', 1, 'Логистика');
insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
  values ('bbbbbbbb-0000-4000-8000-00000000000b', '2099-01-01', 1, 'Логистика', 'practice', 'Тема');
insert into public.group_invites (group_id, code_hash) values ('bbbbbbbb-0000-4000-8000-00000000000b', encode(extensions.digest('grad-code', 'sha256'), 'hex'))
  on conflict (group_id) do update set code_hash = excluded.code_hash;

select pg_temp.expect_err('выпуск: староста не меняет статус', pg_temp.u(8),
  $$public.sysadmin_set_group_status('bbbbbbbb-0000-4000-8000-00000000000b', 'graduated')$$, 'forbidden');
select pg_temp.expect_val('выпуск: сисадмин выпускает группу B', pg_temp.u(7),
  $$public.sysadmin_set_group_status('bbbbbbbb-0000-4000-8000-00000000000b', 'graduated')$$, '{"ok": true, "status": "graduated"}');
select pg_temp.ok('выпуск: graduated_at стоит, отметки автозакрытия нет, журнал только для просмотра',
  (select graduated_at is not null and semester_closed_for is null from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not public.group_open('bbbbbbbb-0000-4000-8000-00000000000b'));
select pg_temp.expect_denied('выпуск: староста B не вносит пропуск', pg_temp.u(8),
  $$insert into public.absences (group_id, student_id, date, subject, hours) values ('bbbbbbbb-0000-4000-8000-00000000000b', 't-b2', current_date, 'Логистика', 2)$$);
select pg_temp.expect_count('выпуск: студент B по-прежнему читает', pg_temp.u(9),
  $$select 1 from public.absences where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 1);
update public.groups set graduated_at = now() - interval '200 days' where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
select pg_temp.expect_val('выпуск: повторный graduated срок не продлевает', pg_temp.u(7),
  $$public.sysadmin_set_group_status('bbbbbbbb-0000-4000-8000-00000000000b', 'graduated') ->> 'status'$$, 'graduated');
select pg_temp.ok('выпуск: graduated_at прежний',
  (select graduated_at = now() - interval '200 days' from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b'));
insert into pg_temp.kv select 'st', public.semester_tick();
select pg_temp.ok('выпуск: semester_tick выпущенную группу не трогает',
  (select status from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b') = 'graduated');

insert into pg_temp.kv select 'c0', public.graduates_cleanup();
select pg_temp.ok('год не прошёл: чистка ничего не делает',
  (select (v ->> 'groups')::int = 0 from pg_temp.kv where k = 'c0') and pg_temp.alive(8) and pg_temp.alive(9)
  and (select erased_at is null from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b'),
  (select v::text from pg_temp.kv where k = 'c0'));

update public.groups set graduated_at = now() - interval '366 days' where id = 'bbbbbbbb-0000-4000-8000-00000000000b';
insert into pg_temp.kv select 'c1', public.graduates_cleanup();
insert into pg_temp.kv select 'c2', public.graduates_cleanup();
select pg_temp.ok('через год: одна группа, два студента, три аккаунта (староста, студент, отклонённый)',
  (select (v ->> 'groups')::int = 1 and (v ->> 'students')::int = 2 and (v ->> 'accounts_deleted')::int = 3 from pg_temp.kv where k = 'c1'),
  (select v::text from pg_temp.kv where k = 'c1'));
select pg_temp.ok('через год: аккаунты старосты, студента и отклонённого удалены', not pg_temp.alive(8) and not pg_temp.alive(9) and not pg_temp.alive(11));
select pg_temp.ok('через год: преподаватели и сисадмин целы', pg_temp.alive(6) and pg_temp.alive(10) and pg_temp.alive(7)
  and exists (select 1 from public.sysadmins where user_id = pg_temp.u(7)));
select pg_temp.ok('через год: у преподавателя снята только эта группа',
  exists (select 1 from public.memberships where user_id = pg_temp.u(6) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and status = 'active')
  and exists (select 1 from public.teacher_assignments where user_id = pg_temp.u(6) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.memberships where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.teacher_assignments where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'));
select pg_temp.ok('через год: все студенты B обезличены, пропуски остались',
  not exists (select 1 from public.students where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and (erased_at is null or last_name <> 'Удалён'))
  and exists (select 1 from public.absences where id = 'abs-b1'));
select pg_temp.ok('через год: расписание, темы, задания, учебные дни, код, чат группы удалены',
  not exists (select 1 from public.schedule_lessons where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.schedule_meta where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.lesson_notes where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.tasks where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.study_days where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.group_invites where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and not exists (select 1 from public.chat_threads where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'));
select pg_temp.ok('через год: строка группы осталась, erased_at стоит, в audit_log group_erase',
  (select status = 'graduated' and erased_at is not null from public.groups where id = 'bbbbbbbb-0000-4000-8000-00000000000b')
  and exists (select 1 from public.audit_log where action = 'group_erase' and group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'));
select pg_temp.ok('повтор чистки ничего не меняет',
  (select (v ->> 'groups')::int = 0 and (v ->> 'students')::int = 0 from pg_temp.kv where k = 'c2'));
select pg_temp.ok('через год: группа A не тронута', pg_temp.alive(1)
  and (select count(*) from public.students where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and erased_at is null) = 3);
select pg_temp.expect_err('стёртую группу не вернуть в active', pg_temp.u(7),
  $$public.sysadmin_set_group_status('bbbbbbbb-0000-4000-8000-00000000000b', 'active')$$, 'group_erased');

-- Возврат из выпуска сбрасывает graduated_at
insert into public.groups (id, name, status) values ('cccccccc-0000-4000-8000-00000000000c', 'ТЕСТ-ВЫП', 'active');
select pg_temp.val_as(pg_temp.u(7), $$public.sysadmin_set_group_status('cccccccc-0000-4000-8000-00000000000c', 'graduated')$$);
select pg_temp.expect_val('возврат: graduated → active', pg_temp.u(7),
  $$public.sysadmin_set_group_status('cccccccc-0000-4000-8000-00000000000c', 'active') ->> 'status'$$, 'active');
select pg_temp.ok('возврат: graduated_at сброшен', (select graduated_at is null from public.groups where id = 'cccccccc-0000-4000-8000-00000000000c'));
select pg_temp.expect_err('статус: неизвестный → bad_status', pg_temp.u(7),
  $$public.sysadmin_set_group_status('cccccccc-0000-4000-8000-00000000000c', 'archived')$$, 'bad_status');

-- ===== 7. cron =====
select pg_temp.ok('cron: задание journal-graduates создано',
  to_regclass('cron.job') is null or exists (select 1 from cron.job where jobname = 'journal-graduates' and schedule = '25 1 * * *'));
