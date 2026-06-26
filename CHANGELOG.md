# Changelog

All notable changes to SovEcom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.1] - 2026-06-09

Foundation complete — repository, tooling, scaffolding, and core infrastructure. No product features yet; not usable in production.

### Added
- **Governance & repo**: AGPL-3.0 license, commercial-license pointer, governance, maintainers, contributing, security policy (with PGP key), code of conduct, issue/PR templates, CODEOWNERS.
- **Monorepo**: pnpm workspaces + Turborepo; shared TypeScript/ESLint/Prettier config; `apps/*`, `packages/*`, `modules/*`, `themes/*` scaffolding.
- **CI/CD**: GitHub Actions (lint, typecheck, test, integration, build), CodeQL, dependency-review, CLA workflow; Husky + commitlint + lint-staged; Changesets.
- **App shells**: NestJS API, Vite/React admin + setup, Next.js storefront; Docker Compose (dev + full prod-like behind Caddy); teal/Ubuntu design tokens.
- **Infrastructure**: Drizzle ORM + PostgreSQL (tenants schema, UUID v7), Redis (ioredis), Meilisearch; aggregated `/health`; unit + integration tests.
- **API docs**: OpenAPI/Swagger at `/admin/v1/docs` + `/admin/v1/openapi.json`; Astro Starlight documentation site.

### Stack
- Node.js 24 LTS · NestJS 11 · PostgreSQL 17 · Redis 7 · Meilisearch · React 19 · Next.js 15 · Vite 8 · Drizzle ORM · pnpm + Turborepo · Caddy 2.
