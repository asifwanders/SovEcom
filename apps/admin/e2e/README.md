# Admin E2E

Browser end-to-end tests for the admin SPA, using Playwright. The admin calls the API from the
browser, so a run needs the **API running + seeded** and the admin **served with the API base baked
in**, with CORS allowing the admin origin.

## Run locally

```bash
# 1. infra
docker compose -f docker-compose.dev.yml up -d

# 2. env
export DATABASE_URL=postgres://sovecom:devpassword@localhost:5432/sovecom_dev
export REDIS_URL=redis://localhost:6379
export MEILISEARCH_URL=http://localhost:7700 MEILI_MASTER_KEY=devkey
export MASTER_KEY=$(node -e "console.log(Buffer.alloc(32,0x2a).toString('base64'))")
export JWT_SECRET=$(openssl rand -hex 24)
export STORAGE_DRIVER=local LOCAL_STORAGE_PATH=$(mktemp -d)
export ADMIN_ORIGIN=http://localhost:4173        # let CORS allow the preview origin
export SEED_E2E_FIXTURE=1                          # admin@default.local gets a real password + installed=true

# 3. migrate + seed (one-time per DB)
pnpm --filter @sovecom/api migrate:up && pnpm --filter @sovecom/api seed

# 4. start the API
node --enable-source-maps apps/api/dist/main &     # after `pnpm --filter @sovecom/api build`

# 5. run the admin E2E (builds + previews the admin via Playwright's webServer)
pnpm --filter @sovecom/admin exec playwright install chromium   # once
VITE_API_BASE_URL=http://localhost:3000 pnpm --filter @sovecom/admin test:e2e
```

Login is `admin@default.local` / `E2e-Admin-2026` (see `fixtures.ts`, mirrored in the API seed).

> The local DB must have exactly ONE tenant. A DB polluted by repeated seeds across versions can leave
> the admin user on a different `tenant_id` than `default_tenant_id` → login 401. Drop + recreate the
> dev DB if that happens (CI always starts fresh, so it never hits this).

## Debug failures

- `pnpm --filter @sovecom/admin test:e2e:ui` — Playwright UI mode (step through, time-travel).
- On failure the runner writes a screenshot + (on retry) a trace under `apps/admin/test-results/`;
  open a trace with `pnpm --filter @sovecom/admin exec playwright show-trace <trace.zip>`.
- `error-context.md` next to each failure has the accessibility snapshot of the page at the moment of
  failure — the fastest way to see what the page actually showed.

## Notes

- Navigate via the sidebar (client-side routing) in specs, NOT `page.goto` after login — a full reload
  drops the in-memory token in this cross-origin harness.
- In CI the `admin-e2e` job sets `E2E_SKIP_WEBSERVER=1` and starts everything itself.
