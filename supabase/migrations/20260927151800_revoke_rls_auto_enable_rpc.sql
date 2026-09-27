-- rls_auto_enable() — служебная функция Supabase (событийный триггер, включает RLS на новых таблицах).
-- Через API её вызывать незачем: отзываем EXECUTE у клиентских ролей, триггер работает как прежде.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
