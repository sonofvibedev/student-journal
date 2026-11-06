-- Тесты этапа 4 (преподаватели и чат). Выполняются после prelude.sql, в одной транзакции (раннер откатывает всё).
-- Фикстуры prelude: 1 староста A, 2 заместитель A, 3 студент A, 4 ожидает A, 5 препод лекций A («Маркетинг услуг»),
-- 6 препод ПЗ A («Маркетинг услуг»), 7 сисадмин, 8 староста B, 9 студент B, 10 студент 24ДММ-2, 11 без групп.
-- Здесь же: 12 — преподаватель лекций группы B («Логистика»).
-- Внимание: внутри транзакции now() постоянен, поэтому все сообщения теста — «в одну минуту» и «в один 5-минутный бакет».

-- ===== помощники этого набора =====
-- вызов под пользователем → текст результата или 'ERR:<sqlerrm>'
create function pg_temp.val_as(u uuid, q text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(u);
  begin execute 'select (' || q || ')::text' into v; exception when others then v := 'ERR:' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;

-- вызов должен упасть с точным кодом ошибки
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

create function pg_temp.th(s int, t int) returns uuid language sql as
$$ select id from public.chat_threads where student_user_id = pg_temp.u(s) and teacher_user_id = pg_temp.u(t) $$;

-- открытый ключ JWK и резервная копия правильного формата (содержимое — заглушки)
create function pg_temp.jwk(tag text) returns jsonb language sql as
$$ select jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', rpad(tag, 43, 'A'), 'y', rpad(tag, 43, 'B')) $$;
create function pg_temp.bak(tag text) returns jsonb language sql as
$$ select jsonb_build_object('v', 1, 'kdf', 'PBKDF2-SHA256', 'iter', 600000, 'salt', rpad('s', 22, 'S'),
                             'iv', rpad('i', 16, 'I'), 'ct', rpad(tag, 64, 'C')) $$;

create function pg_temp.send(u int, s int, t int, kv_s int, kv_r int, ct text default 'Q2lwaGVydGV4dEdvZXNIZXJlMTIzNDU2') returns text language sql as
$$ select pg_temp.val_as(pg_temp.u(u), format('public.chat_send(%L::uuid, %L, %L, %s, %s)',
                                             pg_temp.th(s, t), rpad('v', 16, 'V'), ct, kv_s, kv_r)) $$;

-- ===== фикстуры этапа 4 (владелец) =====
alter table public.tasks enable trigger zz_fill_group_id;
alter table public.tasks enable trigger tasks_notify;

insert into public.memberships (user_id, group_id, base_role, status) values
  (pg_temp.u(12), 'bbbbbbbb-0000-4000-8000-00000000000b', 'teacher_lecture', 'active');
insert into public.teacher_assignments (user_id, group_id, subject, lesson_kind) values
  (pg_temp.u(12), 'bbbbbbbb-0000-4000-8000-00000000000b', 'Логистика', 'lecture'),
  (pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', 'Эконометрика', 'lecture');
-- ключи заместителя и преподавателя ПЗ заводим сразу (староста и лектор публикуют через RPC ниже)
insert into public.chat_keys (user_id, public_jwk, key_version, backup) values
  (pg_temp.u(2), pg_temp.jwk('dep'), 1, pg_temp.bak('dep')),
  (pg_temp.u(6), pg_temp.jwk('prac'), 3, pg_temp.bak('prac'));

-- ===================================================================================================
-- 1. Ключи
-- ===================================================================================================
select pg_temp.expect_val('ключи: староста публикует → версия 1', pg_temp.u(1),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb) ->> %L', pg_temp.jwk('head'), pg_temp.bak('h1'), 'key_version'), '1');
select pg_temp.expect_val('ключи: повтор с тем же ключом меняет только копию, версия та же', pg_temp.u(1),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb) ->> %L', pg_temp.jwk('head'), pg_temp.bak('h2'), 'key_version'), '1');
insert into pg_temp.res select 'ключи: копия обновилась', (select backup ->> 'ct' from public.chat_keys where user_id = pg_temp.u(1)) = rpad('h2', 64, 'C'), '';
select pg_temp.expect_err('ключи: другой ключ без сброса → key_mismatch', pg_temp.u(1),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('evil'), pg_temp.bak('h3')), 'key_mismatch');
select pg_temp.expect_val('ключи: сброс → версия 2', pg_temp.u(1),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb, true) ->> %L', pg_temp.jwk('head2'), pg_temp.bak('h4'), 'key_version'), '2');
insert into pg_temp.res select 'ключи: после сброса новый открытый ключ',
  (select public_jwk ->> 'x' from public.chat_keys where user_id = pg_temp.u(1)) = rpad('head2', 43, 'A'), '';
select pg_temp.expect_val('ключи: преподаватель лекций публикует', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb) ->> %L', pg_temp.jwk('lect'), pg_temp.bak('l1'), 'key_version'), '1');
select pg_temp.expect_err('ключи: закрытая часть (d) не принимается', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect') || '{"d":"secret"}', pg_temp.bak('l1')), 'bad_key');
select pg_temp.expect_err('ключи: не P-256 не принимается', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect') || '{"crv":"P-384"}', pg_temp.bak('l1')), 'bad_key');
select pg_temp.expect_err('ключи: копия с iter < 600000 не принимается', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect'), pg_temp.bak('l1') || '{"iter":100000}'), 'bad_backup');
select pg_temp.expect_err('ключи: копия с дробным iter не принимается', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect'), pg_temp.bak('l1') || '{"iter":600000.5}'), 'bad_backup');
select pg_temp.expect_err('ключи: копия без ct не принимается', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect'), pg_temp.bak('l1') - 'ct'), 'bad_backup');
insert into pg_temp.res select 'ключи: лишние поля ключа и копии не сохраняются',
  (select public_jwk ?| array['d', 'ext', 'key_ops'] or backup ?| array['password', 'jwk']
     from public.chat_keys where user_id = pg_temp.u(5)) is false, '';
select pg_temp.expect_err('ключи: обычный студент не заводит', pg_temp.u(3),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('st'), pg_temp.bak('s')), 'forbidden');
select pg_temp.expect_err('ключи: ожидающий не заводит', pg_temp.u(4),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('st'), pg_temp.bak('s')), 'forbidden');
select pg_temp.expect_err('ключи: сисадмин без членства не заводит', pg_temp.u(7),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('st'), pg_temp.bak('s')), 'forbidden');
select pg_temp.expect_err('ключи: пользователь без групп не заводит', pg_temp.u(11),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('st'), pg_temp.bak('s')), 'forbidden');
select pg_temp.expect_count('ключи: своя строка видна целиком (с копией)', pg_temp.u(1),
  'select 1 from public.chat_keys where backup is not null', 1);
select pg_temp.expect_count('ключи: преподаватель не видит строку старосты', pg_temp.u(5),
  format('select 1 from public.chat_keys where user_id = %L', pg_temp.u(1)), 0);
select pg_temp.expect_count('ключи: сисадмин не видит ни ключей, ни копий', pg_temp.u(7), 'select 1 from public.chat_keys', 0);
select pg_temp.expect_count('ключи: студент не видит чужих', pg_temp.u(3), 'select 1 from public.chat_keys', 0);
select pg_temp.expect_denied('ключи: прямая вставка закрыта', pg_temp.u(3),
  format('insert into public.chat_keys (user_id, public_jwk, backup) values (auth.uid(), %L, %L)', pg_temp.jwk('x'), pg_temp.bak('x')));
select pg_temp.expect_denied('ключи: прямая правка своей строки закрыта', pg_temp.u(1),
  'update public.chat_keys set key_version = 1');
select pg_temp.expect_denied('ключи: прямое удаление закрыто', pg_temp.u(1), 'delete from public.chat_keys');
insert into pg_temp.res select 'ключи: аноним без прав на таблицы и RPC чата',
  not has_table_privilege('anon', 'public.chat_keys', 'select')
  and not has_table_privilege('anon', 'public.chat_messages', 'select')
  and not has_function_privilege('anon', 'public.chat_keys_publish(jsonb, jsonb, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.chat_send(uuid, text, text, int, int)', 'execute'), '';

-- ===================================================================================================
-- 2. Треды
-- ===================================================================================================
select pg_temp.expect_call_ok('треды: староста открывает тред с лектором группы', pg_temp.u(1),
  format('select public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)));
select pg_temp.expect_val('треды: повтор возвращает тот же тред', pg_temp.u(1),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)), pg_temp.th(1, 5)::text);
select pg_temp.expect_call_ok('треды: староста открывает тред с практиком', pg_temp.u(1),
  format('select public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(6)));
select pg_temp.expect_call_ok('треды: заместитель открывает свой тред с лектором', pg_temp.u(2),
  format('select public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)));
insert into pg_temp.res select 'треды: вид из base_role преподавателя',
  (select kind from public.chat_threads where id = pg_temp.th(1, 5)) = 'lecture'
  and (select kind from public.chat_threads where id = pg_temp.th(1, 6)) = 'practice', '';
insert into pg_temp.res select 'треды: у старосты и зама отдельные треды с лектором',
  pg_temp.th(1, 5) is not null and pg_temp.th(2, 5) is not null and pg_temp.th(1, 5) <> pg_temp.th(2, 5), '';
select pg_temp.expect_err('треды: обычный студент не открывает', pg_temp.u(3),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)), 'forbidden');
select pg_temp.expect_err('треды: преподаватель не открывает', pg_temp.u(5),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(6)), 'forbidden');
select pg_temp.expect_err('треды: сисадмин не открывает', pg_temp.u(7),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)), 'forbidden');
select pg_temp.expect_err('треды: староста B не открывает в группе A', pg_temp.u(8),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)), 'forbidden');
select pg_temp.expect_err('треды: с обычным студентом нельзя (not_teacher)', pg_temp.u(1),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(3)), 'not_teacher');
select pg_temp.expect_err('треды: с преподавателем другой группы нельзя', pg_temp.u(1),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(12)), 'not_teacher');
select pg_temp.expect_err('треды: староста B — с преподавателем без назначения в B нельзя', pg_temp.u(8),
  format('public.chat_thread_open(%L, %L)', 'bbbbbbbb-0000-4000-8000-00000000000b', pg_temp.u(5)), 'not_teacher');
select pg_temp.expect_err('треды: с сисадмином нельзя', pg_temp.u(1),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(7)), 'not_teacher');
select pg_temp.expect_denied('треды: прямая вставка закрыта', pg_temp.u(1),
  format($$insert into public.chat_threads (group_id, student_user_id, teacher_user_id, kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', auth.uid(), %L, 'lecture')$$, pg_temp.u(12)));
select pg_temp.expect_count('треды: преподаватель видит свои два треда', pg_temp.u(5), 'select 1 from public.chat_threads', 2);
select pg_temp.expect_count('треды: староста видит свои два', pg_temp.u(1), 'select 1 from public.chat_threads', 2);
select pg_temp.expect_count('треды: студент не видит', pg_temp.u(3), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('треды: сисадмин не видит', pg_temp.u(7), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('треды: староста B не видит', pg_temp.u(8), 'select 1 from public.chat_threads', 0);

-- ===================================================================================================
-- 3. Ключ собеседника
-- ===================================================================================================
select pg_temp.expect_val('ключ собеседника: староста получает ключ лектора', pg_temp.u(1),
  format('public.chat_peer_key(%L) ->> %L', pg_temp.th(1, 5), 'user_id'), pg_temp.u(5)::text);
select pg_temp.expect_val('ключ собеседника: лектор получает текущую версию старосты', pg_temp.u(5),
  format('public.chat_peer_key(%L) ->> %L', pg_temp.th(1, 5), 'key_version'), '2');
select pg_temp.expect_val('ключ собеседника: без копии и закрытых полей', pg_temp.u(5),
  format('(public.chat_peer_key(%L) ?| array[%L, %L])', pg_temp.th(1, 5), 'backup', 'd'), 'false');
select pg_temp.expect_err('ключ собеседника: практик не получает чужой тред', pg_temp.u(6),
  format('public.chat_peer_key(%L)', pg_temp.th(1, 5)), 'forbidden');
select pg_temp.expect_err('ключ собеседника: сисадмин не получает', pg_temp.u(7),
  format('public.chat_peer_key(%L)', pg_temp.th(1, 5)), 'forbidden');

-- ===================================================================================================
-- 4. Отправка и чтение
-- ===================================================================================================
-- версии: староста 2, лектор 1, зам 1, практик 3
insert into pg_temp.res select 'отправка: староста пишет лектору', pg_temp.send(1, 1, 5, 2, 1) !~ '^ERR', '';
insert into pg_temp.res select 'отправка: лектор отвечает', pg_temp.send(5, 1, 5, 1, 2) !~ '^ERR', '';
insert into pg_temp.res select 'отправка: зам пишет лектору', pg_temp.send(2, 2, 5, 1, 1) !~ '^ERR', '';
insert into pg_temp.res select 'отправка: устаревшая своя версия → key_changed', pg_temp.send(1, 1, 5, 1, 1) = 'ERR:key_changed', pg_temp.send(1, 1, 5, 1, 1);
insert into pg_temp.res select 'отправка: устаревшая версия собеседника → key_changed', pg_temp.send(1, 1, 5, 2, 7) = 'ERR:key_changed', '';
insert into pg_temp.res select 'отправка: версии местами → key_changed', pg_temp.send(5, 1, 5, 2, 1) = 'ERR:key_changed', '';
insert into pg_temp.res select 'отправка: больше 8 КБ → too_long', pg_temp.send(1, 1, 5, 2, 1, repeat('A', 10924)) = 'ERR:too_long', '';
insert into pg_temp.res select 'отправка: ровно 8 КБ проходит', pg_temp.send(1, 1, 5, 2, 1, repeat('A', 10923)) !~ '^ERR', '';
insert into pg_temp.res select 'отправка: не base64url → bad_message', pg_temp.send(1, 1, 5, 2, 1, 'привет, это открытый текст') = 'ERR:bad_message', '';
insert into pg_temp.res select 'отправка: короче тега → bad_message', pg_temp.send(1, 1, 5, 2, 1, 'AAAA') = 'ERR:bad_message', '';
select pg_temp.expect_err('отправка: кривой iv → bad_message', pg_temp.u(1),
  format('public.chat_send(%L, %L, %L, 2, 1)', pg_temp.th(1, 5), 'short', repeat('A', 32)), 'bad_message');
insert into pg_temp.res select 'отправка: практик не пишет в чужой тред', pg_temp.send(6, 1, 5, 3, 2) = 'ERR:forbidden', '';
insert into pg_temp.res select 'отправка: зам не пишет в тред старосты', pg_temp.send(2, 1, 5, 1, 1) = 'ERR:forbidden', '';
insert into pg_temp.res select 'отправка: студент не пишет', pg_temp.send(3, 1, 5, 1, 1) = 'ERR:forbidden', '';
insert into pg_temp.res select 'отправка: сисадмин не пишет', pg_temp.send(7, 1, 5, 1, 1) = 'ERR:forbidden', '';
insert into pg_temp.res select 'отправка: староста B не пишет', pg_temp.send(8, 1, 5, 1, 1) = 'ERR:forbidden', '';
delete from public.chat_keys where user_id = pg_temp.u(6);
insert into pg_temp.res select 'отправка: практик без ключей → key_changed', pg_temp.send(1, 1, 6, 2, 3) = 'ERR:key_changed', '';
insert into public.chat_keys (user_id, public_jwk, key_version, backup) values (pg_temp.u(6), pg_temp.jwk('prac'), 3, pg_temp.bak('prac'));
insert into pg_temp.res select 'отправка: отправитель записан как вызывающий',
  (select bool_and(sender_id = pg_temp.u(1)) from public.chat_messages where thread_id = pg_temp.th(1, 5) and sender_key_version = 2), '';

select pg_temp.expect_count('чтение: староста видит переписку с лектором', pg_temp.u(1),
  format('select 1 from public.chat_messages where thread_id = %L', pg_temp.th(1, 5)), 3);
select pg_temp.expect_count('чтение: лектор видит обе свои переписки', pg_temp.u(5), 'select 1 from public.chat_messages', 4);
select pg_temp.expect_count('чтение: зам не видит переписку старосты', pg_temp.u(2),
  format('select 1 from public.chat_messages where thread_id = %L', pg_temp.th(1, 5)), 0);
select pg_temp.expect_count('чтение: практик не видит переписку лектора', pg_temp.u(6), 'select 1 from public.chat_messages', 0);
select pg_temp.expect_count('чтение: студент не видит', pg_temp.u(3), 'select 1 from public.chat_messages', 0);
select pg_temp.expect_count('чтение: сисадмин не видит сообщений', pg_temp.u(7), 'select 1 from public.chat_messages', 0);
select pg_temp.expect_count('чтение: староста B не видит', pg_temp.u(8), 'select 1 from public.chat_messages', 0);
select pg_temp.expect_denied('сообщения: прямая вставка закрыта (участник)', pg_temp.u(1),
  format($$insert into public.chat_messages (thread_id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext) values (%L, auth.uid(), 2, 1, 'VVVVVVVVVVVVVVVV', 'QUFBQUFBQUFBQUFBQUFBQUFBQUFB')$$, pg_temp.th(1, 5)));
select pg_temp.expect_denied('сообщения: правка своего закрыта', pg_temp.u(1), $$update public.chat_messages set ciphertext = 'AAAAAAAAAAAAAAAAAAAAAAAA'$$);
select pg_temp.expect_denied('сообщения: удаление закрыто', pg_temp.u(5), 'delete from public.chat_messages');
select pg_temp.expect_denied('отметки: прямая вставка закрыта', pg_temp.u(5),
  format('insert into public.chat_reads (thread_id, user_id) values (%L, auth.uid())', pg_temp.th(1, 5)));

-- ===================================================================================================
-- 5. Уведомления о сообщениях
-- ===================================================================================================
select pg_temp.expect_count('уведомление: лектору одно на тред старосты за 5 минут (дубли отброшены)', pg_temp.u(5),
  format($$select 1 from public.notifications where kind = 'chat' and ref ->> 'thread_id' = %L$$, pg_temp.th(1, 5)), 1);
select pg_temp.expect_count('уведомление: текст фиксированный, подпись «Староста ТЕСТ-1»', pg_temp.u(5),
  format($$select 1 from public.notifications where kind = 'chat' and ref ->> 'thread_id' = %L
           and title = 'Новое сообщение в чате' and body = 'Староста ТЕСТ-1' and ref = jsonb_build_object('thread_id', %L::uuid)$$,
         pg_temp.th(1, 5), pg_temp.th(1, 5)), 1);
select pg_temp.expect_count('уведомление: от зама — «Зам. старосты ТЕСТ-1»', pg_temp.u(5),
  format($$select 1 from public.notifications where kind = 'chat' and ref ->> 'thread_id' = %L and body = 'Зам. старосты ТЕСТ-1'$$, pg_temp.th(2, 5)), 1);
select pg_temp.expect_count('уведомление: старосте от лектора — «Преподаватель»', pg_temp.u(1),
  $$select 1 from public.notifications where kind = 'chat' and body = 'Преподаватель'$$, 1);
insert into pg_temp.res select 'уведомление: нет шифртекста и iv ни в одном поле',
  not exists (select 1 from public.notifications n where n.kind = 'chat'
               and (n.title || coalesce(n.body, '') || coalesce(n.ref::text, '')) ~ '(Q2lwaGVy|VVVVVVVV|AAAAAAAAAAAA)'), '';
insert into pg_temp.res select 'уведомление: ключ дедупликации chat:<тред>:<получатель>:<бакет>',
  (select dedupe_key from public.notifications where kind = 'chat' and user_id = pg_temp.u(5) and ref ->> 'thread_id' = pg_temp.th(1, 5)::text)
    = 'chat:' || pg_temp.th(1, 5) || ':' || pg_temp.u(5) || ':' || floor(extract(epoch from now()) / 300)::bigint, '';
insert into pg_temp.res select 'уведомление: отправителю своё не приходит',
  not exists (select 1 from public.notifications where kind = 'chat' and user_id = pg_temp.u(2)), '';

-- ===================================================================================================
-- 6. Мои треды и прочтение
-- ===================================================================================================
select pg_temp.expect_val('мои треды: у старосты 2 треда (лектор, практик), unread от лектора = 1', pg_temp.u(1),
  $$(select string_agg(peer_role || ':' || (thread_id is not null) || ':' || unread || ':' || peer_name, ',' order by peer_role) from public.chat_threads_my())$$,
  'teacher_lecture:true:1:Преподаватель лекций,teacher_practice:true:0:Преподаватель ПЗ');
select pg_temp.expect_val('мои треды: лектор видит старосту и зама с подписями', pg_temp.u(5),
  $$(select string_agg(peer_role || ':' || group_name || ':' || peer_name || ':' || unread || ':' || kind, ',' order by peer_role) from public.chat_threads_my())$$,
  'deputy:ТЕСТ-1:Зам. старосты ТЕСТ-1:1:lecture,headman:ТЕСТ-1:Староста ТЕСТ-1:2:lecture');
select pg_temp.expect_val('мои треды: у зама — лектор с тредом и практик без треда', pg_temp.u(2),
  $$(select string_agg(peer_role || ':' || coalesce(thread_id::text, 'null') || ':' || coalesce(last_message_at::text, '-'), ',' order by peer_role) from public.chat_threads_my())$$,
  'teacher_lecture:' || pg_temp.th(2, 5) || ':' || now()::text || ',teacher_practice:null:-');
select pg_temp.expect_val('мои треды: студент — пусто', pg_temp.u(3), '(select count(*) from public.chat_threads_my())', '0');
select pg_temp.expect_val('мои треды: сисадмин — пусто', pg_temp.u(7), '(select count(*) from public.chat_threads_my())', '0');
select pg_temp.expect_val('мои треды: староста B — лектор группы B без треда', pg_temp.u(8),
  $$(select string_agg(peer_role || ':' || coalesce(thread_id::text, 'null'), ',') from public.chat_threads_my())$$, 'teacher_lecture:null');

select pg_temp.expect_call_ok('прочтение: лектор отмечает тред старосты', pg_temp.u(5), format('select public.chat_mark_read(%L)', pg_temp.th(1, 5)));
select pg_temp.expect_val('прочтение: unread у лектора по треду старосты = 0', pg_temp.u(5),
  format('(select unread from public.chat_threads_my() where thread_id = %L)', pg_temp.th(1, 5)), '0');
select pg_temp.expect_count('прочтение: уведомление chat этого треда погашено', pg_temp.u(5),
  format($$select 1 from public.notifications where kind = 'chat' and ref ->> 'thread_id' = %L and read_at is null$$, pg_temp.th(1, 5)), 0);
select pg_temp.expect_count('прочтение: уведомление другого треда не тронуто', pg_temp.u(5),
  format($$select 1 from public.notifications where kind = 'chat' and ref ->> 'thread_id' = %L and read_at is null$$, pg_temp.th(2, 5)), 1);
select pg_temp.expect_count('прочтение: своя отметка видна', pg_temp.u(5), 'select 1 from public.chat_reads', 1);
select pg_temp.expect_count('прочтение: чужие отметки не видны (староста)', pg_temp.u(1), 'select 1 from public.chat_reads', 0);
select pg_temp.expect_err('прочтение: практик не отмечает чужой тред', pg_temp.u(6), format('public.chat_mark_read(%L)', pg_temp.th(1, 5)), 'forbidden');
select pg_temp.expect_err('прочтение: сисадмин не отмечает', pg_temp.u(7), format('public.chat_mark_read(%L)', pg_temp.th(1, 5)), 'forbidden');

-- ===================================================================================================
-- 7. Лимит 30 сообщений в минуту
-- ===================================================================================================
insert into public.chat_messages (thread_id, sender_id, sender_key_version, recipient_key_version, iv, ciphertext)
select pg_temp.th(1, 6), pg_temp.u(1), 2, 3, 'VVVVVVVVVVVVVVVV', 'QUFBQUFBQUFBQUFBQUFBQUFBQUFB'
  from generate_series(1, 30 - (select count(*) from public.chat_messages where sender_id = pg_temp.u(1)));
insert into pg_temp.res select 'лимит: 31-е сообщение за минуту → rate_limited', pg_temp.send(1, 1, 6, 2, 3) = 'ERR:rate_limited', pg_temp.send(1, 1, 6, 2, 3);
insert into pg_temp.res select 'лимит: на другого отправителя не влияет', pg_temp.send(6, 1, 6, 3, 2) !~ '^ERR', '';

-- ===================================================================================================
-- 8. Смена роли закрывает доступ
-- ===================================================================================================
update public.memberships set extra_role = null where user_id = pg_temp.u(1) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_count('роль: бывший староста не видит треды', pg_temp.u(1), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('роль: бывший староста не видит сообщения', pg_temp.u(1), 'select 1 from public.chat_messages', 0);
insert into pg_temp.res select 'роль: бывший староста не пишет', pg_temp.send(1, 1, 5, 2, 1) = 'ERR:forbidden', '';
select pg_temp.expect_val('роль: у бывшего старосты нет тредов', pg_temp.u(1), '(select count(*) from public.chat_threads_my())', '0');
select pg_temp.expect_err('роль: бывший староста не получает ключ', pg_temp.u(1), format('public.chat_peer_key(%L)', pg_temp.th(1, 5)), 'forbidden');
select pg_temp.expect_count('роль: лектор больше не видит тред бывшего старосты', pg_temp.u(5),
  format('select 1 from public.chat_messages where thread_id = %L', pg_temp.th(1, 5)), 0);
insert into pg_temp.res select 'роль: лектор не пишет бывшему старосте', pg_temp.send(5, 1, 5, 1, 2) = 'ERR:forbidden', '';
insert into pg_temp.res select 'роль: сообщения остались в базе (зашифрованными)',
  (select count(*) from public.chat_messages where thread_id = pg_temp.th(1, 5)) = 3, '';
update public.memberships set extra_role = 'headman' where user_id = pg_temp.u(1) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_count('роль: вернули роль — доступ вернулся', pg_temp.u(1),
  format('select 1 from public.chat_messages where thread_id = %L', pg_temp.th(1, 5)), 3);

delete from public.teacher_assignments where user_id = pg_temp.u(5) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_count('роль: лектор без назначений не видит треды', pg_temp.u(5), 'select 1 from public.chat_threads', 0);
select pg_temp.expect_count('роль: староста не видит тред снятого лектора', pg_temp.u(1),
  format('select 1 from public.chat_messages where thread_id = %L', pg_temp.th(1, 5)), 0);
insert into pg_temp.res select 'роль: староста не пишет снятому лектору', pg_temp.send(1, 1, 5, 2, 1) = 'ERR:forbidden', '';
select pg_temp.expect_err('роль: тред со снятым лектором не открыть', pg_temp.u(1),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(5)), 'not_teacher');
insert into public.teacher_assignments (user_id, group_id, subject, lesson_kind) values
  (pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', 'Маркетинг услуг', 'lecture'),
  (pg_temp.u(5), 'aaaaaaaa-0000-4000-8000-00000000000a', 'Эконометрика', 'lecture');
update public.memberships set status = 'removed' where user_id = pg_temp.u(5) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_count('роль: исключённый лектор не видит сообщения', pg_temp.u(5), 'select 1 from public.chat_messages', 0);
update public.memberships set status = 'active' where user_id = pg_temp.u(5) and group_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_count('роль: восстановленный лектор снова видит', pg_temp.u(5), 'select 1 from public.chat_messages', 4);

-- ===================================================================================================
-- 9. Закрытая группа и техработы
-- ===================================================================================================
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
insert into pg_temp.res select 'закрыта: отправка → group_closed', pg_temp.send(5, 2, 5, 1, 1) = 'ERR:group_closed', '';
select pg_temp.expect_err('закрыта: новый тред не открыть', pg_temp.u(2),
  format('public.chat_thread_open(%L, %L)', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(6)), 'group_closed');
select pg_temp.expect_count('закрыта: переписка читается', pg_temp.u(5), 'select 1 from public.chat_messages', 4);
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
insert into pg_temp.res select 'техработы: отправка → maintenance', pg_temp.send(5, 2, 5, 1, 1) = 'ERR:maintenance', '';
select pg_temp.expect_count('техработы: сообщения не читаются', pg_temp.u(5), 'select 1 from public.chat_messages', 0);
select pg_temp.expect_count('техработы: ключи не читаются', pg_temp.u(5), 'select 1 from public.chat_keys', 0);
select pg_temp.expect_err('техработы: мои треды недоступны', pg_temp.u(5), '(select count(*) from public.chat_threads_my())', 'maintenance');
select pg_temp.expect_err('техработы: ключи не публикуются', pg_temp.u(5),
  format('public.chat_keys_publish(%L::jsonb, %L::jsonb)', pg_temp.jwk('lect'), pg_temp.bak('l9')), 'maintenance');
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';

insert into pg_temp.res select 'права: внутренние функции чата закрыты для клиентов',
  not has_function_privilege('authenticated', 'public._chat_live(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public._chat_b64u_ok(text, int, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.lesson_notes_touch()', 'execute')
  and has_function_privilege('authenticated', 'public.chat_my_thread_ids()', 'execute'), '';
insert into pg_temp.res select 'права: RPC этапа 4 — security definer с пустым search_path',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('chat_keys_publish', 'chat_peer_key', 'chat_thread_open', 'chat_threads_my', 'chat_send',
                        'chat_mark_read', 'teacher_group_stats', 'chat_my_thread_ids', '_chat_live')), '';
insert into pg_temp.res select 'права: «Техработы» на всех новых таблицах',
  (select count(*) from pg_policies where schemaname = 'public' and policyname = 'Техработы' and permissive = 'RESTRICTIVE'
      and tablename in ('chat_keys', 'chat_threads', 'chat_messages', 'chat_reads', 'lesson_notes')) = 5, '';

-- ===================================================================================================
-- 10. Темы занятий (lesson_notes)
-- ===================================================================================================
select pg_temp.expect_allowed('занятия: лектор вносит тему своей лекции', pg_temp.u(5),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic, plan)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 1, 'Маркетинг услуг', 'lecture', 'Тема 1', 'План')$$);
insert into pg_temp.res select 'занятия: автор и время ставятся сами',
  (select updated_by = pg_temp.u(5) and updated_at is not null from public.lesson_notes where pair_no = 1 and lesson_date = '2026-11-10'), '';
select pg_temp.expect_denied('занятия: автора подставить нельзя', pg_temp.u(5),
  format($$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic, updated_by)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 2, 'Маркетинг услуг', 'lecture', 'x', %L)$$, pg_temp.u(6)));
select pg_temp.expect_denied('занятия: лектор не вносит ПЗ', pg_temp.u(5),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 3, 'Маркетинг услуг', 'practice', 'x')$$);
select pg_temp.expect_denied('занятия: лектор не вносит чужую дисциплину', pg_temp.u(5),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 3, 'Статистика', 'lecture', 'x')$$);
select pg_temp.expect_denied('занятия: лектор не вносит в чужую группу', pg_temp.u(5),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('bbbbbbbb-0000-4000-8000-00000000000b', '2026-11-10', 3, 'Маркетинг услуг', 'lecture', 'x')$$);
select pg_temp.expect_denied('занятия: тема длиннее 200 — нельзя', pg_temp.u(5),
  format($$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-11', 1, 'Маркетинг услуг', 'lecture', %L)$$, repeat('т', 201)));
select pg_temp.expect_denied('занятия: план длиннее 4000 — нельзя', pg_temp.u(5),
  format($$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, plan)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-11', 1, 'Маркетинг услуг', 'lecture', %L)$$, repeat('п', 4001)));
select pg_temp.expect_allowed('занятия: upsert лектора (как PostgREST)', pg_temp.u(5),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic, plan)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 1, 'Маркетинг услуг', 'lecture', 'Тема 1б', 'План 2')
    on conflict (group_id, lesson_date, pair_no, subject) do update
      set group_id = excluded.group_id, lesson_date = excluded.lesson_date, pair_no = excluded.pair_no, subject = excluded.subject,
          lesson_kind = excluded.lesson_kind, topic = excluded.topic, plan = excluded.plan$$);
select pg_temp.expect_denied('занятия: практик не перезаписывает лекцию тем же ключом (upsert)', pg_temp.u(6),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-10', 1, 'Маркетинг услуг', 'practice', 'взлом')
    on conflict (group_id, lesson_date, pair_no, subject) do update set topic = excluded.topic, lesson_kind = excluded.lesson_kind$$);
select pg_temp.expect_denied('занятия: практик не правит лекцию', pg_temp.u(6), $$update public.lesson_notes set topic = 'x'$$);
select pg_temp.expect_denied('занятия: лектор не переводит запись в ПЗ', pg_temp.u(5), $$update public.lesson_notes set lesson_kind = 'practice'$$);
select pg_temp.expect_count('занятия: студент группы читает', pg_temp.u(3), $$select 1 from public.lesson_notes where topic = 'Тема 1б'$$, 1);
select pg_temp.expect_count('занятия: староста читает', pg_temp.u(1), 'select 1 from public.lesson_notes', 1);
select pg_temp.expect_count('занятия: студент B не читает', pg_temp.u(9), 'select 1 from public.lesson_notes', 0);
select pg_temp.expect_count('занятия: практик не видит лекцию', pg_temp.u(6), 'select 1 from public.lesson_notes', 0);
select pg_temp.expect_count('занятия: ожидающий не читает', pg_temp.u(4), 'select 1 from public.lesson_notes', 0);
select pg_temp.expect_min('занятия: сисадмин читает', pg_temp.u(7), 'select 1 from public.lesson_notes', 1);
select pg_temp.expect_denied('занятия: студент не пишет', pg_temp.u(3),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-12', 1, 'Маркетинг услуг', 'lecture', 'x')$$);
select pg_temp.expect_denied('занятия: староста не пишет', pg_temp.u(1),
  $$insert into public.lesson_notes (group_id, lesson_date, pair_no, subject, lesson_kind, topic)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', '2026-11-12', 1, 'Маркетинг услуг', 'lecture', 'x')$$);
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_denied('занятия: закрытая группа — не пишет', pg_temp.u(5), $$update public.lesson_notes set topic = 'x'$$);
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_denied('занятия: техработы — не пишет', pg_temp.u(5), $$update public.lesson_notes set topic = 'x'$$);
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';
select pg_temp.expect_allowed('занятия: лектор удаляет свою запись', pg_temp.u(5), 'delete from public.lesson_notes');

-- ===================================================================================================
-- 11. Задания преподавателя
-- ===================================================================================================
insert into public.tasks (id, kind, rec, group_id, created_by) values
  ('tk-hm', 'homework', '{"id":"tk-hm","subject":"Маркетинг услуг","text":"от старосты"}', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(1)),
  ('tk-leg', 'homework', '{"id":"tk-leg","subject":"Маркетинг услуг"}', 'aaaaaaaa-0000-4000-8000-00000000000a', null),
  ('tk-pr', 'homework', '{"id":"tk-pr","subject":"Маркетинг услуг"}', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(6)),
  ('tk-nos', 'homework', '{"id":"tk-nos","text":"без предмета"}', 'aaaaaaaa-0000-4000-8000-00000000000a', pg_temp.u(1));
delete from public.notifications where kind = 'task';

select pg_temp.expect_allowed('задания: лектор вносит по своему предмету', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t1', 'deadline', '{"id":"tk-t1","subject":"Эконометрика","text":"Реферат"}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);
insert into pg_temp.res select 'задания: автор — преподаватель', (select created_by = pg_temp.u(5) from public.tasks where id = 'tk-t1'), '';
insert into pg_temp.res select 'задания: уведомление ушло студентам группы (староста, зам, студент), не автору',
  (select count(*) from public.notifications where kind = 'task' and ref ->> 'task_id' = 'tk-t1'
      and user_id in (pg_temp.u(1), pg_temp.u(2), pg_temp.u(3))) = 3
  and not exists (select 1 from public.notifications where kind = 'task' and ref ->> 'task_id' = 'tk-t1' and user_id = pg_temp.u(5)), '';
select pg_temp.expect_denied('задания: лектор не вносит по чужому предмету', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t2', 'homework', '{"subject":"Статистика"}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_denied('задания: лектор не вносит без предмета', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t3', 'homework', '{"text":"x"}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_denied('задания: лектор не вносит с пустым предметом', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t3', 'homework', '{"subject":""}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_denied('задания: лектор не вносит в чужую группу', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t4', 'homework', '{"subject":"Логистика"}', 'bbbbbbbb-0000-4000-8000-00000000000b')$$);
select pg_temp.expect_denied('задания: лектор не подставляет автора', pg_temp.u(5),
  format($$insert into public.tasks (id, kind, rec, group_id, created_by) values ('tk-t5', 'homework', '{"subject":"Эконометрика"}', 'aaaaaaaa-0000-4000-8000-00000000000a', %L)$$, pg_temp.u(1)));
select pg_temp.expect_count('задания: лектор видит задания только своих предметов', pg_temp.u(5),
  $$select 1 from public.tasks where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 4);
select pg_temp.expect_count('задания: задание без предмета преподавателю не видно', pg_temp.u(5), $$select 1 from public.tasks where id = 'tk-nos'$$, 0);
select pg_temp.expect_allowed('задания: лектор меняет своё', pg_temp.u(5),
  $$update public.tasks set rec = rec || '{"text":"Реферат 2"}' where id = 'tk-t1'$$);
select pg_temp.expect_denied('задания: лектор не переносит своё в чужой предмет', pg_temp.u(5),
  $$update public.tasks set rec = rec || '{"subject":"Статистика"}' where id = 'tk-t1'$$);
select pg_temp.expect_denied('задания: лектор не меняет автора своего', pg_temp.u(5),
  $$update public.tasks set created_by = null where id = 'tk-t1'$$);
select pg_temp.expect_denied('задания: лектор не правит задание старосты', pg_temp.u(5),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'tk-hm'$$);
select pg_temp.expect_denied('задания: староста не удаляет задание преподавателя', pg_temp.u(1), $$delete from public.tasks where id = 'tk-t1'$$);
select pg_temp.expect_denied('задания: староста не правит задание преподавателя', pg_temp.u(1),
  $$update public.tasks set rec = rec || '{"text":"x"}' where id = 'tk-t1'$$);
select pg_temp.expect_denied('задания: лектор не удаляет задание практика', pg_temp.u(5), $$delete from public.tasks where id = 'tk-pr'$$);
select pg_temp.expect_denied('задания: лектор не удаляет задание чужого предмета', pg_temp.u(5), $$delete from public.tasks where id = 'tk-a1'$$);
select pg_temp.expect_allowed('задания: лектор удаляет задание старосты своего предмета', pg_temp.u(5), $$delete from public.tasks where id = 'tk-hm'$$);
select pg_temp.expect_allowed('задания: лектор удаляет легаси-задание своего предмета', pg_temp.u(5), $$delete from public.tasks where id = 'tk-leg'$$);
update public.groups set status = 'closed' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_denied('задания: закрытая группа — лектор не вносит', pg_temp.u(5),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-t6', 'homework', '{"subject":"Эконометрика"}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);
select pg_temp.expect_denied('задания: закрытая группа — лектор не удаляет', pg_temp.u(5), $$delete from public.tasks where id = 'tk-t1'$$);
update public.groups set status = 'active' where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
select pg_temp.expect_allowed('задания: лектор удаляет своё', pg_temp.u(5), $$delete from public.tasks where id = 'tk-t1'$$);
select pg_temp.expect_allowed('задания: староста по-прежнему вносит', pg_temp.u(1),
  $$insert into public.tasks (id, kind, rec, group_id) values ('tk-h2', 'homework', '{"subject":"Статистика"}', 'aaaaaaaa-0000-4000-8000-00000000000a')$$);

-- ===================================================================================================
-- 12. Пропуски и оценки: пути кабинета преподавателя (этапы 1–2)
-- ===================================================================================================
insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind, created_by) values
  ('t4-hm', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'lecture', pg_temp.u(1)),
  ('t4-dp', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a2', '2026-11-05', 'Маркетинг услуг', 2, 'lecture', pg_temp.u(2)),
  ('t4-ns', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', null, 2, 'lecture', pg_temp.u(1)),
  ('t4-lg', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'lecture', null),
  ('t4-pr', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-05', 'Маркетинг услуг', 2, 'practice', pg_temp.u(6));
select pg_temp.expect_count('пропуски: лектор видит только «Маркетинг услуг»/лекции (без пустой дисциплины)', pg_temp.u(5),
  $$select 1 from public.absences where id like 't4-%'$$, 3);
select pg_temp.expect_count('пропуски: пропуск без дисциплины преподавателю не виден', pg_temp.u(5), $$select 1 from public.absences where id = 't4-ns'$$, 0);
select pg_temp.expect_denied('пропуски: лектор не вносит без дисциплины', pg_temp.u(5),
  $$insert into public.absences (group_id, student_id, date, subject, hours, lesson_kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-06', null, 2, 'lecture')$$);
select pg_temp.expect_denied('пропуски: лектор не вносит без вида занятий', pg_temp.u(5),
  $$insert into public.absences (group_id, student_id, date, subject, hours, lesson_kind) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-06', 'Маркетинг услуг', 2, null)$$);
select pg_temp.expect_allowed('пропуски: лектор вносит пропуск (created_by по умолчанию)', pg_temp.u(5),
  $$insert into public.absences (id, group_id, student_id, date, subject, hours, lesson_kind) values ('t4-own', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-06', 'Маркетинг услуг', 2, 'lecture')$$);
select pg_temp.expect_denied('пропуски: лектор не «уводит» свой пропуск в пустую дисциплину', pg_temp.u(5),
  $$update public.absences set subject = null where id = 't4-own'$$);
select pg_temp.expect_denied('пропуски: лектор не уводит свой пропуск в ПЗ', pg_temp.u(5),
  $$update public.absences set lesson_kind = 'practice' where id = 't4-own'$$);
select pg_temp.expect_allowed('пропуски: лектор правит часы своего', pg_temp.u(5), $$update public.absences set hours = 1 where id = 't4-own'$$);
select pg_temp.expect_allowed('пропуски: лектор ставит «уважительный» в записи старосты', pg_temp.u(5),
  $$update public.absences set is_excused = true where id = 't4-hm'$$);
select pg_temp.expect_denied('пропуски: лектор не меняет часы в записи старосты', pg_temp.u(5), $$update public.absences set hours = 1 where id = 't4-hm'$$);
select pg_temp.expect_denied('пропуски: лектор не меняет справку в записи старосты', pg_temp.u(5),
  $$update public.absences set cert_submitted = true where id = 't4-dp'$$);
select pg_temp.expect_denied('пропуски: лектор не трогает пропуск без дисциплины', pg_temp.u(5),
  $$update public.absences set is_excused = true where id = 't4-ns'$$);
select pg_temp.expect_denied('пропуски: лектор не меняет пропуск ПЗ', pg_temp.u(5), $$update public.absences set is_excused = true where id = 't4-pr'$$);
select pg_temp.expect_denied('пропуски: лектор не отменяет пропуск без дисциплины', pg_temp.u(5), $$delete from public.absences where id = 't4-ns'$$);
select pg_temp.expect_denied('пропуски: лектор не отменяет легаси-запись', pg_temp.u(5), $$delete from public.absences where id = 't4-lg'$$);
select pg_temp.expect_denied('пропуски: лектор не отменяет запись практика', pg_temp.u(5), $$delete from public.absences where id = 't4-pr'$$);
select pg_temp.expect_allowed('пропуски: лектор отменяет запись зама своей дисциплины', pg_temp.u(5), $$delete from public.absences where id = 't4-dp'$$);
select pg_temp.expect_allowed('пропуски: лектор отменяет свою запись', pg_temp.u(5), $$delete from public.absences where id = 't4-own'$$);
select pg_temp.expect_allowed('пропуски: староста по-прежнему вносит без вида занятий', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, subject, hours) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-06', 'Статистика', 2)$$);
select pg_temp.expect_allowed('пропуски: староста по-прежнему вносит без дисциплины', pg_temp.u(1),
  $$insert into public.absences (group_id, student_id, date, hours) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', '2026-11-06', 2)$$);
select pg_temp.expect_min('студенты: лектор читает список группы', pg_temp.u(5),
  $$select 1 from public.students where group_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 5);
select pg_temp.expect_count('студенты: лектор не читает чужую группу', pg_temp.u(5),
  $$select 1 from public.students where group_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0);

select pg_temp.expect_allowed('оценки: лектор ставит «зачтено»', pg_temp.u(5),
  $$insert into public.grades (id, group_id, student_id, subject, lesson_kind, passed, lesson_date, comment) values ('gr-t4', 'aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', true, '2026-11-06', 'Тема')$$);
select pg_temp.expect_allowed('оценки: лектор меняет «зачтено» на балл', pg_temp.u(5),
  $$update public.grades set passed = null, value = 7 where id = 'gr-t4'$$);
select pg_temp.expect_denied('оценки: лектор не ставит и балл, и зачёт', pg_temp.u(5),
  $$update public.grades set passed = true where id = 'gr-t4'$$);
select pg_temp.expect_denied('оценки: практик не удаляет лекционную', pg_temp.u(6), $$delete from public.grades where id = 'gr-t4'$$);
select pg_temp.expect_allowed('оценки: лектор удаляет свою (замена отметки)', pg_temp.u(5), $$delete from public.grades where id = 'gr-t4'$$);
select pg_temp.expect_denied('оценки: студент не ставит', pg_temp.u(3),
  $$insert into public.grades (group_id, student_id, subject, lesson_kind, value) values ('aaaaaaaa-0000-4000-8000-00000000000a', 't-a3', 'Маркетинг услуг', 'lecture', 10)$$);

-- ===================================================================================================
-- 13. teacher_group_stats
-- ===================================================================================================
delete from public.absences where group_id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b');
delete from public.schedule_lessons where group_id in ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b');
-- сегодня по Минску = d; в группе A 5 студентов
insert into public.schedule_lessons (group_id, lesson_date, pair_no, subject, kind)
select 'aaaaaaaa-0000-4000-8000-00000000000a', d - x.off, x.pair, x.subj, x.kind
  from (select (now() at time zone 'Europe/Minsk')::date as d) t,
       (values (1, 1, 'Маркетинг услуг', 'lecture'), (2, 1, 'Маркетинг услуг', 'lecture'),
               (10, 2, 'Маркетинг услуг', 'practice'), (1, 3, 'Статистика', 'lecture'),
               (40, 1, 'Маркетинг услуг', 'lecture')) x(off, pair, subj, kind);
insert into public.absences (group_id, student_id, date, subject, hours, lesson_kind, created_by)
select 'aaaaaaaa-0000-4000-8000-00000000000a', x.st, d - x.off, x.subj, x.h, x.kind, pg_temp.u(1)
  from (select (now() at time zone 'Europe/Minsk')::date as d) t,
       (values ('t-a3', 1, 'Маркетинг услуг', 2, 'lecture'), ('t-a2', 20, 'Маркетинг услуг', 2, 'lecture'),
               ('t-a3', 1, 'Маркетинг услуг', 2, 'practice'), ('t-a3', 1, 'Статистика', 2, 'lecture'),
               ('t-a3', 40, 'Маркетинг услуг', 2, 'lecture')) x(st, off, subj, h, kind);
-- лектор: 2 лекции × 2 ч × 5 = 20 ч плана, пропусков 4 → 80.0; за неделю 2
select pg_temp.expect_val('статистика: лектор', pg_temp.u(5),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$,
  '{"students": 5, "absences_week": 2, "attendance_pct": 80.0}');
-- практик: 1 × 2 × 5 = 10, пропусков 2 → 80.0
select pg_temp.expect_val('статистика: практик — только ПЗ', pg_temp.u(6),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$,
  '{"students": 5, "absences_week": 2, "attendance_pct": 80.0}');
-- сисадмин: все назначения группы — 3 пары × 10 = 30, пропусков 6 → 80.0
select pg_temp.expect_val('статистика: сисадмин — все назначения группы', pg_temp.u(7),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$,
  '{"students": 5, "absences_week": 4, "attendance_pct": 80.0}');
select pg_temp.expect_val('статистика: пар не было → attendance_pct null', pg_temp.u(12),
  $$public.teacher_group_stats('bbbbbbbb-0000-4000-8000-00000000000b')$$,
  '{"students": 2, "absences_week": 0, "attendance_pct": null}');
select pg_temp.expect_err('статистика: студент не получает', pg_temp.u(3),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'forbidden');
select pg_temp.expect_err('статистика: староста не получает', pg_temp.u(1),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'forbidden');
select pg_temp.expect_err('статистика: лектор не получает чужую группу', pg_temp.u(5),
  $$public.teacher_group_stats('bbbbbbbb-0000-4000-8000-00000000000b')$$, 'forbidden');
update public.app_settings set value = '{"on": true}'::jsonb where key = 'maintenance';
select pg_temp.expect_err('статистика: техработы', pg_temp.u(5),
  $$public.teacher_group_stats('aaaaaaaa-0000-4000-8000-00000000000a')$$, 'maintenance');
update public.app_settings set value = '{"on": false}'::jsonb where key = 'maintenance';
