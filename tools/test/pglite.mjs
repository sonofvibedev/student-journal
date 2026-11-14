// Локальная база без Docker и без тестового проекта: PGlite (Postgres 16 в WASM) + заглушки Supabase (auth, роли API,
// pgcrypto, storage, pg_cron, pg_net, vault). Применяет миграции репозитория по порядку. Только для проверок логики:
// RLS/функции/триггеры настоящие, но Supabase-окружение упрощено (см. STUB). Прод и тест не трогает.
//
// PGlite в package.json нет (его не меняем): поставьте рядом, например
//   npm i --no-save @electric-sql/pglite@0.2.17         — в корне репозитория, или
//   PGLITE_DIR=<папка, где лежит node_modules/@electric-sql/pglite>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPGlite() {
  const dirs = [process.env.PGLITE_DIR, process.cwd()].filter(Boolean);
  for (const d of dirs) {
    const p = join(resolve(d), 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
    if (existsSync(p)) return (await import(pathToFileURL(p).href)).PGlite;
  }
  try { return (await import('@electric-sql/pglite')).PGlite; } catch (_) { return null; }
}

export const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
create schema auth; create schema extensions; create schema storage; create schema cron; create schema net; create schema vault;
grant usage on schema auth, extensions to anon, authenticated, service_role;
-- как в Supabase: новые объекты public по умолчанию доступны ролям API (миграции потом сами делают revoke)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role' $$;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create function extensions.gen_random_bytes(int) returns bytea language sql volatile as
  $$ select decode(substr(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 1, $1 * 2), 'hex') $$;
create function extensions.digest(text, text) returns bytea language sql immutable as $$ select decode(md5($1) || md5($1), 'hex') $$;
create function extensions.digest(bytea, text) returns bytea language sql immutable as $$ select decode(md5($1) || md5($1), 'hex') $$;
grant execute on all functions in schema extensions to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
create table cron.job_run_details (runid serial primary key, jobid int, status text, start_time timestamptz);
create function cron.schedule(text, text, text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values ($1, $2, $3) returning jobid $$;
create function cron.unschedule(text) returns boolean language sql as $$ delete from cron.job where jobname = $1 returning true $$;
create table net._http_response (id bigserial primary key, status_code int, created timestamptz default now());
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 1000) returns bigint language sql as $$ select 1::bigint $$;
create table vault.secrets (name text, secret text);
create function public.rls_auto_enable() returns void language sql as $$ select $$;
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(text, text) returns uuid language sql as $$ insert into vault.secrets values ($2, $1) returning gen_random_uuid() $$;
`;

// pg_cron / pg_net в PGlite нет: «create extension» вырезаем; BOM в начале файла — тоже
const prep = (sql) => sql.replace(/^﻿/, '').replace(/^\s*create extension[^;]*;/gim, '-- (extension skipped)');

export const MIGRATIONS = (repo) => readdirSync(join(repo, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
export async function applyFile(db, path) {
  try { await db.exec('set check_function_bodies = off;\n' + prep(readFileSync(path, 'utf8')) + '\nset check_function_bodies = on;'); }
  catch (e) { throw new Error(`${path}: ${e.message}`); }
}

// Новая база с миграциями: все или только раньше версии before ('20261122100000')
export async function boot(repo = '.', { before = null } = {}) {
  const PGlite = await loadPGlite();
  if (!PGlite) return null;
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of MIGRATIONS(repo).filter((x) => !before || x < before)) await applyFile(db, join(repo, 'supabase', 'migrations', f));
  return db;
}
