/**
 * Shared E2E helpers.
 *
 * Centralises the route list, the JSON-LD extraction (which must parse the `<`-ESCAPED script
 * payload `StructuredData.tsx` emits — see `safeJsonLd`), and an axe runner that filters to the
 * serious/critical gate.
 */
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * The subset of an axe-core violation we read. We declare it locally rather than importing
 * `axe-core`'s types: `axe-core` is only a TRANSITIVE dep (of `@axe-core/playwright`) and isn't
 * directly resolvable from the storefront, and a local shape keeps the explicit return-type
 * annotation portable (no deep `.pnpm/axe-core@…` path leaks into the inferred type).
 */
export interface AxeViolation {
  id: string;
  impact?: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: unknown[];
}

/** The two storefront locales (mirrors `i18n/routing` — kept literal to avoid importing app src). */
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

/** The legal page slugs the API seed reliably publishes (FR+EN). See `seed-pages` / e2e/README. */
export const SEEDED_LEGAL_SLUGS = [
  'privacy',
  'terms',
  'cookies',
  'legal-notice',
  'withdrawal',
] as const;

/** Build a locale-prefixed root-relative path (`localePrefix: 'always'`). */
export function localePath(locale: Locale, path = ''): string {
  const trimmed = path.replace(/^\/+/, '');
  return trimmed === '' ? `/${locale}` : `/${locale}/${trimmed}`;
}

/**
 * Dismiss the first-visit `CookieBanner` (src/components/CookieBanner.tsx). The banner is a
 * `fixed inset-x-0 bottom-0` region that overlays the footer until the visitor consents, so any
 * footer interaction (theme toggle, language switcher) is OBSCURED while it's up — Playwright's
 * actionability check then times out. We click its accept button ("Got it" / "J'ai compris", the
 * localized `cookieBanner.accept` label), which writes the `cookie_consent` cookie and unmounts the
 * banner. Idempotent: if the banner isn't present (already-dismissed / returning visitor), it's a
 * no-op. Call this AFTER navigation, before touching the footer.
 */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const accept = page.getByRole('button', {
    name: /got it|j['’]ai compris|accept|dismiss|fermer/i,
  });
  if (
    await accept
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await accept.first().click();
    // The banner unmounts (CookieBanner returns null) once consent is recorded.
    await expect(accept.first()).toBeHidden();
  }
}

/** A minimal JSON-LD node shape we assert against (schema.org Things carry `@type`). */
export interface JsonLdNode {
  '@context'?: unknown;
  '@type'?: string | string[];
  [key: string]: unknown;
}

/**
 * Read EVERY `<script type="application/ld+json">` on the page and JSON.parse each one. The payload
 * is `<`-escaped by `StructuredData.tsx` (the `<` form), but `JSON.parse` reads those unicode
 * escapes back verbatim, so a plain parse is correct. Returns the flattened list of top-level nodes
 * (a `@graph` document is expanded into its member nodes). Throws if any block is not valid JSON —
 * a malformed JSON-LD payload is a real defect the gate should surface.
 */
export async function readJsonLd(page: Page): Promise<JsonLdNode[]> {
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const nodes: JsonLdNode[] = [];
  for (const raw of blocks) {
    const parsed = JSON.parse(raw) as JsonLdNode | { '@graph': JsonLdNode[] };
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { '@graph'?: unknown })['@graph'])
    ) {
      nodes.push(...(parsed as { '@graph': JsonLdNode[] })['@graph']);
    } else {
      nodes.push(parsed as JsonLdNode);
    }
  }
  return nodes;
}

/** True when a node's `@type` matches (handles the array-typed `@type` form). */
export function isType(node: JsonLdNode, type: string): boolean {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** Find the first JSON-LD node of a given `@type`, or undefined. */
export function findByType(nodes: JsonLdNode[], type: string): JsonLdNode | undefined {
  return nodes.find((n) => isType(n, type));
}

/**
 * Run axe-core against the current page and return only the serious/critical violations — the gate
 *. Scoped with the default ruleset; we filter by impact rather than
 * disabling rules so nothing serious is silently waived.
 */
export async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/** Compact, readable summary of axe violations for a failing-assertion message. */
export function formatViolations(violations: AxeViolation[]): string {
  return violations
    .map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
    .join('\n');
}

/**
 * Log a seeded customer in via the storefront login page.
 *
 * Sets the cookie-consent cookie first (so the CookieBanner never overlays the form — see
 * `seedConsentCookie` in fixtures.ts; kept inline here to avoid a fixtures↔helpers import cycle), then
 * navigates to `/{locale}/login`, fills the email + password fields (matched by their localized
 * labels — `auth.emailLabel` / `auth.passwordLabel`), submits, and waits until the URL no longer
 * contains `/login` (the form redirects to the post-login destination / home on success).
 *
 * The access token is in-memory only (no Playwright storageState): each test logs in via this helper.
 * After login a subsequent `page.goto` to an account route still works because the httpOnly
 * `SameSite=Strict` refresh cookie the browser holds silently re-mints the access token on mount
 * (auth-context's mount-time silent refresh).
 */
export async function loginAsCustomer(
  page: Page,
  email: string,
  password: string,
  locale: Locale = 'en',
): Promise<void> {
  await page.context().addCookies([
    {
      name: 'cookie_consent',
      value: 'dismissed',
      url: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    },
  ]);

  await page.goto(localePath(locale, 'login'));

  // The fields are labelled via `auth.emailLabel` / `auth.passwordLabel` (EN/FR) — match both locales.
  await page.getByLabel(/email address|adresse e-mail/i).fill(email);
  await page.getByLabel(/^(password|mot de passe)$/i).fill(password);

  await page.getByRole('button', { name: /sign in|se connecter/i }).click();

  // Success leaves the auth page (router.replace to the validated returnTo / home). Wait for the URL
  // to no longer contain `/login`.
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
}

/**
 * Attempt a login that is EXPECTED to fail (negative case for credential flip).
 *
 * The counterpart to `loginAsCustomer`: fills + submits the login form with credentials we expect the
 * server to REJECT, then asserts the page STAYS on `/login` and surfaces the generic, enumeration-safe
 * "Invalid email or password." alert (the LoginForm collapses every failure to one message and never
 * redirects). Used to prove the OLD password no longer works after a password change / reset. Sets the
 * cookie-consent cookie first (so the banner never overlays the form), mirroring `loginAsCustomer`.
 */
export async function loginExpectingFailure(
  page: Page,
  email: string,
  password: string,
  locale: Locale = 'en',
): Promise<void> {
  await page.context().addCookies([
    {
      name: 'cookie_consent',
      value: 'dismissed',
      url: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    },
  ]);

  await page.goto(localePath(locale, 'login'));
  await page.getByLabel(/email address|adresse e-mail/i).fill(email);
  await page.getByLabel(/^(password|mot de passe)$/i).fill(password);
  await page.getByRole('button', { name: /sign in|se connecter/i }).click();

  // A failed login NEVER leaves /login; the generic enumeration-safe alert mounts. Assert both: the
  // alert is the strongest signal the submit completed + was rejected, and the URL guard confirms no
  // redirect happened (a success would have navigated away).
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /invalid email or password|e-mail ou mot de passe/i }),
  ).toBeVisible();
  expect(page.url()).toContain('/login');
}
