# Changelog

All notable changes to SovEcom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.1] - 2026-06-26

### Summary

Full-featured open-source commerce platform for EU-first merchants and agencies. Includes a complete REST API, React admin interface, Next.js storefront, theme and module system, with support for EU compliance (VAT, GDPR, French invoicing) out of the box.

### Added

#### Commerce Engine
- **Product catalog**: create, update, organize into collections; variant management; inventory tracking with reservations; pricing by variant.
- **Search**: Meilisearch integration for fast, typo-tolerant product search and filtering.
- **Pricing & discounts**: fixed and percentage discounts; automatic and manual discount application; discount rules and redemption limits.
- **Tax**: VAT calculation with EU compliance (B2B reverse charge, B2C inclusive display, OSS export); per-tenant tax mode configuration (EU VAT or none).
- **Payments**: Stripe integration for card payments; webhook handling for payment events.
- **Orders**: order creation, payment tracking, status workflow; order history and detail retrieval.

#### Storefront
- **Public product browsing**: searchable catalog with filters; product detail pages with variants and pricing.
- **Cart management**: add/remove/update items; cart persistence.
- **Checkout**: guest and registered checkout flows; Stripe payment form; order confirmation.
- **Customer accounts**: registration, login, profile management, order history, password reset.
- **Multi-language support**: built-in i18n for storefront content (FR/EN) using next-intl.
- **CMS pages**: lightweight content pages for static information (terms, privacy, about).

#### Admin Dashboard
- **Merchant tools**: dashboard overview; product management; order management; discount creation and tracking; analytics.
- **Customer management**: customer list, detail, communication history; password reset assistance.
- **Audit logs**: all admin actions logged with user, timestamp, IP, and user agent; ≥2-year retention.
- **Account settings**: organization profile; credential management (email, password); sub-user management (future).

#### Theme & Module System
- **Themes**: template-driven storefront customization; section-based homepage builder; live preview.
- **Modules**: sandboxed extensibility for catalog features, checkout steps, and admin panels; module SDK and contract tests.
- **SDKs**: public TypeScript APIs for theme development and module development.

#### Security & Compliance
- **Authentication**: Argon2id password hashing (~200ms), JWT tokens, secure session management.
- **Data protection**: GDPR-compliant data export and erasure; HTTPS enforcement; HSTS headers.
- **Privacy defaults**: no tracking pixels by default; cookieless analytics (Plausible) as default; GA and Meta as opt-in modules.
- **Secrets management**: environment-variable-based secrets (dev) and encrypted secrets manager integration (production).
- **API security**: parameterized queries; input validation with Zod; rate limiting on auth endpoints; outbound webhook signing (HMAC-SHA256).

#### Documentation & Developer Experience
- **OpenAPI spec**: full API documentation available at `/admin/v1/docs` (interactive Swagger UI) and `/admin/v1/openapi.json` (machine-readable).
- **Typed JavaScript client**: auto-generated `@sovecom/client-js` package for type-safe API calls from Node.js and browsers.
- **Module SDK**: `@sovecom/module-sdk` for building and testing modules; contract test suite.
- **Theme SDK**: `@sovecom/theme-sdk` for building themes; design tokens and component library.
- **Starlight documentation**: comprehensive setup, API, architecture, and merchant guides.

#### Deployment
- **Docker images**: pre-built multi-architecture images (amd64, arm64) for API, admin, setup, and storefront.
- **Compose setup**: full dev environment via `docker-compose.dev.yml`; production-like stack via `docker-compose.yml`.
- **Database migrations**: Drizzle-based schema versioning with zero-downtime support.
- **Health checks**: aggregated `/health` endpoint and per-service readiness checks.

### Stack
- **Runtime**: Node.js 24 LTS
- **API**: NestJS 11
- **Database**: PostgreSQL 17 (Drizzle ORM)
- **Cache**: Redis 7
- **Search**: Meilisearch
- **Admin UI**: React 19 + Vite 8 + shadcn/ui
- **Storefront**: Next.js 15
- **Containerization**: Docker + Caddy 2
- **Package management**: pnpm + Turborepo
- **Testing**: Vitest + Testcontainers
- **Type safety**: TypeScript 5 (strict mode)
- **Code quality**: ESLint 8 + Prettier 3

### Documentation
- `RELEASING.md` — maintainer runbook for cutting releases
- Extensive inline code comments
- [Starlight docs site](https://docs.sovecom.io) with API reference, module/theme guides, and deployment instructions
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines
