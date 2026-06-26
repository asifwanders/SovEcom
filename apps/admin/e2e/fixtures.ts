/**
 * admin E2E principal. MIRRORS `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` in the API's
 * `seed-e2e-fixture.ts` (kept in sync by hand, the way the storefront e2e fixtures are). The seed
 * (SEED_E2E_FIXTURE=1) gives this owner a real Argon2id password and marks the store installed.
 */
export const ADMIN_EMAIL = 'admin@default.local';
export const ADMIN_PASSWORD = 'E2e-Admin-2026';

/**
 * Admin fulfil→ship. MIRRORS `E2E_FULFILL_ORDER_NUMBERS` /
 * `E2E_FULFILL_ORDER_PREFIX` in the API's `seed-e2e-fixture.ts` (kept in sync by hand). The seed
 * (SEED_E2E_FIXTURE=1) creates a POOL of `paid` orders; `order-fulfil.spec.ts` consumes the first
 * still-`paid` one each run (paid → fulfilled → shipped), which keeps the spec re-runnable without a
 * reseed. All fixture fulfilment orders share this prefix.
 */
export const FULFILL_ORDER_PREFIX = 'E2E-FULFIL-';
