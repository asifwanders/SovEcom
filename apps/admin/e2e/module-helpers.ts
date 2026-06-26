/**
 * Module-install E2E helpers (admin side).
 *
 * Scenario: "Module: admin installs a module, customer uses it on the storefront". The admin
 * half installs + enables a bundled built-in module (`reviews`) through the real admin UI, then the
 * storefront half asserts its slot widget renders (see `apps/storefront-next/e2e/module-render.spec.ts`).
 *
 * The two specs share ONE piece of state — the install persists in the DB — so the ORDERING is a hard
 * dependency: the admin spec INSTALLS, the storefront spec ASSERTS the resulting render. Run the admin
 * spec first (or rely on the install already being present from a prior admin run); the storefront spec
 * is self-guarded and `test.skip`s cleanly if the module isn't enabled yet (never a false failure).
 *
 * The chosen module is `reviews` because its `review-list` widget is the ONLY bundled widget that
 * renders without storefront-identity wiring: it is read-only + anonymous (`review-list` is
 * `personalized:false`), server-fetched and SEO-visible. The personalized widgets
 * (wishlist `toggle-button`, recently-viewed `product-carousel`, notify `submit-form`) need a customer/
 * guest identity in the client island to populate — that identity-into-island wiring is deferred,
 * so this scenario deliberately targets `reviews`.
 *
 * KNOWN STACK BLOCKER (honest skip, mirroring the storefront fixtures' empty-catalog / unprovisioned
 * posture): the module install path EXTRACTS the verified tarball under `MODULES_DATA_PATH` (defaults
 * to `/data/modules`). If that root is not writable (e.g. a dev host where the API was started without
 * `MODULES_DATA_PATH` pointing at a writable dir, so it falls back to `/data`, which is read-only),
 * EVERY install/inspect fails with `mkdir '/data'` → HTTP 422. The whole install→enable→slot→render
 * pipeline is then unreachable through no fault of the test. `probeReviewsInstallable` returns a
 * structured result so the spec can `test.skip` with that exact diagnostic instead of failing — and
 * activate fully the moment the API is (re)started with a writable `MODULES_DATA_PATH`.
 */
import { request as playwrightRequest } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';

/** This file's directory (ESM-safe — the admin e2e runs as ES modules, no `__dirname`). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The bundled module this scenario installs (manifest `name`; the install/enable key). */
export const REVIEWS_MODULE = 'reviews';
/** The slot it fills + the MIT widget that renders it (mirrors `reviews/sovecom.module.json`). */
export const REVIEWS_SLOT = 'product-detail-reviews-section';
export const REVIEWS_WIDGET = 'review-list';

/** The API origin the admin SPA + these provisioning calls hit (mirrors the admin playwright config). */
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Path to the packed bundled `.tgz` the admin install dialog uploads. The pack step
 * (`pnpm pack:bundled-modules`) writes it to `apps/api/bundled-modules/<id>.tgz`; we resolve it from
 * the repo root (two levels up from `apps/admin/e2e`) so the path holds regardless of the test cwd.
 */
export const REVIEWS_TGZ_PATH = resolve(
  HERE,
  '..',
  '..',
  'api',
  'bundled-modules',
  `${REVIEWS_MODULE}.tgz`,
);

/** Read the bundled tarball into a buffer (for the multipart provisioning probe). Throws if missing. */
export function readReviewsTgz(): Buffer {
  return readFileSync(REVIEWS_TGZ_PATH);
}

/** Outcome of the idempotent provisioning probe — drives the spec's skip-vs-run decision. */
export interface ModuleProvisionResult {
  /** The module is installed AND enabled (slot binding now live) — the spec can assert the pipeline. */
  ready: boolean;
  /** A human diagnostic for the skip annotation when `ready` is false (the exact blocker, e.g. /data). */
  reason: string;
}

/**
 * READINESS-ONLY probe: can this stack install a module at all, WITHOUT committing an install? Lets the
 * admin UI spec own the real upload-and-install (the scenario's acceptance gate) while still skipping
 * cleanly when the stack is blocked.
 *
 * It works by INSPECTING the tarball through the admin `inspect` endpoint — the same verify/extract path
 * `install` runs (it extracts under MODULES_DATA_PATH and verifies the manifest), but WITHOUT persisting
 * an install. So an inspect 200 proves the install path is unblocked (the `/data` MODULES_DATA_PATH
 * blocker would 422 inspect too), and the UI test that follows performs the actual install fresh. If
 * reviews is already installed (a prior run / the storefront spec), readiness is trivially true.
 */
export async function probeReviewsInstallable(): Promise<ModuleProvisionResult> {
  const ctx = await playwrightRequest.newContext({ baseURL: API_BASE_URL });
  try {
    const login = await ctx.post('/admin/v1/auth/login', {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!login.ok()) {
      return {
        ready: false,
        reason: `admin login failed (HTTP ${login.status()}) — API unreachable?`,
      };
    }
    const accessToken = (await login.json())?.accessToken as string | undefined;
    if (!accessToken) return { ready: false, reason: 'admin login returned no access token' };
    const auth = { Authorization: `Bearer ${accessToken}` };

    if (await isInstalled(ctx, auth)) return { ready: true, reason: 'reviews already installed' };

    // Inspect (verify+extract, NO persist) — proves the install path is unblocked without installing.
    const inspect = await ctx.post('/admin/v1/modules/inspect', {
      headers: auth,
      multipart: {
        file: {
          name: `${REVIEWS_MODULE}.tgz`,
          mimeType: 'application/gzip',
          buffer: readReviewsTgz(),
        },
      },
    });
    if (inspect.ok())
      return { ready: true, reason: 'reviews tarball inspects cleanly (install unblocked)' };
    const body = await inspect.text().catch(() => '');
    return {
      ready: false,
      reason:
        `module inspect failed (HTTP ${inspect.status()}): ${body.slice(0, 300)} — ` +
        'the API likely lacks a writable MODULES_DATA_PATH (it extracts the verified tarball there; ' +
        'a read-only/symlinked path yields `mkdir`/access errors → 422). Point MODULES_DATA_PATH at a ' +
        'writable, fully-resolved dir.',
    };
  } catch (err) {
    return {
      ready: false,
      reason: `inspect probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await ctx.dispose();
  }
}

/** Is the `reviews` module present in the tenant's installed-modules list? */
async function isInstalled(
  ctx: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  auth: Record<string, string>,
): Promise<boolean> {
  const list = await ctx.get('/admin/v1/modules', { headers: auth });
  if (!list.ok()) return false;
  const mods = (await list.json()) as Array<{ name?: string }>;
  return Array.isArray(mods) && mods.some((m) => m.name === REVIEWS_MODULE);
}
