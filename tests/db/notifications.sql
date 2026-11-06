-- Тесты этапа 3 (очередь уведомлений, настройки, перепривязка Telegram, notify_daily, порог деканата, cron).
-- Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A, 6 препод ПЗ A,
-- 7 сисадмин, 8 староста B, 9 студент B, 10 студент 24ДММ-2, 11 без групп.
-- Даты — от «сегодня по Минску», поэтому набор не зависит от дня запуска.

create temp table d as
  select (now() at time zone 'Europe/Minsk')::date as today,
         (now() at time zone 'Europe/Minsk')::date + 1 as tom,
         to_char((now() at time zone 'Europe/Minsk')::date + 1, 'YYYY-MM-DD') as tom_s,
         date_trunc('month', now() at time zone 'Europe/Minsk')::date as m0,
         date_trunc('month', now() at time zone 'Europe/Minsk')::date - 1 as prev_m;
create temp table kv (k text primary key, v jsonb);
grant select on d to public;
grant all on kv to public;

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

create function pg_temp.expect_anon_fail(t text, stmt text) returns void language plpgsql as $$
declare failed boolean := false; err text;
begin
  perform pg_temp.as_anon();
  begin execute stmt; exception when others then failed := true; err := sqlerrm; end;
  execute 'reset role';
  insert into res values (t, failed, coalesce(err, 'ошибки не было'));
end $$;

-- владелец без вошедшего пользователя (as_user оставляет claims до конца транзакции)
create function pg_temp.as_owner() returns void language sql as $$ select set_config('request.jwt.claims', '', true) $$;

-- у тестового аккаунта 3 остался легаси-профиль 24ДММ-2: убираем, он студент новой группы A (без profiles)
delete from public.profiles where user_id = pg_temp.u(3);
update public.students set subgroup = 1 where id = 't-a3';
update public.students set subgroup = 2 where id = 't-a2';

-- ===== 1. Колонки очереди и dedupe =====
insert into public.notifications (user_id, group_id, kind, title) values (pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'test', 'новое');
insert into pg_temp.res select 'очередь: новая строка pending, 0 попыток',
  exists (select 1 from public.notifications where user_id = pg_temp.u(3) and title = 'новое' and tg_status = 'pending' and tg_attempts = 0), '';
insert into public.notifications (user_id, kind, title, dedupe_key) values (pg_temp.u(3), 'test', 'd1', 'k1');
insert into public.notifications (user_id, kind, title, dedupe_key) values (pg_temp.u(3), 'test', 'd2', 'k1');
insert into pg_temp.res select 'dedupe: повторный обычный insert с тем же ключом пропущен',
  (select count(*) from public.notifications where user_id = pg_temp.u(3) and dedupe_key = 'k1') = 1, '';
insert into public.notifications (user_id, kind, title, dedupe_key) values (pg_temp.u(3), 'test', 'd3', 'k2'), (pg_temp.u(3), 'test', 'd4', 'k2');
insert into pg_temp.res select 'dedupe: дубль внутри одного insert пропущен',
  (select count(*) from public.notifications where user_id = pg_temp.u(3) and dedupe_key = 'k2') = 1, '';
insert into public.notifications (user_id, kind, title, dedupe_key) values (pg_temp.u(9), 'test', 'd5', 'k1');
insert into pg_temp.res select 'dedupe: тот же ключ другому пользователю проходит',
  (select count(*) from public.notifications where dedupe_key = 'k1') = 2, '';
insert into public.notifications (user_id, kind, title) values (pg_temp.u(3), 'test', 'nokey'), (pg_temp.u(3), 'test', 'nokey');
insert into pg_temp.res select 'dedupe: строки без ключа не ограничены',
  (select count(*) from public.notifications where user_id = pg_temp.u(3) and title = 'nokey') = 2, '';
select pg_temp.expect_error('очередь: неизвестный tg_status запрещён',
  $$insert into public.notifications (user_id, kind, title, tg_status) values (pg_temp.u(3), 'test', 'x', 'queued')$$);
insert into public.notifications (user_id, kind, title, dedupe_key) values (pg_temp.u(3), 'test', 'd6', 'k1')
  on conflict (user_id, dedupe_key) do nothing;
insert into pg_temp.res select 'dedupe: upsert on conflict (user_id, dedupe_key) do nothing работает', true, '';
delete from public.notifications where kind = 'test' and user_id in (pg_temp.u(3), pg_temp.u(9));

-- ===== 2. notification_prefs: только свои строки =====
select pg_temp.expect_allowed('настройки: студент выключает тип (user_id по умолчанию — свой)', pg_temp.u(3),
  $$insert into public.notification_prefs (kind, enabled) values ('grade', false)$$);
select pg_temp.expect_count('настройки: строка записана на себя', pg_temp.u(3),
  $$select 1 from public.notification_prefs where user_id = auth.uid() and kind = 'grade' and not enabled$$, 1);
select pg_temp.expect_allowed('настройки: студент B пишет свою', pg_temp.u(9),
  $$insert into public.notification_prefs (kind, enabled) values ('absence', false)$$);
select pg_temp.expect_count('настройки: студент видит только свои', pg_temp.u(3), 'select 1 from public.notification_prefs', 1);
select pg_temp.expect_count('настройки: студент B не видит чужие', pg_temp.u(9),
  format('select 1 from public.notification_prefs where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_count('настройки: сисадмин не видит чужие', pg_temp.u(7),
  format('select 1 from public.notification_prefs where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_denied('настройки: нельзя вставить строку другому', pg_temp.u(3),
  format($$insert into public.notification_prefs (user_id, kind, enabled) values (%L, 'grade', false)$$, pg_temp.u(9)));
select pg_temp.expect_denied('настройки: нельзя менять чужую', pg_temp.u(3),
  format($$update public.notification_prefs set enabled = true where user_id = %L$$, pg_temp.u(9)));
select pg_temp.expect_denied('настройки: нельзя переписать свою строку на другого', pg_temp.u(3),
  format($$update public.notification_prefs set user_id = %L where user_id = auth.uid()$$, pg_temp.u(9)));
select pg_temp.expect_denied('настройки: нельзя удалить чужую', pg_temp.u(3),
  format($$delete from public.notification_prefs where user_id = %L$$, pg_temp.u(9)));
select pg_temp.expect_denied('настройки: неизвестный тип отклоняется', pg_temp.u(3),
  $$insert into public.notification_prefs (kind, enabled) values ('spam', false)$$);
select pg_temp.expect_allowed('настройки: своя меняется', pg_temp.u(3),
  $$update public.notification_prefs set enabled = true where kind = 'grade'$$);
select pg_temp.expect_allowed('настройки: своя удаляется', pg_temp.u(3), $$delete from public.notification_prefs where kind = 'grade'$$);
do $$
declare n bigint;
begin
  perform pg_temp.as_anon();
  begin select count(*) into n from public.notification_prefs; exception when others then n := -1; end;
  execute 'reset role';
  insert into pg_temp.res values ('настройки: аноним ничего не видит', coalesce(n, 0) <= 0, 'видно ' || n);
end $$;

-- ===== 3. tg_create_link_code: любой active-участник =====
select pg_temp.expect_count('код: студент новой группы без profiles получает код ABCD-EFGH', pg_temp.u(3),
  $$select 1 where public.tg_create_link_code() ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$'$$, 1);
insert into pg_temp.res select 'код: в базе только хэш, срок 10 минут',
  exists (select 1 from public.tg_link_codes where user_id = pg_temp.u(3) and code_hash ~ '^[0-9a-f]{64}$'
            and expires_at between now() + interval '9 minutes' and now() + interval '11 minutes'), '';
select pg_temp.expect_call_ok('код: староста новой группы получает код', pg_temp.u(1), 'select public.tg_create_link_code()');
select pg_temp.expect_call_fail('код: ожидающий подтверждения не получает', pg_temp.u(4), 'select public.tg_create_link_code()');
select pg_temp.expect_call_fail('код: пользователь без active-членства не получает', pg_temp.u(11), 'select public.tg_create_link_code()');
select pg_temp.expect_anon_fail('код: аноним не получает', 'select public.tg_create_link_code()');

-- ===== 4. tg_reset_all, tg_rebind, tg_rebind_dismiss =====
select pg_temp.as_owner();
insert into public.tg_links (user_id, telegram_id) values
  (pg_temp.u(1), 900000001), (pg_temp.u(3), 900000003), (pg_temp.u(9), 900000009);
insert into pg_temp.kv select 'links0', to_jsonb(count(*)) from public.tg_links;

select pg_temp.expect_call_fail('сброс: студент не вызывает', pg_temp.u(3), 'select public.tg_reset_all()');
select pg_temp.expect_call_fail('сброс: староста не вызывает', pg_temp.u(1), 'select public.tg_reset_all()');
select pg_temp.expect_call_fail('сброс: пользователь без групп не вызывает', pg_temp.u(11), 'select public.tg_reset_all()');
select pg_temp.expect_anon_fail('сброс: аноним не вызывает', 'select public.tg_reset_all()');
insert into pg_temp.res select 'сброс: после отказов привязки на месте',
  (select count(*) from public.tg_links) = (select v::int from pg_temp.kv where k = 'links0'), '';

do $$
begin
  perform pg_temp.as_user(pg_temp.u(7));
  insert into pg_temp.kv values ('r1', public.tg_reset_all());
  execute 'reset role';
end $$;
insert into pg_temp.res select 'сброс: сисадмин — reset = число привязок, rebind ≥ reset',
  (v ->> 'reset')::int = (select v::int from pg_temp.kv where k = 'links0') and (v ->> 'rebind')::int >= (v ->> 'reset')::int, v::text
  from pg_temp.kv where k = 'r1';
insert into pg_temp.res select 'сброс: привязок не осталось', not exists (select 1 from public.tg_links), '';
insert into pg_temp.res select 'сброс: коды привязанного пользователя удалены',
  not exists (select 1 from public.tg_link_codes where user_id = pg_temp.u(3)), '';
insert into pg_temp.res select 'сброс: строка перепривязки с прежним telegram_id',
  exists (select 1 from public.tg_rebind where user_id = pg_temp.u(3) and old_telegram_id = 900000003
            and requested_at is not null and broadcast_at is null and dismissed_at is null), '';
insert into pg_temp.res select 'сброс: active-участник без привязки тоже получил строку',
  exists (select 1 from public.tg_rebind where user_id = pg_temp.u(2) and old_telegram_id is null and dismissed_at is null), '';
insert into pg_temp.res select 'сброс: ожидающий и пользователь без групп строк не получили',
  not exists (select 1 from public.tg_rebind where user_id in (pg_temp.u(4), pg_temp.u(11))), '';
insert into pg_temp.res select 'сброс: записан в audit_log',
  exists (select 1 from public.audit_log where action = 'tg_reset_all' and actor = pg_temp.u(7)), '';

do $$
begin
  perform pg_temp.as_user(pg_temp.u(7));
  insert into pg_temp.kv values ('r2', public.tg_reset_all());
  execute 'reset role';
end $$;
insert into pg_temp.res select 'сброс: повторный вызов ничего не меняет (0, 0)', v = '{"reset": 0, "rebind": 0}'::jsonb, v::text
  from pg_temp.kv where k = 'r2';
insert into pg_temp.res select 'сброс: повтор не стёр прежний telegram_id',
  exists (select 1 from public.tg_rebind where user_id = pg_temp.u(3) and old_telegram_id = 900000003), '';

-- пользователь снова привязался, рассылка ушла, экран погашен → новый сброс переоткрывает строку
select pg_temp.as_owner();
insert into public.tg_links (user_id, telegram_id) values (pg_temp.u(3), 900000033);
update public.tg_rebind set broadcast_at = now() - interval '1 day', dismissed_at = now() - interval '1 day' where user_id = pg_temp.u(3);
do $$
begin
  perform pg_temp.as_user(pg_temp.u(7));
  insert into pg_temp.kv values ('r3', public.tg_reset_all());
  execute 'reset role';
end $$;
insert into pg_temp.res select 'сброс: новая привязка → reset 1, rebind 1', v = '{"reset": 1, "rebind": 1}'::jsonb, v::text
  from pg_temp.kv where k = 'r3';
insert into pg_temp.res select 'сброс: строка переоткрыта с новым telegram_id',
  exists (select 1 from public.tg_rebind where user_id = pg_temp.u(3) and old_telegram_id = 900000033
            and broadcast_at is null and dismissed_at is null), '';

select pg_temp.expect_count('перепривязка: пользователь видит только свою строку', pg_temp.u(3), 'select 1 from public.tg_rebind', 1);
select pg_temp.expect_count('перепривязка: студент B не видит строку A', pg_temp.u(9),
  format('select 1 from public.tg_rebind where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_count('перепривязка: сисадмин не читает чужие строки', pg_temp.u(7),
  format('select 1 from public.tg_rebind where user_id = %L', pg_temp.u(3)), 0);
select pg_temp.expect_denied('перепривязка: клиент не правит строку напрямую', pg_temp.u(3),
  $$update public.tg_rebind set dismissed_at = now()$$);
select pg_temp.expect_denied('перепривязка: клиент не вставляет', pg_temp.u(11),
  $$insert into public.tg_rebind (user_id) values (auth.uid())$$);
select pg_temp.expect_denied('перепривязка: клиент не удаляет', pg_temp.u(3), $$delete from public.tg_rebind$$);
select pg_temp.expect_call_ok('перепривязка: «Пропустить» гасит свою строку', pg_temp.u(3), 'select public.tg_rebind_dismiss()');
insert into pg_temp.res select 'перепривязка: своя строка погашена, чужая нет',
  exists (select 1 from public.tg_rebind where user_id = pg_temp.u(3) and dismissed_at is not null)
  and exists (select 1 from public.tg_rebind where user_id = pg_temp.u(9) and dismissed_at is null), '';
select pg_temp.expect_call_ok('перепривязка: dismiss без строки — без ошибки', pg_temp.u(11), 'select public.tg_rebind_dismiss()');
select pg_temp.expect_anon_fail('перепривязка: аноним не вызывает dismiss', 'select public.tg_rebind_dismiss()');

-- ===== 5. Очередь Telegram: tg_claim_notifications / tg_notification_done =====
select pg_temp.as_owner();
insert into public.tg_links (user_id, telegram_id) values (pg_temp.u(1), 900000101), (pg_temp.u(3), 900000103)
  on conflict (user_id) do update set telegram_id = excluded.telegram_id;
insert into public.notification_prefs (user_id, kind, enabled) values (pg_temp.u(1), 'absence', false), (pg_temp.u(3), 'grade', true);
insert into public.notifications (id, user_id, group_id, kind, title, body, tg_status, tg_attempts, tg_claimed_at, created_at) values
  ('00000000-0000-4000-a000-000000000001', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n1', 'b1', 'pending', 0, null, now() - interval '3 hours'),
  ('00000000-0000-4000-a000-000000000002', pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 'absence', 'n2', null, 'pending', 0, null, now() - interval '3 hours'),
  ('00000000-0000-4000-a000-000000000003', pg_temp.u(2), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n3', null, 'pending', 0, null, now() - interval '3 hours'),
  ('00000000-0000-4000-a000-000000000004', pg_temp.u(1), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n4', null, 'pending', 0, null, now() - interval '2 hours'),
  ('00000000-0000-4000-a000-000000000005', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n5', null, 'sending', 1, now() - interval '10 minutes', now() - interval '4 hours'),
  ('00000000-0000-4000-a000-000000000006', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n6', null, 'sending', 1, now() - interval '1 minute', now() - interval '4 hours'),
  ('00000000-0000-4000-a000-000000000007', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n7', null, 'sending', 3, now() - interval '10 minutes', now() - interval '4 hours'),
  ('00000000-0000-4000-a000-000000000008', pg_temp.u(3), 'aaaaaaaa-0000-4000-8000-00000000000a', 'grade', 'n8', null, 'sent', 1, now() - interval '1 hour', now() - interval '5 hours');

-- права: только service_role
select pg_temp.expect_call_fail('очередь: студент не вызывает claim', pg_temp.u(3), 'select * from public.tg_claim_notifications(10)');
select pg_temp.expect_call_fail('очередь: сисадмин не вызывает claim', pg_temp.u(7), 'select * from public.tg_claim_notifications(10)');
select pg_temp.expect_anon_fail('очередь: аноним не вызывает claim', 'select * from public.tg_claim_notifications(10)');
select pg_temp.expect_call_fail('очередь: студент не вызывает done', pg_temp.u(3),
  $$select public.tg_notification_done('00000000-0000-4000-a000-000000000001', true)$$);
select pg_temp.expect_call_fail('очередь: сисадмин не вызывает done', pg_temp.u(7),
  $$select public.tg_notification_done('00000000-0000-4000-a000-000000000001', true)$$);
select pg_temp.expect_anon_fail('очередь: аноним не вызывает done', $$select public.tg_notification_done('00000000-0000-4000-a000-000000000001', true)$$);
insert into pg_temp.res select 'очередь: после отказов строка не тронута',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000001' and tg_status = 'pending' and tg_attempts = 0), '';

-- два последовательных claim: limit 1, затем остальное; одна строка не выдаётся дважды
do $$
begin
  perform pg_temp.as_service();
  insert into pg_temp.kv select 'c1', coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.tg_claim_notifications(1) c;
  insert into pg_temp.kv select 'c2', coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.tg_claim_notifications(1000) c;
  insert into pg_temp.kv select 'c3', coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.tg_claim_notifications(1000) c;
  execute 'reset role';
end $$;
create temp table cl as
  select k, (e ->> 'id')::uuid as id, (e ->> 'user_id')::uuid as user_id, e ->> 'kind' as kind, e ->> 'title' as title,
         e ->> 'body' as body, (e ->> 'telegram_id')::bigint as telegram_id
    from pg_temp.kv, jsonb_array_elements(v) e where k in ('c1', 'c2', 'c3');
insert into pg_temp.res select 'очередь: claim(1) отдаёт одну строку', (select count(*) from cl where k = 'c1') = 1, '';
insert into pg_temp.res select 'очередь: ни одна строка не выдана дважды', (select count(*) = count(distinct id) from cl), '';
insert into pg_temp.res select 'очередь: третий claim не отдаёт уже забранного', (select count(*) from cl where k = 'c3') = 0, '';
insert into pg_temp.res select 'очередь: самая старая (вернувшаяся «зависшая» n5) — первой',
  (select title from cl where k = 'c1') = 'n5', (select coalesce(title, '-') from cl where k = 'c1');
insert into pg_temp.res select 'очередь: n1 выдана с telegram_id получателя и текстом',
  exists (select 1 from cl where id = '00000000-0000-4000-a000-000000000001' and telegram_id = 900000103
            and kind = 'grade' and title = 'n1' and body = 'b1' and user_id = pg_temp.u(3)), '';
insert into pg_temp.res select 'очередь: n4 (включённый тип старосты) выдана', exists (select 1 from cl where title = 'n4' and telegram_id = 900000101), '';
insert into pg_temp.res select 'очередь: выключенный тип не выдан и помечен skipped',
  not exists (select 1 from cl where title = 'n2')
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000002' and tg_status = 'skipped'), '';
insert into pg_temp.res select 'очередь: без привязки не выдана и помечена skipped',
  not exists (select 1 from cl where title = 'n3')
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000003' and tg_status = 'skipped'), '';
insert into pg_temp.res select 'очередь: выданные — sending, попытка +1, время забора',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000001' and tg_status = 'sending' and tg_attempts = 1 and tg_claimed_at is not null)
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000005' and tg_status = 'sending' and tg_attempts = 2), '';
insert into pg_temp.res select 'очередь: свежая sending (< 5 мин) не тронута',
  not exists (select 1 from cl where title = 'n6')
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000006' and tg_status = 'sending' and tg_attempts = 1), '';
insert into pg_temp.res select 'очередь: «зависшая» после 3 попыток → failed',
  not exists (select 1 from cl where title = 'n7')
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000007' and tg_status = 'failed'), '';
insert into pg_temp.res select 'очередь: sent не выдаётся повторно', not exists (select 1 from cl where title = 'n8'), '';
insert into pg_temp.res select 'очередь: выданы только получатели с привязкой',
  not exists (select 1 from cl where user_id not in (pg_temp.u(1), pg_temp.u(3))), '';
insert into pg_temp.res select 'очередь: уведомления пропусков студента A (триггер prelude) тоже выданы',
  (select count(*) from cl where user_id = pg_temp.u(3) and kind = 'absence') >= 3, '';

do $$
begin
  perform pg_temp.as_service();
  perform public.tg_notification_done('00000000-0000-4000-a000-000000000001', true);
  perform public.tg_notification_done('00000000-0000-4000-a000-000000000004', false, 'boom');
  perform public.tg_notification_done('00000000-0000-4000-a000-000000000005', false, 'blocked');
  perform public.tg_notification_done('00000000-0000-4000-a000-000000000008', false, 'late');
  execute 'reset role';
end $$;
insert into pg_temp.res select 'done: ok → sent, время отправки',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000001' and tg_status = 'sent' and tg_sent_at is not null and tg_error is null), '';
insert into pg_temp.res select 'done: неудача (1 попытка) → pending, ошибка записана',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000004' and tg_status = 'pending' and tg_attempts = 1 and tg_error = 'boom'), '';
insert into pg_temp.res select 'done: неудача (2 попытки) → pending',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000005' and tg_status = 'pending' and tg_attempts = 2), '';
insert into pg_temp.res select 'done: sent не откатывается поздним ответом',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000008' and tg_status = 'sent' and tg_error is null), '';
do $$
begin
  perform pg_temp.as_service();
  insert into pg_temp.kv select 'c4', coalesce(jsonb_agg(c.id), '[]') from public.tg_claim_notifications(1000) c;
  perform public.tg_notification_done('00000000-0000-4000-a000-000000000005', false, 'blocked');
  execute 'reset role';
end $$;
insert into pg_temp.res select 'done: третья неудача → failed (больше не выдаётся)',
  (select v ? '00000000-0000-4000-a000-000000000005' from pg_temp.kv where k = 'c4')
  and exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000005' and tg_status = 'failed' and tg_attempts = 3), '';
do $$
declare n int;
begin
  perform pg_temp.as_service();
  select count(*) into n from public.tg_claim_notifications(1000) c where c.id = '00000000-0000-4000-a000-000000000005';
  execute 'reset role';
  insert into pg_temp.res values ('done: failed не возвращается в очередь', n = 0, 'выдано ' || n);
end $$;
-- отвязка: оставшиеся pending получателя уходят в skipped при следующем claim
select pg_temp.as_owner();
update public.notifications set tg_status = 'pending' where id = '00000000-0000-4000-a000-000000000004';
delete from public.tg_links where user_id = pg_temp.u(1);
do $$
begin
  perform pg_temp.as_service();
  perform public.tg_claim_notifications(1000);
  execute 'reset role';
end $$;
insert into pg_temp.res select 'очередь: после отвязки pending → skipped',
  exists (select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000004' and tg_status = 'skipped'), '';
select pg_temp.expect_count('очередь: студент B не видит чужое уведомление', pg_temp.u(9),
  $$select 1 from public.notifications where id = '00000000-0000-4000-a000-000000000001'$$, 0);

-- ===== 6. notify_daily =====
select pg_temp.expect_call_fail('ежедневные: студент не вызывает notify_daily', pg_temp.u(3), 'select public.notify_daily()');
select pg_temp.expect_call_fail('ежедневные: сисадмин не вызывает notify_daily', pg_temp.u(7), 'select public.notify_daily()');
select pg_temp.expect_anon_fail('ежедневные: аноним не вызывает notify_daily', 'select public.notify_daily()');

select pg_temp.as_owner();
-- закрытая группа C: студент-староста (аккаунт 11)
insert into public.groups (id, name, status) values ('cccccccc-0000-4000-8000-00000000000c', 'ТЕСТ-3', 'closed');
insert into public.students (id, group_id, last_name, first_name, claim_status, claimed_by) values
  ('t-c1', 'cccccccc-0000-4000-8000-00000000000c', 'Закрытов', 'Студент', 'active', pg_temp.u(11));
insert into public.memberships (user_id, group_id, student_id, base_role, extra_role, status) values
  (pg_temp.u(11), 'cccccccc-0000-4000-8000-00000000000c', 't-c1', 'student', 'headman', 'active');

insert into public.tasks (id, kind, group_id, rec)
select x.id, x.kind, x.g::uuid,
       jsonb_build_object('id', x.id, 'subject', 'Статистика', 'text', x.txt, 'dueDate', to_char(d.today + x.plus, 'YYYY-MM-DD'), 'subgroup', x.sg)
  from d, (values
    ('tk-d1', 'deadline', 'aaaaaaaa-0000-4000-8000-00000000000a', 'КР', 1, 0),     -- всей группе A
    ('tk-d2', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ДЗ2', 1, 2),    -- подгруппе 2
    ('tk-d3', 'homework', 'bbbbbbbb-0000-4000-8000-00000000000b', 'ДЗ-B', 1, 0),   -- группе B
    ('tk-d4', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a', 'послезавтра', 2, 0),
    ('tk-d5', 'homework', 'aaaaaaaa-0000-4000-8000-00000000000a', 'сделано', 1, 0), -- студент A отметил выполнение
    ('tk-d6', 'homework', 'cccccccc-0000-4000-8000-00000000000c', 'закрыта', 1, 0)
  ) as x(id, kind, g, txt, plus, sg);
insert into public.app_events (user_id, student_id, kind, ref, group_id)
  values (pg_temp.u(3), 't-a3', 'homework_done', 'tk-d5', 'aaaaaaaa-0000-4000-8000-00000000000a');
insert into public.certificates (id, group_id, student_id, kind, date_from, date_to, due_date, status)
select x.id, x.g::uuid, x.sid, x.kind, x.df, x.dt, d.tom, x.st
  from d, (values
    ('ce-n1', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'sick', date '2026-11-02', date '2026-11-03', 'waiting'),
    ('ce-n2', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'other', null, null, 'received'),
    ('ce-n3', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a1', 'statement', null, null, 'waiting'),   -- справка самого старосты
    ('ce-n4', 'cccccccc-0000-4000-8000-00000000000c', 't-c1', 'sick', null, null, 'waiting')
  ) as x(id, g, sid, kind, df, dt, st);
insert into public.schedule_meta (group_id, semester_end)
select x.g::uuid, d.today + x.plus from d, (values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 14), ('bbbbbbbb-0000-4000-8000-00000000000b', 5),
  ('cccccccc-0000-4000-8000-00000000000c', 10)) as x(g, plus);
create temp table cnt0 as select count(*) as n from public.notifications where user_id in (select pg_temp.u(i) from generate_series(1, 11) i);

insert into pg_temp.kv select 'nd1', public.notify_daily();
insert into pg_temp.kv select 'nd2', public.notify_daily();
create temp table nd as
  select n.*, (select i from generate_series(1, 11) i where pg_temp.u(i) = n.user_id) as who
    from public.notifications n where n.kind in ('deadline_soon', 'certificate', 'semester') and n.created_at = now();
grant select on nd to public;

insert into pg_temp.res select 'ежедневные: первый запуск что-то создал', (v ->> 'deadline_soon')::int >= 6 and (v ->> 'certificate')::int >= 4
  and (v ->> 'semester')::int >= 3, v::text from pg_temp.kv where k = 'nd1';
insert into pg_temp.res select 'ежедневные: повторный запуск ничего не добавил (dedupe)',
  v = '{"deadline_soon": 0, "certificate": 0, "semester": 0}'::jsonb, v::text from pg_temp.kv where k = 'nd2';
insert into pg_temp.res select 'ежедневные: у тестовых пользователей нет дублей ключей',
  not exists (select 1 from nd group by user_id, dedupe_key having count(*) > 1), '';
insert into pg_temp.res select 'горящие: студент A получил дедлайн группы (заголовок, текст, ключ)',
  exists (select 1 from nd, d where who = 3 and kind = 'deadline_soon' and ref ->> 'task_id' = 'tk-d1'
            and title = 'Завтра дедлайн' and body = 'Статистика: КР' and dedupe_key = 'deadline:tk-d1:' || d.tom_s), '';
insert into pg_temp.res select 'горящие: студент подгруппы 1 не получил задание подгруппы 2',
  not exists (select 1 from nd where who = 3 and ref ->> 'task_id' = 'tk-d2'), '';
insert into pg_temp.res select 'горящие: заместитель (подгруппа 2) получил оба',
  (select count(*) from nd where who = 2 and kind = 'deadline_soon' and ref ->> 'task_id' in ('tk-d1', 'tk-d2')) = 2, '';
insert into pg_temp.res select 'горящие: отмеченное выполненным не напоминается',
  not exists (select 1 from nd where who = 3 and ref ->> 'task_id' = 'tk-d5')
  and exists (select 1 from nd where who = 1 and ref ->> 'task_id' = 'tk-d5'), '';
insert into pg_temp.res select 'горящие: срок послезавтра — не сегодня', not exists (select 1 from nd where ref ->> 'task_id' = 'tk-d4'), '';
insert into pg_temp.res select 'горящие: задание группы B — только группе B',
  exists (select 1 from nd where who = 9 and ref ->> 'task_id' = 'tk-d3')
  and not exists (select 1 from nd where who <> 9 and who <> 8 and ref ->> 'task_id' = 'tk-d3'), '';
insert into pg_temp.res select 'горящие: ожидающий, преподаватели, сисадмин не получают',
  not exists (select 1 from nd where who in (4, 5, 6, 7) and kind = 'deadline_soon'), '';
insert into pg_temp.res select 'ежедневные: закрытая группа пропущена (задания, справки, семестр)',
  not exists (select 1 from nd where who = 11) and not exists (select 1 from nd where group_id = 'cccccccc-0000-4000-8000-00000000000c'), '';
insert into pg_temp.res select 'справки: студент получил срок своей справки, без ФИО',
  exists (select 1 from nd, d where who = 3 and kind = 'certificate' and ref ->> 'certificate_id' = 'ce-n1'
            and title = 'Завтра срок сдачи справки' and body = 'Больничный, 02.11.2026–03.11.2026'
            and dedupe_key = 'cert-due:ce-n1:' || d.tom::text), '';
insert into pg_temp.res select 'справки: староста и зам получили с ФИО студента',
  (select count(*) from nd where who in (1, 2) and ref ->> 'certificate_id' = 'ce-n1' and body = 'Тестов Студент: Больничный, 02.11.2026–03.11.2026') = 2, '';
insert into pg_temp.res select 'справки: подтверждённая не напоминается', not exists (select 1 from nd where ref ->> 'certificate_id' = 'ce-n2'), '';
insert into pg_temp.res select 'справки: своя справка старосты — одно уведомление, без ФИО',
  (select count(*) from nd where who = 1 and ref ->> 'certificate_id' = 'ce-n3') = 1
  and exists (select 1 from nd where who = 1 and ref ->> 'certificate_id' = 'ce-n3' and body = 'Заявление')
  and exists (select 1 from nd where who = 2 and ref ->> 'certificate_id' = 'ce-n3' and body = 'Тестов Староста: Заявление'), '';
insert into pg_temp.res select 'справки: студент не получает чужие справки',
  not exists (select 1 from nd where who = 3 and kind = 'certificate' and ref ->> 'certificate_id' <> 'ce-n1'), '';
insert into pg_temp.res select 'семестр: староста и зам A получили «14» с датой в ключе',
  (select count(*) from nd where who in (1, 2) and kind = 'semester' and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
     and dedupe_key = 'semester:aaaaaaaa-0000-4000-8000-00000000000a:' || (select (today + 14)::text from d) || ':14'
     and body like '%(через 14 дн.)') = 2, '';
insert into pg_temp.res select 'семестр: староста B (5 дней) получил «7»',
  exists (select 1 from nd where who = 8 and kind = 'semester' and dedupe_key like '%:7'), '';
insert into pg_temp.res select 'семестр: студенты не получают', not exists (select 1 from nd where who in (3, 9) and kind = 'semester'), '';
insert into pg_temp.res select 'утечки: тексты студента не содержат чужих ФИО',
  not exists (select 1 from public.notifications where user_id = pg_temp.u(3)
               and (body like '%Тестов Староста%' or body like '%Тестов Зам%' or body like '%Другов%' or body like '%Тестов Свободный%')), '';
select pg_temp.expect_count('ежедневные: студент видит свои горящие', pg_temp.u(3),
  $$select 1 from public.notifications where kind = 'deadline_soon'$$, 1);
select pg_temp.expect_count('ежедневные: студент B не видит уведомления A', pg_temp.u(9),
  format($$select 1 from public.notifications where user_id = %L$$, pg_temp.u(3)), 0);

-- ===== 7. Порог деканата (группа A: warn 8, dean 12; студент t-a2 = заместитель, аккаунт 2) =====
create function pg_temp.ab(p_id text, p_sid text, p_hours numeric, p_excused boolean, p_date date default null) returns void language sql as $$
  insert into public.absences (id, group_id, student_id, date, subject, hours, is_excused, lesson_kind, created_by)
  select p_id, s.group_id, p_sid, coalesce(p_date, (select today from pg_temp.d)), 'Статистика', p_hours, p_excused, 'lecture', pg_temp.u(1)
    from public.students s where s.id = p_sid;
$$;
create function pg_temp.dean(p_who int, p_level text) returns bigint language sql as $$
  select count(*) from public.notifications
   where user_id = pg_temp.u(p_who) and kind = 'dean_threshold' and (p_level is null or ref ->> 'level' = p_level);
$$;
select pg_temp.as_owner();
select pg_temp.ab('dn-0', 't-a2', 10, true);
insert into pg_temp.res select 'деканат: уважительные часы не считаются', pg_temp.dean(2, null) = 0 and pg_temp.dean(1, null) = 0, '';
select pg_temp.ab('dn-1', 't-a2', 4, false);
select pg_temp.ab('dn-2', 't-a2', 3, false);
insert into pg_temp.res select 'деканат: 7 ч < 8 — ничего', pg_temp.dean(2, null) = 0, '';
select pg_temp.ab('dn-3', 't-a2', 1, false);
insert into pg_temp.res select 'деканат: 8 ч — предупреждение студенту', pg_temp.dean(2, 'warn') = 1, pg_temp.dean(2, 'warn')::text;
insert into pg_temp.res select 'деканат: текст студента без ФИО',
  exists (select 1 from public.notifications where user_id = pg_temp.u(2) and kind = 'dean_threshold'
            and title = 'Приближение к порогу деканата' and body like '8 ч неуважительных пропусков за %'
            and body like '%(предупреждение — 8 ч, деканат — 12 ч)' and body not like '%Тестов%'
            and dedupe_key = 'dean:t-a2:' || to_char((select m0 from pg_temp.d), 'YYYY-MM') || ':warn'), '';
insert into pg_temp.res select 'деканат: старосте — с ФИО студента',
  exists (select 1 from public.notifications where user_id = pg_temp.u(1) and kind = 'dean_threshold' and ref ->> 'level' = 'warn'
            and body like 'Тестов Зам: 8 ч неуважительных%'), '';
insert into pg_temp.res select 'деканат: другим студентам и чужой группе — ничего',
  pg_temp.dean(3, null) = 0 and pg_temp.dean(8, null) = 0 and pg_temp.dean(9, null) = 0, '';
select pg_temp.ab('dn-4', 't-a2', 1, false);
insert into pg_temp.res select 'деканат: следующий пропуск после порога не дублирует', pg_temp.dean(2, null) = 1 and pg_temp.dean(1, null) = 1, '';
select pg_temp.ab('dn-p', 't-a2', 10, false, (select prev_m from pg_temp.d));
insert into pg_temp.res select 'деканат: пропуск прошлого месяца не влияет', pg_temp.dean(2, null) = 1, '';
update public.absences set hours = 20 where id = 'dn-0';
insert into pg_temp.res select 'деканат: правка уважительного пропуска не влияет', pg_temp.dean(2, null) = 1, '';
select pg_temp.ab('dn-5', 't-a2', 3, false);
insert into pg_temp.res select 'деканат: 12 ч — порог деканата (студенту и старосте)',
  pg_temp.dean(2, 'dean') = 1 and pg_temp.dean(1, 'dean') = 1 and pg_temp.dean(2, 'warn') = 1, '';
insert into pg_temp.res select 'деканат: заголовок порога',
  exists (select 1 from public.notifications where user_id = pg_temp.u(2) and ref ->> 'level' = 'dean' and title = 'Достигнут порог деканата'
            and body like '12 ч %'), '';
select pg_temp.ab('dn-6', 't-a2', 2, false);
update public.absences set is_excused = true where id = 'dn-1';
update public.absences set is_excused = false where id = 'dn-1';
insert into pg_temp.res select 'деканат: дальше в этом месяце — без повторов', pg_temp.dean(2, null) = 2 and pg_temp.dean(1, null) = 2, '';
-- сразу через оба порога — только «деканат»
select pg_temp.ab('dn-b', 't-b2', 20, false);
insert into pg_temp.res select 'деканат: сразу через оба порога — одно уведомление «деканат»',
  pg_temp.dean(9, 'dean') = 1 and pg_temp.dean(9, 'warn') = 0 and pg_temp.dean(8, 'dean') = 1, '';
-- закрытая группа
select pg_temp.ab('dn-c', 't-c1', 20, false);
insert into pg_temp.res select 'деканат: закрытая группа — ничего', pg_temp.dean(11, null) = 0, '';
-- путь клиента: староста вносит пропуск студенту без аккаунта → уведомления старосте и заму
select pg_temp.expect_allowed('деканат: староста вносит пропуск (триггер под ролью клиента)', pg_temp.u(1),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by)
    values ('dn-k', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a5', (select today from pg_temp.d), 'Статистика', 8, 'lecture', auth.uid())$$);
insert into pg_temp.res select 'деканат: студент без аккаунта — уведомление только старосте и заму',
  exists (select 1 from public.notifications where user_id = pg_temp.u(1) and kind = 'dean_threshold' and body like 'Тестов Свободный: 8 ч%')
  and exists (select 1 from public.notifications where user_id = pg_temp.u(2) and kind = 'dean_threshold' and body like 'Тестов Свободный: 8 ч%')
  and pg_temp.dean(3, null) = 0, '';
select pg_temp.expect_count('деканат: студент видит своё уведомление', pg_temp.u(2),
  $$select 1 from public.notifications where kind = 'dean_threshold' and ref ->> 'student_id' = 't-a2'$$, 2);
select pg_temp.expect_count('деканат: студент B не видит уведомления о студенте A', pg_temp.u(9),
  $$select 1 from public.notifications where kind = 'dean_threshold' and ref ->> 'student_id' <> 't-b2'$$, 0);

-- ===== 8. Техработы =====
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_count('техработы: студент не читает настройки', pg_temp.u(9), 'select 1 from public.notification_prefs', 0);
select pg_temp.expect_denied('техработы: студент не пишет настройки', pg_temp.u(3),
  $$insert into public.notification_prefs (kind, enabled) values ('task', false)$$);
select pg_temp.expect_count('техработы: студент не читает перепривязку', pg_temp.u(3), 'select 1 from public.tg_rebind', 0);
select pg_temp.expect_call_fail('техработы: «Пропустить» недоступно', pg_temp.u(9), 'select public.tg_rebind_dismiss()');
select pg_temp.expect_call_fail('техработы: код привязки не выдаётся', pg_temp.u(3), 'select public.tg_create_link_code()');
select pg_temp.expect_call_ok('техработы: сисадмин сбрасывает привязки', pg_temp.u(7), 'select public.tg_reset_all()');
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

-- ===== 9. Права на функции и cron =====
insert into pg_temp.res select 'права: claim/done/notify_daily — только service_role',
  not has_function_privilege('authenticated', 'public.tg_claim_notifications(int)', 'execute')
  and not has_function_privilege('anon', 'public.tg_claim_notifications(int)', 'execute')
  and not has_function_privilege('authenticated', 'public.tg_notification_done(uuid, boolean, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.notify_daily()', 'execute')
  and has_function_privilege('service_role', 'public.tg_claim_notifications(int)', 'execute')
  and has_function_privilege('service_role', 'public.tg_notification_done(uuid, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'public.notify_daily()', 'execute'), '';
insert into pg_temp.res select 'права: триггерные функции закрыты',
  not has_function_privilege('authenticated', 'public.absences_dean_notify()', 'execute')
  and not has_function_privilege('authenticated', 'public.notifications_dedupe()', 'execute'), '';
insert into pg_temp.res select 'права: tg_reset_all / tg_rebind_dismiss не для анонима',
  not has_function_privilege('anon', 'public.tg_reset_all()', 'execute')
  and not has_function_privilege('anon', 'public.tg_rebind_dismiss()', 'execute'), '';
insert into pg_temp.res select 'права: service_role пишет tg_rebind (гашение из tg-bot)',
  has_table_privilege('service_role', 'public.tg_rebind', 'update') and has_table_privilege('service_role', 'public.notifications', 'insert'), '';
insert into pg_temp.res select 'cron: три задания этапа 3 с расписанием',
  (select count(*) from cron.job where (jobname, schedule) in
     (('journal-tg-dispatch', '* * * * *'), ('journal-schedule-nightly', '0 0 * * *'), ('journal-notify-daily', '0 6 * * *'))) = 3, '';
insert into pg_temp.res select 'cron: адреса функций и секрет из Vault',
  exists (select 1 from cron.job where jobname = 'journal-tg-dispatch' and command like '%/functions/v1/tg-dispatch%' and command like '%cron_secret%')
  and exists (select 1 from cron.job where jobname = 'journal-schedule-nightly' and command like '%/functions/v1/schedule-nightly%' and command like '%cron_secret%')
  and exists (select 1 from cron.job where jobname = 'journal-notify-daily' and command = 'select public.notify_daily()'), '';
insert into pg_temp.res select 'cron: старое journal-reminders не тронуто', exists (select 1 from cron.job where jobname = 'journal-reminders'), '';
