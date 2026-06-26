<div align="center">

# SovEcom

**The open-source headless ecommerce platform built for the European Union — from day one.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Status: Release Candidate](https://img.shields.io/badge/status-release--candidate-green.svg)](#project-status)

[Documentation](https://docs.sovecom.io) · [GitHub](https://github.com/asifwanders/SovEcom) · [Discussions](https://github.com/asifwanders/SovEcom/discussions) · [Security](./SECURITY.md)

</div>

---

## What is SovEcom?

SovEcom is an EU-first, AGPL-3.0 licensed, **headless** ecommerce platform for European agencies, freelance developers, and tech-savvy SMBs. Where other platforms treat EU compliance as an afterthought, SovEcom makes it **core**:

- **RGPD-by-default** — no tracking, analytics, or PII egress unless you explicitly enable it. Plausible (EU-hosted, cookieless) is the default analytics option. Self-hosted fonts and assets.
- **EU VAT done correctly** — B2B reverse charge, OSS reporting, VIES validation, DGFIP-compliant invoice numbering.
- **Stripe payments** — card, SEPA Direct Debit, Apple Pay, and Google Pay via the hosted Payment Element (PCI SAQ-A scope). Manual/offline payment recording included.
- **Your data, your infrastructure** — one `docker compose up` to a fully running store. Same code in self-host and Cloud; no feature gates.
- **AGPL-3.0** — yours forever. The commercial product is the agency multi-tenant layer, not a crippled core.

## Project Status

SovEcom v1.0 is feature-complete and in final pre-release hardening. The full commerce engine — catalog, cart, checkout, orders, returns, EU VAT, RGPD tooling, theme and module platforms, i18n (FR/EN), admin dashboard, and reference storefront — is built and runnable. Docker images and npm packages are being finalized for the public release. If you want to run it today, clone the repo and follow the [Quickstart](#quickstart-self-host) below.

## Features

### Commerce engine

- Product catalog with variants, images, and rich metadata
- Meilisearch-powered full-text and faceted search
- Cart and checkout with address validation and shipping rates
- Orders, fulfillment states, returns, and refunds with credit notes
- Discount codes and automatic promotions

### Payments

- Stripe: card, SEPA Direct Debit, Apple Pay, Google Pay (PCI SAQ-A; webhook-confirmed settlement)
- Manual/offline payment recording by admin
- Dispute and chargeback tracking with auto-frozen fulfillment

### EU compliance

- EU VAT: B2C OSS, B2B reverse charge, VIES validation, configurable tax rules
- DGFIP-compliant sequential invoice numbering with gapless credit notes
- RGPD data export, deletion workflows, and consent audit log
- Money stored and transmitted as integer minor units + ISO-4217 currency code throughout

### Storefront and themes

- Reference Next.js 15 storefront (MIT-licensed) — ready to fork and deploy
- Theme platform: JSON manifests, page templates, and settings schemas; zero runtime in the theme, maximum composability
- Scaffolder: `pnpm create sovecom-theme <name>`
- i18n: French and English out of the box; locale-aware routing and admin editor for CMS-lite pages

### Module system

- Sandboxed Node.js workers that extend the platform without touching core code
- Declare permissions in `sovecom.module.json`; every call is a gated broker RPC
- Scaffolder: `pnpm dlx create-sovecom-module <name>`
- Reference module: `wishlist` (shipped in-repo)

### Developer experience

- Versioned REST API with OpenAPI/Swagger documentation
- `@sovecom/client-js` typed API client
- `@sovecom/module-sdk` and `@sovecom/theme-sdk` on npm (published at v1.0)
- Comprehensive test suite; TDD-first development
- OpenAPI spec served at `/api/docs` in development

### Admin

- React 19 admin dashboard (shadcn/ui + Tailwind)
- Catalog, orders, customers, discounts, shipping, taxes, RGPD, theme/module management
- Setup wizard for first-run configuration

## Quickstart (self-host)

**Prerequisites:** Docker and Docker Compose. That's it.

```bash
git clone https://github.com/asifwanders/SovEcom.git
cd SovEcom
cp .env.production.example .env
```

Open `.env` and set at minimum:

```bash
SOVECOM_DOMAIN=store.example.com   # your public domain
POSTGRES_PASSWORD=change_me
REDIS_PASSWORD=change_me
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SMTP_HOST=...                      # for transactional email
```

Then bring the stack up:

```bash
docker compose up -d --build
```

Once running, open `https://store.example.com/setup` to complete first-run configuration via the setup wizard. The wizard walks you through brand settings, admin account creation, tax configuration, and theme selection.

Docker images are published to `ghcr.io/asifwanders/sovecom-{api,admin,setup,storefront}` — pull them instead of building locally once the v1.0 release tags are available.

For a full walkthrough including SSL termination, SMTP, and environment variable reference, see the [Installation guide](https://docs.sovecom.io/getting-started/installation/).

## Documentation

Full docs live at **[docs.sovecom.io](https://docs.sovecom.io)**.

| Section                                                                  | What's there                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Getting started](https://docs.sovecom.io/getting-started/installation/) | Installation, architecture overview, first store wizard                  |
| [Operator guides](https://docs.sovecom.io/operator-guides/)              | Payments, taxes/VAT, invoicing, shipping, RGPD, backup/recovery, upgrade |
| [Developer guides — themes](https://docs.sovecom.io/guides/themes/)      | Theme authoring, theme contract, `create-sovecom-theme`                  |
| [Developer guides — modules](https://docs.sovecom.io/guides/modules/)    | Module authoring, security model, custom endpoints, publishing           |
| [API reference](https://docs.sovecom.io/api-reference/)                  | REST endpoint catalogue; live Swagger at `/api/docs` in dev              |

## For developers

### SDKs and scaffolders (npm)

| Package                 | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `@sovecom/client-js`    | Typed API client for storefronts and integrations               |
| `@sovecom/module-sdk`   | Capability broker for sandboxed module workers                  |
| `@sovecom/theme-sdk`    | Type-safe theme manifest definitions                            |
| `create-sovecom-theme`  | `pnpm create sovecom-theme <name>` — scaffold a new theme       |
| `create-sovecom-module` | `pnpm dlx create-sovecom-module <name>` — scaffold a new module |

### Local dev setup

```bash
git clone https://github.com/asifwanders/SovEcom.git
cd SovEcom
pnpm install
./scripts/dev.sh          # starts infrastructure + all apps
```

Or start infrastructure manually then run apps:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm dev
```

| Service     | URL                   | Port |
| ----------- | --------------------- | ---- |
| API         | http://localhost:3000 | 3000 |
| Admin       | http://localhost:5173 | 5173 |
| Setup       | http://localhost:5174 | 5174 |
| Storefront  | http://localhost:3001 | 3001 |
| Postgres    | localhost             | 5432 |
| Redis       | localhost             | 6379 |
| Meilisearch | http://localhost:7700 | 7700 |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor guide.

## Tech stack

| Layer                          | Choice                                                  |
| ------------------------------ | ------------------------------------------------------- |
| API                            | TypeScript · NestJS 11 · REST (versioned)               |
| Database                       | PostgreSQL 17 · Drizzle ORM                             |
| Cache / sessions / rate-limits | Redis 7                                                 |
| Background jobs                | `@nestjs/schedule` cron + Postgres transactional outbox |
| Search                         | Meilisearch                                             |
| Admin                          | React 19 · Vite · shadcn/ui · Tailwind                  |
| Storefront (reference)         | Next.js 15 (App Router) · MIT-licensed                  |
| Proxy / SSL                    | Caddy 2 · Let's Encrypt                                 |
| Tooling                        | pnpm workspaces · Turborepo                             |

## License

| Component                                                             | License                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core (API, admin, setup, module/theme runtime)                        | [AGPL-3.0](./LICENSE)                                             |
| Reference storefront (`apps/storefront-next`)                         | MIT — derived storefronts and themes may be permissively licensed |
| `@sovecom/module-sdk`, `@sovecom/client-js`                           | AGPL-3.0                                                          |
| `@sovecom/theme-sdk`, `create-sovecom-module`, `create-sovecom-theme` | MIT                                                               |
| Agency multi-tenant Cloud layer                                       | Commercial — see [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md) |

Organizations that cannot accept AGPL obligations can purchase a commercial license. Contact `hello@sovecom.io`.

## Contributing · Security · Code of Conduct

- Contributions are welcome — read [CONTRIBUTING.md](./CONTRIBUTING.md) first (CLA required).
- Found a vulnerability? **Do not open a public issue.** Follow [SECURITY.md](./SECURITY.md).
- All participants must follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

<div align="center">
<sub>Built in the EU. Owned by you.</sub>
</div>
