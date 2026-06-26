<!--
Thanks for contributing to SovEcom! Please fill out the sections below.
PRs target the `main` branch. Use Conventional Commits for your commit messages.
-->

## Description

<!-- What does this PR do and why? -->

## Related issue / RFC

<!-- e.g. Closes #123, or references RFC-0007. Non-trivial changes require an RFC first. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation
- [ ] Chore / tooling / CI

## Testing performed

<!-- Describe the tests you added/ran. SovEcom is test-driven: the test encodes the spec. -->

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and will sign the CLA when prompted.
- [ ] This PR targets the `main` branch.
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] Tests were added/updated and `pnpm test` passes locally.
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass locally.
- [ ] I did not introduce tracking/analytics/PII egress by default.
- [ ] Money is handled as integer cents + currency code (no floats).
- [ ] Touches security-critical paths (auth/crypto/secrets/payments/refunds/tax/tenant isolation)? If yes, flagged for a second reviewer.
