-- Тесты сброса пароля: таблица password_resets и password_reset_issue (вызывает только Edge Function секретным ключом,
-- поэтому функцию зовём владельцем, а клиентам проверяем отказ). Фикстуры prelude: 1 староста A, 2 заместитель A,
-- 3 студент A, 4 ожидает A, 5 препод лекций A, 7 сисадмин, 8 староста B, 9 студент B; t-a5 — свободная запись.

-- текст ошибки вызова (или 'ok')
create function pg_temp.issue(actor int, sid text, code text default null) returns text language plpgsql as $$
begin
  perform public.password_reset_issue(pg_temp.u(actor), sid,
    encode(extensions.digest(coalesce(code, gen_random_uuid()::text), 'sha256'), 'hex'));
  return 'ok';
exception when others then return sqlerrm;
end $$;
create function pg_temp.is(t text, got text, want text) returns void language sql as
$$ insert into pg_temp.res values (t, got is not distinct from want, 'ожидалось ' || want || ', получено ' || coalesce(got, 'null')) $$;
create function pg_temp.ok(t text, c boolean, d text default '') returns void language sql as
$$ insert into pg_temp.res values (t, coalesce(c, false), coalesce(d, 'null')) $$;
create function pg_temp.codes(n int) returns bigint language sql as
$$ select count(*) from public.password_resets where user_id = pg_temp.u(n) $$;

-- ===== клиентам закрыто =====
select pg_temp.ok('студент не читает коды', pg_temp.count_as(pg_temp.u(3), 'select 1 from public.password_resets') is null);
select pg_temp.ok('сисадмин через клиент не читает коды', pg_temp.count_as(pg_temp.u(7), 'select 1 from public.password_resets') is null);
select pg_temp.expect_denied('клиент не пишет коды', pg_temp.u(1),
  $q$insert into public.password_resets (code_hash, user_id) values (repeat('a', 64), auth.uid())$q$);
select pg_temp.expect_call_fail('authenticated не вызывает выпуск', pg_temp.u(1),
  $q$select public.password_reset_issue(auth.uid(), 't-a3', repeat('a', 64))$q$);
do $$ declare failed boolean := false; begin
  perform pg_temp.as_anon();
  begin perform public.password_reset_issue(null, 't-a3', repeat('a', 64)); exception when others then failed := true; end;
  execute 'reset role';
  insert into pg_temp.res values ('anon не вызывает выпуск', failed, case when failed then 'отказ' else 'вызов прошёл' end);
end $$;

-- ===== кто может =====
select pg_temp.is('староста → студент своей группы', pg_temp.issue(1, 't-a3', 'CODE1'), 'ok');
select pg_temp.is('хранится только хэш', (select code_hash from public.password_resets where user_id = pg_temp.u(3)),
  encode(extensions.digest('CODE1', 'sha256'), 'hex'));
select pg_temp.ok('срок 24 часа', (select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
  from public.password_resets where user_id = pg_temp.u(3)));
select pg_temp.ok('created_by = староста', (select created_by = pg_temp.u(1) from public.password_resets where user_id = pg_temp.u(3)));
select pg_temp.ok('запись в audit_log', exists (select 1 from public.audit_log where action = 'password_reset_issue'
  and actor = pg_temp.u(1) and details ->> 'student_id' = 't-a3' and details ->> 'user_id' = pg_temp.u(3)::text));
select pg_temp.is('заместитель → студент', pg_temp.issue(2, 't-a3', 'CODE2'), 'ok');
select pg_temp.is('новый код гасит старый: один на пользователя', pg_temp.codes(3)::text, '1');
select pg_temp.ok('остался последний код', exists (select 1 from public.password_resets
  where code_hash = encode(extensions.digest('CODE2', 'sha256'), 'hex')));
select pg_temp.is('староста → заместитель', pg_temp.issue(1, 't-a2'), 'ok');
select pg_temp.is('сисадмин → староста', pg_temp.issue(7, 't-a1'), 'ok');
select pg_temp.is('сисадмин → студент другой группы', pg_temp.issue(7, 't-b2'), 'ok');

-- ===== кто не может =====
select pg_temp.is('заместитель → староста', pg_temp.issue(2, 't-a1'), 'forbidden_target');
select pg_temp.is('староста → себе', pg_temp.issue(1, 't-a1'), 'self');
select pg_temp.is('староста A → студент B', pg_temp.issue(1, 't-b2'), 'forbidden');
select pg_temp.is('студент → студент', pg_temp.issue(3, 't-a2'), 'forbidden');
select pg_temp.is('преподаватель → студент', pg_temp.issue(5, 't-a3'), 'forbidden');
select pg_temp.is('без аккаунта: ожидает подтверждения', pg_temp.issue(1, 't-a4'), 'no_account');
select pg_temp.is('без аккаунта: свободная запись', pg_temp.issue(1, 't-a5'), 'no_account');
select pg_temp.is('нет записи: старосте не подсказываем', pg_temp.issue(1, 't-nope'), 'forbidden');
select pg_temp.is('нет записи: сисадмину — no_student', pg_temp.issue(7, 't-nope'), 'no_student');
select pg_temp.expect_error('кривой хэш → ошибка', $q$select public.password_reset_issue(pg_temp.u(1), 't-a3', 'zz')$q$);
select pg_temp.expect_error('второй открытый код того же пользователя — нельзя',
  $q$insert into public.password_resets (code_hash, user_id) values (repeat('b', 64), pg_temp.u(3))$q$);

insert into public.sysadmins (user_id) values (pg_temp.u(9));
select pg_temp.is('сисадмин → сисадмин', pg_temp.issue(7, 't-b2'), 'forbidden_target');
select pg_temp.is('староста → сисадмин', pg_temp.issue(8, 't-b2'), 'forbidden_target');
-- студент A одновременно в группе B: староста A не выпускает (чужие права), сисадмин — может
insert into public.memberships (user_id, group_id, base_role, status)
  values (pg_temp.u(3), 'bbbbbbbb-0000-4000-8000-00000000000b', 'student', 'active');
select pg_temp.is('староста → студент из двух групп', pg_temp.issue(1, 't-a3'), 'forbidden_target');
select pg_temp.is('сисадмин → студент из двух групп', pg_temp.issue(7, 't-a3'), 'ok');

-- ===== погашение кода (как в password-reset) и каскад при удалении аккаунта =====
update public.password_resets set used_at = now() where user_id = pg_temp.u(3) and used_at is null;
with x as (update public.password_resets set used_at = now() where user_id = pg_temp.u(3) and used_at is null returning 1)
select pg_temp.is('повторное погашение не проходит', (select count(*)::text from x), '0');
create temp table u3 as select pg_temp.u(3) as id, pg_temp.u(1) as h;
delete from auth.users where id = (select id from u3);
select pg_temp.is('удаление аккаунта удаляет его коды',
  (select count(*)::text from public.password_resets where user_id = (select id from u3)), '0');
delete from auth.users where id = (select h from u3);
select pg_temp.ok('удаление выпустившего: created_by → null',
  not exists (select 1 from public.password_resets where created_by = (select h from u3)));
