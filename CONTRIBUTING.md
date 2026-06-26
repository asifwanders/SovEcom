# Contributing to SovEcom

Thank you for your interest in SovEcom. This guide explains how to ask questions, report bugs, propose features, and submit changes.

> **Project status:** Pre-alpha. The codebase is still being scaffolded; large feature contributions are premature. The most useful contributions right now are feedback, governance/docs review, and small fixes.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). Report unacceptable behavior to `conduct@sovecom.io`.

## Contributor License Agreement (CLA) — Required

**Every external contributor must sign the SovEcom CLA before any pull request can be merged.** This is non-negotiable.

- Signing is automatic on your first PR: a bot (cla-assistant.io) comments with a link.
- An **Individual CLA** covers personal contributions; a **Corporate CLA** covers contributions made under employment.
- The CLA grants SovEcom the right to use your contribution under AGPL **and** to relicense it under commercial terms. It does **not** transfer copyright — you retain ownership of your work.

Without a signed CLA, a PR cannot be merged, no matter how good it is.

## Ways to Contribute

### Asking Questions

Use [GitHub Discussions](https://github.com/asifwanders/SovEcom/discussions) — not the issue tracker — for questions and ideas.

### Reporting Bugs

Open an issue using the **Bug Report** template. Include reproduction steps, expected vs actual behavior, and environment details. **Never report security vulnerabilities in a public issue** — follow [SECURITY.md](./SECURITY.md) instead.

### Proposing Features

Open an issue using the **Feature Request** template. For anything non-trivial (new core features, API/breaking changes, security-model changes), an **RFC** is required first — see the RFC process in [GOVERNANCE.md](./GOVERNANCE.md).

### Submitting Pull Requests

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. **Write tests first.** SovEcom is test-driven; the test encodes the spec. PRs that add behavior without tests will be asked to add them.
4. Ensure `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass locally.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (enforced by commitlint), e.g. `feat(catalog): add product variant matrix`.
6. Open the PR against `main`, fill in the PR template, and sign the CLA when prompted.
7. CI must be green and a maintainer must approve before merge. **We never merge on red CI.**

## Code Style

- **Language:** TypeScript everywhere. Strict mode.
- **Formatting:** Prettier (semi, single quotes, trailing commas, 100-char width). Auto-applied via pre-commit hook.
- **Linting:** ESLint with the shared `@sovecom/eslint-config`.
- **Money:** always integer minor units (cents) + a currency code. Never floats.
- **Multi-tenancy:** every query threads a `tenant_id`, even in single-tenant v1.
- **Security-critical paths** (auth, crypto, secrets, payments, refunds, tax, tenant isolation) receive extra review. The author is never the sole reviewer of their own security-critical code.

## Branching

- `main` — primary branch; PRs target this (protected).
- Feature branches — `feat/short-description`, `fix/short-description`.

## License of Contributions

Contributions to the core are licensed under **AGPL-3.0**. Contributions to the reference storefront template are **MIT**. The CLA additionally permits commercial relicensing as described above.
