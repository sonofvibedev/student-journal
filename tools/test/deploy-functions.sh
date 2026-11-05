#!/usr/bin/env bash
# Выкладывает Edge Functions «Журнала 2.0» в ТЕСТОВЫЙ проект (TEST_PROJECT_REF из .env.test).
# Папка supabase/ в репозитории привязана к проду, поэтому деплоим из временной папки, привязанной к тесту.
# Без Docker: --use-api собирает функцию на стороне Supabase. JWT у функций выключен (они сами проверяют токен):
# публичный ключ sb_publishable_… не JWT, а клиенту нужны вызовы без входа (join-group, registration-start).
# Использование: bash tools/test/deploy-functions.sh [имя ...]   (без аргументов — все функции этапа 1)
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env.test; set +a
node -e "import('./tools/test/guard.mjs').then(m=>m.assertTestTarget(process.env.TEST_PROJECT_REF))"
FUNCS=("$@")
[ ${#FUNCS[@]} -eq 0 ] && FUNCS=(join-group registration-start schedule-lookup notify-registration)
W=$(mktemp -d)
mkdir -p "$W/supabase/functions"
(cd "$W" && npx --yes supabase@latest init --force >/dev/null 2>&1 || true)
cp -r supabase/functions/_shared "$W/supabase/functions/_shared"
for f in "${FUNCS[@]}"; do cp -r "supabase/functions/$f" "$W/supabase/functions/$f"; done
cd "$W"
npx --yes supabase@latest link --project-ref "$TEST_PROJECT_REF" >/dev/null
[ "$(cat supabase/.temp/project-ref)" = "$TEST_PROJECT_REF" ] || { echo "СТОП: привязка не на тест"; exit 2; }
for f in "${FUNCS[@]}"; do
  npx --yes supabase@latest functions deploy "$f" --project-ref "$TEST_PROJECT_REF" --use-api --no-verify-jwt --yes
done
