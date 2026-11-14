-- Журнал 2.1, п.12: чат «староста/заместитель ↔ преподаватель» без «пароля переписки». Сквозное шифрование остаётся.
-- Протокол, модель угроз и компромиссы: docs/v21-chat-keys.md. Откат: supabase/migrations_down/20261122100000_journal21_chat_devices.down.sql.
--
-- Каждое устройство (браузер) участника само создаёт пару ECDH P-256 при первом открытии чата; в базе — только открытый ключ.
-- Ключ треда — случайный AES-GCM-256 «эпохи». В базе он лежит только обёрнутым под каждое устройство обоих участников
-- (ECDH устройства, которое обернуло, и устройства-получателя → HKDF → AES-GCM). Сервер не видит ни ключей тредов, ни текста.
-- Новое устройство получает ключи от уже работающего устройства ТОГО ЖЕ аккаунта (когда то откроет чат). Потеряны все
-- устройства — «начать заново»: прежние отзываются, тред получает новую эпоху, старая переписка на новом устройстве не читается.
--
-- Прежняя схема (chat_keys, chat_keys_publish, chat_peer_key, chat_send) остаётся как есть: в проде на 14.11.2026 в ней
-- 0 тредов и 0 сообщений (1 строка chat_keys). Новый клиент её не использует; удалить — отдельной миграцией после 2.1.

-- ===================================================================================================
-- 1. Таблицы
-- ===================================================================================================

-- Устройства: открытый ключ (только kty, crv, x, y). Не удаляются (нужны, чтобы проверить старые обёртки), только отзываются.
create table public.chat_devices (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  public_jwk jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index chat_devices_user_idx on public.chat_devices (user_id);
create unique index chat_devices_key_uq on public.chat_devices ((public_jwk ->> 'x'), (public_jwk ->> 'y'));

-- Текущая эпоха ключа треда (null — ключа ещё нет)
alter table public.chat_threads add column key_epoch int check (key_epoch >= 1);

-- Обёрнутый ключ эпохи для одного устройства. ct — 32 байта ключа + 16 байт тега = 64 знака base64url.
create table public.chat_thread_keys (
  thread_id         uuid not null references public.chat_threads (id) on delete cascade,
  epoch             int not null check (epoch >= 1),
  device_id         uuid not null references public.chat_devices (id) on delete cascade,
  wrapper_device_id uuid not null references public.chat_devices (id) on delete cascade,
  iv                text not null check (iv ~ '^[A-Za-z0-9_-]{16}$'),
  ct                text not null check (ct ~ '^[A-Za-z0-9_-]{64}$'),
  created_at        timestamptz not null default now(),
  primary key (thread_id, epoch, device_id)
);
create index chat_thread_keys_device_idx on public.chat_thread_keys (device_id);

-- Сообщения новой схемы: эпоха и устройство отправителя вместо версий ключей
alter table public.chat_messages
  alter column sender_key_version drop not null,
  alter column recipient_key_version drop not null,
  add column key_epoch int check (key_epoch >= 1),
  add column sender_device uuid references public.chat_devices (id) on delete cascade,
  add constraint chat_messages_scheme_chk check ((sender_key_version is not null and recipient_key_version is not null)
                                                 or (key_epoch is not null and sender_device is not null));

-- Новые таблицы закрыты от клиентов целиком: читать и писать — только через RPC ниже (они проверяют участника треда)
do $$
declare t text;
begin
  foreach t in array array['chat_devices', 'chat_thread_keys'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format(
      'create policy "Техработы" on public.%I as restrictive for all to anon, authenticated using ((select public.app_open())) with check ((select public.app_open()))',
      t);
  end loop;
end $$;

-- ===================================================================================================
-- 2. Хелперы (клиентам закрыты)
-- ===================================================================================================

-- Нужна новая эпоха: ключа ещё нет; среди получателей текущей эпохи есть отозванное устройство; у кого-то из участников
-- не осталось ни одного действующего устройства с ключом текущей эпохи (потерял все и начал заново).
create function public._chat_epoch_stale(p_thread uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select t.key_epoch is null
      or exists (select 1 from public.chat_thread_keys k join public.chat_devices d on d.id = k.device_id
                  where k.thread_id = t.id and k.epoch = t.key_epoch and d.revoked_at is not null)
      or exists (select 1 from unnest(array[t.student_user_id, t.teacher_user_id]) u(id)
                  where not exists (select 1 from public.chat_thread_keys k join public.chat_devices d on d.id = k.device_id
                                     where k.thread_id = t.id and k.epoch = t.key_epoch
                                       and d.user_id = u.id and d.revoked_at is null))
    from public.chat_threads t where t.id = p_thread;
$$;

-- Устройство вызывающего и действующее; иначе forbidden / device_revoked
create function public._chat_my_device(p_device uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare d public.chat_devices;
begin
  select * into d from public.chat_devices where id = p_device;
  if not found or d.user_id is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  if d.revoked_at is not null then raise exception 'device_revoked' using errcode = 'P0001'; end if;
end;
$$;

-- Живой тред вызывающего (как в chat_send); иначе forbidden
create function public._chat_my_thread(p_thread uuid)
returns public.chat_threads language plpgsql stable security definer set search_path = '' as $$
declare t public.chat_threads;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  select * into t from public.chat_threads where id = p_thread and id in (select public.chat_my_thread_ids());
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  return t;
end;
$$;

-- ===================================================================================================
-- 3. RPC (security definer, search_path = ''; ошибки — raise exception '<код>')
-- ===================================================================================================

-- Зарегистрировать устройство. Тот же открытый ключ → то же устройство (повтор безопасен); revoked = true — устройство
-- отозвано «начать заново» с другого устройства, клиенту нужна новая пара. Заводят только возможные участники чата.
create function public.chat_device_register(p_public_jwk jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_pub jsonb;
  d public.chat_devices;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = v_uid and m.status = 'active'
                    and (m.extra_role in ('headman', 'deputy') or m.base_role in ('teacher_lecture', 'teacher_practice'))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_public_jwk) is distinct from 'object' or p_public_jwk ? 'd'
     or p_public_jwk ->> 'kty' is distinct from 'EC' or p_public_jwk ->> 'crv' is distinct from 'P-256'
     or coalesce(p_public_jwk ->> 'x', '') !~ '^[A-Za-z0-9_-]{43}$'
     or coalesce(p_public_jwk ->> 'y', '') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  v_pub := jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', p_public_jwk ->> 'x', 'y', p_public_jwk ->> 'y');
  perform pg_advisory_xact_lock(hashtextextended('chat_dev:' || v_uid::text, 0));
  select * into d from public.chat_devices x where x.public_jwk ->> 'x' = v_pub ->> 'x' and x.public_jwk ->> 'y' = v_pub ->> 'y';
  if found then
    if d.user_id <> v_uid then raise exception 'bad_key' using errcode = '22023'; end if;
    return jsonb_build_object('device_id', d.id, 'revoked', d.revoked_at is not null);
  end if;
  -- ponytail: устройство без IndexedDB (приватный режим) регистрируется заново при каждом открытии; потолок 10 действующих
  -- и 50 всего на человека, дальше — «начать заново» (отзывает остальные). Чистить старые автоматически, если начнут упираться.
  if (select count(*) from public.chat_devices x where x.user_id = v_uid and x.revoked_at is null) >= 10
     or (select count(*) from public.chat_devices x where x.user_id = v_uid) >= 50 then
    raise exception 'too_many_devices' using errcode = 'P0001';
  end if;
  insert into public.chat_devices (user_id, public_jwk) values (v_uid, v_pub) returning * into d;
  insert into public.audit_log (actor, group_id, action, details)
    values (v_uid, null, 'chat_device_add', jsonb_build_object('device_id', d.id));
  return jsonb_build_object('device_id', d.id, 'revoked', false);
end;
$$;

-- «Начать заново на этом устройстве»: отозвать все остальные свои устройства. Треды, где они были получателями текущей
-- эпохи, становятся «устаревшими» (_chat_epoch_stale): первый открывший участник создаст новую эпоху.
create function public.chat_device_reset(p_device uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  n int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not public.app_open() then raise exception 'maintenance' using errcode = '42501'; end if;
  perform public._chat_my_device(p_device);
  update public.chat_devices d set revoked_at = now() where d.user_id = v_uid and d.id <> p_device and d.revoked_at is null;
  get diagnostics n = row_count;
  insert into public.audit_log (actor, group_id, action, details)
    values (v_uid, null, 'chat_device_reset', jsonb_build_object('device_id', p_device, 'revoked', n));
  return n;
end;
$$;

-- Состояние ключей треда для своего устройства: эпоха, нужна ли новая, устройства обоих участников (действующие и те
-- отозванные, что участвовали в треде; у каждого — эпохи, ключи которых у него есть), обёртки для p_device.
create function public.chat_thread_state(p_thread uuid, p_device uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  v_peer uuid;
begin
  t := public._chat_my_thread(p_thread);
  perform public._chat_my_device(p_device);
  v_peer := case when t.student_user_id = v_uid then t.teacher_user_id else t.student_user_id end;
  return jsonb_build_object(
    'me', v_uid, 'peer', v_peer, 'epoch', t.key_epoch, 'stale', public._chat_epoch_stale(t.id),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'user_id', d.user_id, 'public_jwk', d.public_jwk,
                                          'revoked', d.revoked_at is not null,
                                          'epochs', coalesce((select jsonb_agg(k.epoch order by k.epoch) from public.chat_thread_keys k
                                                               where k.thread_id = t.id and k.device_id = d.id), '[]'::jsonb))
                       order by d.created_at, d.id)
        from public.chat_devices d
       where d.user_id in (v_uid, v_peer)
         and (d.revoked_at is null
              or exists (select 1 from public.chat_thread_keys k
                          where k.thread_id = t.id and (k.device_id = d.id or k.wrapper_device_id = d.id)))), '[]'::jsonb),
    'wraps', coalesce((
      select jsonb_agg(jsonb_build_object('epoch', k.epoch, 'wrapper', k.wrapper_device_id, 'iv', k.iv, 'ct', k.ct) order by k.epoch)
        from public.chat_thread_keys k where k.thread_id = t.id and k.device_id = p_device), '[]'::jsonb));
end;
$$;

-- Новая эпоха: только когда текущая устарела (или её нет); p_epoch = текущая + 1 (иначе epoch_conflict — кто-то успел
-- раньше). p_wraps = [{device_id, iv, ct}] ровно для всех действующих устройств обоих участников (иначе devices_changed).
create function public.chat_epoch_create(p_thread uuid, p_device uuid, p_epoch int, p_wraps jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  v_peer uuid;
begin
  t := public._chat_my_thread(p_thread);
  perform public._chat_my_device(p_device);
  select * into t from public.chat_threads where id = t.id for update;            -- две стороны одновременно: вторая ждёт
  if p_epoch is distinct from coalesce(t.key_epoch, 0) + 1 or not public._chat_epoch_stale(t.id) then
    raise exception 'epoch_conflict' using errcode = 'P0001';
  end if;
  v_peer := case when t.student_user_id = v_uid then t.teacher_user_id else t.student_user_id end;
  if not exists (select 1 from public.chat_devices d where d.user_id = v_peer and d.revoked_at is null) then
    raise exception 'no_peer_device' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_wraps) is distinct from 'array' or jsonb_array_length(p_wraps) not between 1 and 40
     or exists (select 1 from jsonb_array_elements(p_wraps) x
                 where jsonb_typeof(x) is distinct from 'object'
                    or coalesce(x ->> 'device_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or coalesce(x ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$' or coalesce(x ->> 'ct', '') !~ '^[A-Za-z0-9_-]{64}$') then
    raise exception 'bad_message' using errcode = '22023';
  end if;
  if (select count(distinct x ->> 'device_id') from jsonb_array_elements(p_wraps) x) <> jsonb_array_length(p_wraps)
     or exists (select (x ->> 'device_id')::uuid from jsonb_array_elements(p_wraps) x
                except select d.id from public.chat_devices d where d.user_id in (v_uid, v_peer) and d.revoked_at is null)
     or exists (select d.id from public.chat_devices d where d.user_id in (v_uid, v_peer) and d.revoked_at is null
                except select (x ->> 'device_id')::uuid from jsonb_array_elements(p_wraps) x) then
    raise exception 'devices_changed' using errcode = 'P0001';
  end if;
  insert into public.chat_thread_keys (thread_id, epoch, device_id, wrapper_device_id, iv, ct)
    select t.id, p_epoch, (x ->> 'device_id')::uuid, p_device, x ->> 'iv', x ->> 'ct' from jsonb_array_elements(p_wraps) x;
  update public.chat_threads set key_epoch = p_epoch where id = t.id;
  return p_epoch;
end;
$$;

-- Выдать ключи эпох своим другим устройствам: [{device_id, epoch, iv, ct}]. Только своему действующему устройству и только
-- эпохи, ключ которых есть у p_device (подтверждение нового устройства тем же аккаунтом). Уже выданные пропускаются.
create function public.chat_wraps_add(p_thread uuid, p_device uuid, p_wraps jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  n int;
begin
  t := public._chat_my_thread(p_thread);
  perform public._chat_my_device(p_device);
  if jsonb_typeof(p_wraps) is distinct from 'array' or jsonb_array_length(p_wraps) not between 1 and 200
     or exists (select 1 from jsonb_array_elements(p_wraps) x
                 where jsonb_typeof(x) is distinct from 'object'
                    or coalesce(x ->> 'device_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or coalesce(x ->> 'epoch', '') !~ '^[0-9]{1,6}$'
                    or coalesce(x ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$' or coalesce(x ->> 'ct', '') !~ '^[A-Za-z0-9_-]{64}$') then
    raise exception 'bad_message' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_wraps) x
              where (x ->> 'device_id')::uuid = p_device
                 or not exists (select 1 from public.chat_devices d
                                 where d.id = (x ->> 'device_id')::uuid and d.user_id = v_uid and d.revoked_at is null)
                 or not exists (select 1 from public.chat_thread_keys k
                                 where k.thread_id = t.id and k.epoch = (x ->> 'epoch')::int and k.device_id = p_device)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.chat_thread_keys (thread_id, epoch, device_id, wrapper_device_id, iv, ct)
    select t.id, (x ->> 'epoch')::int, (x ->> 'device_id')::uuid, p_device, x ->> 'iv', x ->> 'ct' from jsonb_array_elements(p_wraps) x
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Отправка шифртекста новой схемы. Эпоха — текущая и не устаревшая, у p_device есть её ключ (иначе key_changed: клиент
-- перечитывает chat_thread_state). Лимит, размер и уведомление — как в chat_send.
create function public.chat_post(p_thread uuid, p_device uuid, p_epoch int, p_iv text, p_ciphertext text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.chat_threads;
  v_peer uuid;
  v_id uuid;
  v_sig text;
begin
  t := public._chat_my_thread(p_thread);
  if not public.group_open(t.group_id) then raise exception 'group_closed' using errcode = '42501'; end if;
  perform public._chat_my_device(p_device);
  if length(p_ciphertext) > 10923 then raise exception 'too_long' using errcode = '22001'; end if;   -- > 8192 байт
  if p_iv is null or p_iv !~ '^[A-Za-z0-9_-]{16}$' or not public._chat_b64u_ok(p_ciphertext, 22, 10923) then
    raise exception 'bad_message' using errcode = '22023';
  end if;
  select * into t from public.chat_threads where id = t.id for share;              -- новая эпоха не «проскочит» между проверкой и вставкой
  if p_epoch is distinct from t.key_epoch or public._chat_epoch_stale(t.id)
     or not exists (select 1 from public.chat_thread_keys k where k.thread_id = t.id and k.epoch = p_epoch and k.device_id = p_device) then
    raise exception 'key_changed' using errcode = 'P0001';
  end if;
  v_peer := case when t.student_user_id = v_uid then t.teacher_user_id else t.student_user_id end;
  perform pg_advisory_xact_lock(hashtextextended('chat_send:' || v_uid::text, 0));   -- лимит без гонки (общий с chat_send)
  if (select count(*) from public.chat_messages m
       where m.sender_id = v_uid and m.created_at > now() - interval '1 minute') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.chat_messages (thread_id, sender_id, key_epoch, sender_device, iv, ciphertext)
    values (t.id, v_uid, p_epoch, p_device, p_iv, p_ciphertext)
  returning id into v_id;

  if v_uid = t.student_user_id then
    select case m.extra_role when 'headman' then 'Староста ' else 'Зам. старосты ' end || g.name into v_sig
      from public.memberships m join public.groups g on g.id = m.group_id
     where m.user_id = v_uid and m.group_id = t.group_id;
  else
    v_sig := 'Преподаватель';
  end if;
  insert into public.notifications (user_id, group_id, kind, title, body, ref, dedupe_key)
    values (v_peer, t.group_id, 'chat', 'Новое сообщение в чате', v_sig, jsonb_build_object('thread_id', t.id),
            'chat:' || t.id || ':' || v_peer || ':' || floor(extract(epoch from now()) / 300)::bigint)
  on conflict (user_id, dedupe_key) do nothing;
  return v_id;
end;
$$;

-- ===================================================================================================
-- 4. Права на функции
-- ===================================================================================================
do $$
declare f text;
begin
  foreach f in array array['_chat_epoch_stale(uuid)', '_chat_my_device(uuid)', '_chat_my_thread(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['chat_device_register(jsonb)', 'chat_device_reset(uuid)', 'chat_thread_state(uuid, uuid)',
                           'chat_epoch_create(uuid, uuid, int, jsonb)', 'chat_wraps_add(uuid, uuid, jsonb)',
                           'chat_post(uuid, uuid, int, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
