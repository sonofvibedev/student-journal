-- Откат 2.1 п.12: чат возвращается к схеме этапа 4 (chat_keys и «пароль переписки»). Устройства, обёрнутые ключи тредов
-- и сообщения новой схемы удаляются: прежний клиент их всё равно не прочитает. Треды, отметки прочтения, chat_keys
-- и сообщения прежней схемы не трогаются. Записи audit_log (chat_device_add / chat_device_reset) остаются как след.
drop function if exists public.chat_post(uuid, uuid, int, text, text);
drop function if exists public.chat_wraps_add(uuid, uuid, jsonb);
drop function if exists public.chat_epoch_create(uuid, uuid, int, jsonb);
drop function if exists public.chat_thread_state(uuid, uuid);
drop function if exists public.chat_device_reset(uuid);
drop function if exists public.chat_device_register(jsonb);
drop function if exists public._chat_my_thread(uuid);
drop function if exists public._chat_my_device(uuid);
drop function if exists public._chat_epoch_stale(uuid);

delete from public.chat_messages where key_epoch is not null;
alter table public.chat_messages
  drop constraint if exists chat_messages_scheme_chk,
  drop column if exists sender_device,
  drop column if exists key_epoch,
  alter column sender_key_version set not null,
  alter column recipient_key_version set not null;
drop table if exists public.chat_thread_keys;
drop table if exists public.chat_devices;
alter table public.chat_threads drop column if exists key_epoch;
