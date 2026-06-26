#!/usr/bin/env bash
# Full local benchmark harness: seed bulk data, boot the API with the store rate limit raised, run
# the autocannon suite, tear the API down. The CALLER provides running Postgres/Redis/Meilisearch
# and the connection env (DATABASE_URL, REDIS_URL, MEILISEARCH_URL, MEILI_MASTER_KEY, MASTER_KEY,
# JWT_SECRET). Locally: `docker compose -f docker-compose.dev.yml up -d` first. CI sets up service
# containers + env, then calls this.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DATABASE_URL:?set DATABASE_URL}"
export STORE_RATE_LIMIT="${STORE_RATE_LIMIT:-1000000}"   # raise ONLY the public-catalog limit for load
export STORE_RATE_WINDOW_SECONDS="${STORE_RATE_WINDOW_SECONDS:-60}"
export API_PORT="${API_PORT:-3000}"
export BENCH_BASE_URL="${BENCH_BASE_URL:-http://localhost:${API_PORT}}"
# Local file storage in a writable temp dir so the /health storage probe passes (benchmarks don't
# exercise uploads). Override by exporting STORAGE_DRIVER / LOCAL_STORAGE_PATH before calling.
export STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
export LOCAL_STORAGE_PATH="${LOCAL_STORAGE_PATH:-$(mktemp -d)}"

echo "→ migrate + seed"
pnpm --filter @sovecom/api migrate:up
pnpm --filter @sovecom/api seed

echo "→ bulk bench seed (50 categories, 1000 products)"
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/benchmarks/seed-bench.sql
else
  # Fallback: pipe through the compose Postgres container's psql.
  docker compose -f docker-compose.dev.yml exec -T postgres \
    psql -U sovecom -d "${POSTGRES_DB:-sovecom}" -v ON_ERROR_STOP=1 < scripts/benchmarks/seed-bench.sql
fi

echo "→ build + start API (STORE_RATE_LIMIT=$STORE_RATE_LIMIT)"
pnpm --filter @sovecom/api build
node --enable-source-maps apps/api/dist/main &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT

echo "→ wait for /health"
for i in $(seq 1 30); do
  if curl -fsS "$BENCH_BASE_URL/health" >/dev/null 2>&1; then echo "  API up"; break; fi
  sleep 2
  [ "$i" = 30 ] && { echo "API never became healthy"; exit 1; }
done

echo "→ run benchmarks"
node scripts/benchmarks/run.mjs
