-- Аватарки студентов: приватный бакет avatars, путь <user_id>.jpg (256×256 JPEG, до 1 МБ).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Читать — только вошедшим пользователям
create policy "Аватарки видят вошедшие" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

-- Загружать, заменять и удалять — только своё фото <user_id>.jpg
create policy "Своя аватарка: загрузка" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.jpg');

create policy "Своя аватарка: замена" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.jpg')
  with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '.jpg');

create policy "Своя аватарка: удаление" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and name = (select auth.uid())::text || '.jpg');
