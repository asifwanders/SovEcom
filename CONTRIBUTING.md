# Contributing to SovEcom

Thank you for your interest in SovEcom. This guide covers how to ask questions, report bugs, propose features, and submit changes to a real, working codebase.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). Report unacceptable behavior to `conduct@sovecom.io`.

## Contributor License Agreement (CLA) — required

**Every external contributor must sign the SovEcom CLA before any pull request can be merged.**

- Signing is automatic on your first PR: a bot (cla-assistant.io) comments with a link.
- An **Individual CLA** covers personal contributions; a **Corporate CLA** covers contributions made under employment.
- The CLA grants SovEcom the right to use your contribution under AGPL **and** to relicense it under commercial terms. It does **not** transfer copyright — you retain ownership of your work.

No signed CLA means no merge, regardless of the quality of the PR.

## Ways to contribute

### Asking questions

Use [GitHub Discussions](https://github.com/asifwanders/SovEcom/discussions) — not the issue tracker — for questions and design ideas.

### Reporting bugs

Open an issue using the **Bug Report** template. Include reproduction steps, expected vs. actual behavior, and environment details (OS, Node version, Docker version). **Never report security vulnerabilities in a public issue** — follow [SECURITY.md](./SECURITY.md) instead.

### Proposing features

Open an issue using the **Feature Request** template. For anything non-trivial (new core features, API/breaking changes, security-model changes), an RFC is required first — see the RFC process in [GOVERNANCE.md](./GOVERNANCE.md).

### Submitting pull requests

1. Fork the repo and create a branch from `main` (`feat/short-description`, `fix/short-description`).
2. Keep PRs focused — one logical change per PR.
3. **Write tests first.** The test encodes the spec. PRs that add behavior without tests will be asked to add them before review.
4. Run the full local check suite before opening a PR (see [Local checks](#local-checks)).
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (enforced by commitlint), e.g. `feat(catalog): add product variant matrix` or `fix(checkout): correct VAT rounding on OSS orders`.
6. Open the PR against `main`, fill in the PR template, and sign the CLA when the bot prompts you.
7. CI must be green and a maintainer must approve before merge. **We never merge on red CI.**

## Development setup

### Prerequisites

- **Node.js 24 LTS** — check `.nvmrc` for the pinned patch version
- **pnpm 11+** — see `packageManager` in `package.json`
- **Docker + Docker Compose** — for Postgres, Redis, and Meilisearch

### Install

```bash
git clone https://github.com/asifwanders/SovEcom.git
cd SovEcom
pnpm install
```

### Run the dev stack

The quickest path starts everything (infrastructure + all apps) in one command:

```bash
./scripts/dev.sh
```

Or start infrastructure separately, then run apps:

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres, Redis, Meilisearch
pnpm dev                                          # all apps via Turborepo
```

Copy `.env.example` to `.env` and adjust values before starting. The dev script will warn you if required variables are missing.

| Service     | URL                   | Port |
| ----------- | --------------------- | ---- |
| API         | http://localhost:3000 | 3000 |
| Admin       | http://localhost:5173 | 5173 |
| Setup       | http://localhost:5174 | 5174 |
| Storefront  | http://localhost:3001 | 3001 |
| Postgres    | localhost             | 5432 |
| Redis       | localhost             | 6379 |
| Meilisearch | http://localhost:7700 | 7700 |

To reset the dev environment (drops volumes):

```bash
./scripts/reset.sh
```

### Local checks

Run these before pushing:

```bash
pnpm -r typecheck   # TypeScript strict-mode check across all packages
pnpm -r test        # unit + integration test suite
pnpm lint           # ESLint via @sovecom/eslint-config
pnpm build          # full Turborepo build
```

CI runs all four. A red local check means a red CI.

## Project layout

```
apps/
  api/              NestJS REST API — the core
  admin/            React admin dashboard (shadcn/ui + Tailwind)
  setup/            First-run setup wizard
  storefront-next/  Reference Next.js storefront (MIT)

packages/
  module-sdk/       Capability SDK for sandboxed module workers
  theme-sdk/        Type-safe theme manifest definitions
  client-js/        Typed API client for storefronts and integrations
  eslint-config/    Shared ESLint configuration
  module-contract-tests/  Shared test harness for module authors
  theme-contract-tests/   Shared test harness for theme authors

modules/            Reference module implementations (e.g. wishlist)
themes/             Reference theme implementations
docs/               Astro Starlight documentation site → docs.sovecom.io
```

For deeper orientation, read the [Architecture Overview](https://docs.sovecom.io/getting-started/architecture-overview/) and the [Developer Guides](https://docs.sovecom.io/guides/modules/).

## Code style

- **Language:** TypeScript everywhere. Strict mode, no `any`.
- **Formatting:** Prettier (semi, single quotes, trailing commas, 100-char width). Applied automatically via pre-commit hook.
- **Linting:** ESLint with the shared `@sovecom/eslint-config`.
- **Money:** always integer minor units (cents) + an ISO-4217 currency code. No floats on the money path, ever.
- **Multi-tenancy:** every query threads a `tenant_id`, even in single-tenant v1. This is load-bearing for the future Cloud layer — do not omit it.
- **Security-critical paths** (auth, crypto, secrets, payments, refunds, tax, tenant isolation) receive extra review. The author is never the sole reviewer of their own security-critical change.

## Branching model

- `main` — always releasable; PRs target this branch (protected).
- `feat/<slug>` — new features and non-trivial improvements.
- `fix/<slug>` — bug fixes.
- `docs/<slug>` — documentation-only changes.

## License of contributions

Contributions to the core are licensed under **AGPL-3.0**. Contributions to the reference storefront and SDK packages are **MIT**. The CLA additionally permits commercial relicensing as described in it.
