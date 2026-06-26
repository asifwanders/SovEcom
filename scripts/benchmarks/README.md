# Performance benchmarks

CI-gated latency benchmarks for the public store API, using [autocannon](https://github.com/mcollina/autocannon). The suite **fails the build** when a scenario exceeds its threshold.

## Scenarios

| Scenario        | Endpoint                       | Threshold (p97.5) |
| --------------- | ------------------------------ | ----------------- |
| Catalog browse  | `GET /store/v1/products`       | ≤ 200ms           |
| Product detail  | `GET /store/v1/products/:slug` | ≤ 150ms           |
| Categories list | `GET /store/v1/categories`     | ≤ 200ms           |
| Cart create     | `POST /store/v1/carts`         | ≤ 100ms           |

We gate on **p97.5** — the percentile autocannon exposes that is closest to (and stricter than) p95. In CI a **20% margin** is added (set `CI=true`) to absorb runner variance.

Concurrency/oversell ("100 buying the last item → exactly 1 order, stock 0") and stateful checkout correctness are covered by integration tests — `apps/api/test/integration/inventory/inventory.int-spec.ts` and the orders int-specs — not duplicated here. Stateful add-item and checkout-submit _load_ benchmarks are a documented gap.

## Run it locally

```bash
# 1. infra
docker compose -f docker-compose.dev.yml up -d

# 2. env (match your compose creds)
export DATABASE_URL=postgres://sovecom:changeme@localhost:5432/sovecom
export REDIS_URL=redis://localhost:6379
export MEILISEARCH_URL=http://localhost:7700
export MEILI_MASTER_KEY=changeme
export MASTER_KEY=$(openssl rand -hex 32)
export JWT_SECRET=$(openssl rand -hex 32)

# 3. full harness: seed + boot API (rate limit raised) + run
pnpm bench:full
```

Already have a seeded API running? Point the runner at it directly:

```bash
BENCH_BASE_URL=http://localhost:3000 pnpm bench
```

> The store endpoints rate-limit at 120/min per IP. The harness raises **only** that limit via
> `STORE_RATE_LIMIT` (auth limits are untouched). Don't set `STORE_RATE_LIMIT` in production.

> Benchmarks run the API in dev mode (no `NODE_ENV=production`), so numbers reflect dev-mode
> behaviour; thresholds are calibrated against that, so the gate is internally consistent.

## Verify the gate works

The pure pass/fail logic is unit-tested: `node --test scripts/benchmarks/*.test.mjs`. To see a real
regression fail the build, add an artificial delay to a store query (or lower a threshold in
`scenarios.mjs`) and re-run `pnpm bench` — it exits non-zero.

## CI

The `benchmark` job in `.github/workflows/ci.yml` stands up services, seeds, runs `pnpm bench`
(`CI=true` → +20% margin), and posts the results table (`bench-results.md`) as a PR comment.
**Note:** GitHub Actions is currently billing-blocked for this repo, so the job is wired but
unexecuted — validate locally until Actions billing is restored.
