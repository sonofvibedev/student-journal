#!/usr/bin/env bash
# Применяет миграции репозитория к ТЕСТОВОМУ проекту (TEST_PROJECT_REF из .env.test).
# Папка supabase/ в репозитории привязана к проду, поэтому отсюда `supabase db push` не запускаем:
# собираем временную папку, привязанную к тесту, и пушим из неё.
# В копии миграций прод-ref заменяется на тестовый (адреса в cron-задачах), исходники не меняются.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env.test; set +a
node -e "import('./tools/test/guard.mjs').then(m=>m.assertTestTarget(process.env.TEST_PROJECT_REF))"
PROD=woiqekpuoddxixlrbvkp
W=$(mktemp -d)
mkdir -p "$W/supabase/migrations"
(cd "$W" && npx --yes supabase@latest init --force >/dev/null 2>&1 || true)
for f in supabase/migrations/*.sql; do sed "s/$PROD/$TEST_PROJECT_REF/g" "$f" > "$W/supabase/migrations/$(basename "$f")"; done
# rls_auto_enable() есть не в каждом проекте (в проде есть, в новом тестовом нет)
cat > "$W/supabase/migrations/20260927151800_revoke_rls_auto_enable_rpc.sql" <<'SQL'
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
SQL
if grep -rq "$PROD" "$W/supabase/migrations"; then echo "СТОП: в копии миграций остался прод-ref"; exit 2; fi
cd "$W"
npx --yes supabase@latest link --project-ref "$TEST_PROJECT_REF" >/dev/null
[ "$(cat supabase/.temp/project-ref)" = "$TEST_PROJECT_REF" ] || { echo "СТОП: привязка не на тест"; exit 2; }
npx --yes supabase@latest db push --linked --yes
