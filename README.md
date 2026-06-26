<div align="center">

# SovEcom

**The open-source headless ecommerce platform built for the European Union — from day one.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Status: Pre-Alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)](#project-status)

</div>

---

## What is SovEcom?

SovEcom is an EU-first, open-source, **headless** ecommerce platform for European agencies, freelance developers, and tech-savvy SMBs. Where other platforms treat EU compliance as something to bolt on, SovEcom makes it **core**:

- **RGPD-by-default** — no tracking, analytics, or PII egress unless explicitly enabled. Plausible (EU-hosted, cookieless) is the default.
- **EU VAT done correctly** — B2B reverse charge, OSS reporting, VIES validation, French DGFIP-compliant invoicing.
- **Native EU payments** — SEPA, Bancontact, iDEAL, Klarna, Stripe.
- **Your data, your infrastructure** — self-host with `docker-compose up`, or use the managed Cloud. Same code, no feature gates.
- **AGPL-3.0** — yours forever. The commercial product is the agency multi-tenant layer, never a crippled core.

## Project Status

**Pre-alpha. Not yet usable.** SovEcom is in its foundation phase — repository, governance, tooling, and app scaffolding. There is no product to run yet. Follow the roadmap below.

## Tech Stack

| Layer                  | Choice                                    |
| ---------------------- | ----------------------------------------- |
| API                    | TypeScript · NestJS 11 · REST (versioned) |
| Database               | PostgreSQL 17 · Drizzle ORM               |
| Cache / queues         | Redis 7 · BullMQ                          |
| Search                 | Meilisearch                               |
| Admin                  | React 19 · Vite · shadcn/ui · Tailwind    |
| Storefront (reference) | Next.js 15 (App Router) · MIT-licensed    |
| Proxy / SSL            | Caddy 2 · Let's Encrypt                   |
| Tooling                | pnpm workspaces · Turborepo               |

## Local Development

### Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- pnpm 11+ (see `packageManager` in `package.json`)
- Docker + Docker Compose

### Quickstart

```bash
# Install dependencies
pnpm install

# Start infrastructure (Postgres, Redis, Meilisearch) and all apps
./scripts/dev.sh

# Or start infrastructure manually and apps separately:
docker compose -f docker-compose.dev.yml up -d
pnpm dev
```

### Services & Ports

| Service     | URL                   | Port |
| ----------- | --------------------- | ---- |
| API         | http://localhost:3000 | 3000 |
| Admin       | http://localhost:5173 | 5173 |
| Setup       | http://localhost:5174 | 5174 |
| Storefront  | http://localhost:3001 | 3001 |
| Postgres    | localhost             | 5432 |
| Redis       | localhost             | 6379 |
| Meilisearch | http://localhost:7700 | 7700 |

### Reset Environment

```bash
./scripts/reset.sh
```

### Environment Variables

Copy `.env.example` to `.env` and adjust values as needed.

## Roadmap

| Phase | Name                         | Outcome                                             |
| ----- | ---------------------------- | --------------------------------------------------- |
| **0** | Foundation                   | Repo, governance, CI, scaffolded apps boot          |
| 1     | Core Domain                  | Catalog, customers, auth via API                    |
| 2     | Commerce Engine              | Cart → checkout → order → refund                    |
| 3     | v1.0 Polish & Ship           | Setup wizard, themes, modules, docs, public release |
| 4     | Cloud & Agency Control Plane | Hosted SaaS + multi-tenant agency dashboard         |
| 5     | Marketplace & Maturity       | Themes/modules ecosystem                            |

## Documentation

📚 Documentation site: _coming soon_ (Astro Starlight → `docs.sovecom.io`).

## Contributing

We welcome contributions. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first — note that every external contributor must sign a **CLA** before a PR can be merged. See also our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? **Do not open a public issue.** Follow the disclosure process in [SECURITY.md](./SECURITY.md).

## License

SovEcom core is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE).

The reference storefront template is **MIT-licensed** so derived storefronts and themes can be permissively licensed. For organizations that cannot accept AGPL obligations, **commercial licenses** are available — see [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md).

---

<div align="center">
<sub>Built in the EU. Owned by you.</sub>
</div>
