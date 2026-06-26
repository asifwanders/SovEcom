# Setup E2E — scenario: fresh install + wizard completion

Browser end-to-end test for the **setup wizard** SPA, using Playwright. It drives the real wizard
through all 11 steps against a real, **fresh-install** API and asserts the store ends up
`installed=true`. This is the hardest 3.14 scenario because it needs three things the other specs
don't:

1. **A fresh-install DB** — `system_state.installed=false` (the wizard only shows when not installed).
   Seed WITHOUT `SEED_E2E_FIXTURE` (that fixture marks the store installed).
2. **The one-time setup token** — `SetupBootService` mints it at boot on a not-installed system and
   prints it in the stdout banner (its _only_ plaintext emission — only its SHA-256 hash is stored, so
   it can't be read from the DB). The harness greps it out of the API log into `SETUP_TOKEN_PLAINTEXT`.
3. **The admin-account OTP** — the Admin step emails a 6-digit code (never logged/returned). The Email
   step is pointed at **MailHog** (the dev mail sink the wizard's EmailStep even references), and the
   spec reads the code back over MailHog's HTTP API.

The SPA calls the API from the browser. To avoid a core CORS change (CORS only allows the admin/store
origins, never the setup origin), the SPA is built with `VITE_API_BASE_URL=""` so it hits
`/setup/v1/*` + `/health` **relative**, and `vite preview`'s proxy forwards those **same-origin** to
the API (see `apps/setup/vite.config.ts` → `preview.proxy`).

## Fresh-DB-per-run

Completing the wizard flips `installed=true`, so **every run needs a freshly-reset DB**. Re-running on
an already-installed DB shows the "already set up" screen, not the wizard (the spec's pre-check fails
fast with a clear message). CI starts each run from an empty DB; locally, re-run the reset block below.

## Run locally

```bash
# 1. infra + a mail sink (MailHog: SMTP :1025, HTTP API :8025)
docker compose -f docker-compose.dev.yml up -d
docker run -d --name sovecom-setup-e2e-mailhog -p 1025:1025 -p 8025:8025 mailhog/mailhog:v1.0.0

# 2. RESET to a fresh-install DB (drop+recreate, baseline seed WITHOUT the e2e fixture)
docker compose -f docker-compose.dev.yml exec -T postgres psql -U sovecom -d postgres \
  -c "DROP DATABASE IF EXISTS sovecom_dev WITH (FORCE);" -c "CREATE DATABASE sovecom_dev OWNER sovecom;"
docker compose -f docker-compose.dev.yml exec -T redis redis-cli FLUSHALL
export DATABASE_URL=postgres://sovecom:devpassword@localhost:5432/sovecom_dev
export REDIS_URL=redis://localhost:6379
export MEILISEARCH_URL=http://localhost:7700 MEILI_MASTER_KEY=devkey
pnpm --filter @sovecom/api migrate:up && pnpm --filter @sovecom/api seed   # NO SEED_E2E_FIXTURE

# 3. start the API (development NODE_ENV → boot banner mints + prints the token).
#    SMTP_HOST/PORT point env-mail at MailHog too (belt-and-braces precondition).
export MASTER_KEY=$(node -e "console.log(Buffer.alloc(32,0x2a).toString('base64'))")
export JWT_SECRET=$(openssl rand -hex 24)
export STORAGE_DRIVER=local LOCAL_STORAGE_PATH=$(mktemp -d)
export SMTP_HOST=localhost SMTP_PORT=1025 MAIL_FROM=setup@sovecom.local
pnpm --filter @sovecom/api build
node --enable-source-maps apps/api/dist/main > /tmp/setup-api.log 2>&1 &

# 4. read the minted token out of the banner
export SETUP_TOKEN_PLAINTEXT=$(grep -A3 "Enter this one-time setup token" /tmp/setup-api.log \
  | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E '^[[:space:]]+[A-Za-z0-9_-]{20,}[[:space:]]*$' \
  | head -1 | tr -d '[:space:]')

# 5. run the setup E2E (Playwright builds + previews the SPA with VITE_API_BASE_URL="")
export MAILHOG_API_URL=http://localhost:8025
pnpm --filter @sovecom/setup exec playwright install chromium   # once
pnpm --filter @sovecom/setup test:e2e
```

## Notes

- The happy-path inputs mirror `apps/setup/src/full-flow.spec.tsx` (the mocked vitest). The UI step
  order is Welcome → Brand → Database → Email → Payments → Tax → Compliance → Theme → Modules → Admin
  → Done (`src/wizard/steps.ts`).
- The Email step uses **Custom SMTP** (host `localhost`, port `1025`) so the admin OTP is sent to
  MailHog. Using Brevo (the default) would persist an unreachable relay and the OTP send would fail.
- The final "Finish setup" redirects to `/admin`, which doesn't exist on the preview origin — the spec
  doesn't depend on that page; it asserts `GET /setup/v1/status` → `installed:true` (reads
  `system_state.installed`).
- In CI the `setup-e2e` job sets `E2E_SKIP_WEBSERVER=1` and starts everything itself (and is the
  place the fresh DB is guaranteed).
