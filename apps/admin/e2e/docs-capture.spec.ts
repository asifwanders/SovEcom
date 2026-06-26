/**
 * Docs screenshot capture. NOT a test — drives the admin SPA and writes
 * PNGs into docs/src/assets/operator-guides/ for the operator guides. Re-runnable: keeps the docs
 * screenshots current when the UI changes (the "screenshots are current" acceptance criterion).
 *
 * Run against a RUNNING dev stack (admin :5173 + API :3000, seeded SEED_E2E_FIXTURE=1):
 *   CAPTURE_DOCS=1 E2E_SKIP_WEBSERVER=1 E2E_ADMIN_BASE_URL=http://localhost:5173 \
 *     STORE_BASE_URL=http://localhost:3001 pnpm exec playwright test docs-capture --project=desktop-chromium
 *
 * Guarded by CAPTURE_DOCS so it is skipped in the normal suite / CI.
 */
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, navTo } from './helpers';

const OUT = resolve(process.cwd(), '../../docs/src/assets/operator-guides');
const shot = (slug: string, name: string) => {
  mkdirSync(resolve(OUT, slug), { recursive: true });
  return resolve(OUT, slug, `${name}.png`);
};

test.describe('docs screenshots', () => {
  test.skip(process.env.CAPTURE_DOCS !== '1', 'set CAPTURE_DOCS=1 to capture');

  test('capture admin screens', async ({ page }) => {
    test.setTimeout(300_000);
    // Auto-accept native confirms — leaving a /new form and navigating away pops an unsaved-changes
    // confirm that otherwise hangs Playwright and poisons every subsequent shot.
    page.on('dialog', (d) => void d.accept().catch(() => {}));
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    const FAST = { timeout: 5000 } as const;

    // Probe: does a full reload keep the session? (Tells us if direct page.goto to detail routes works.)
    await page.goto('/dashboard');
    await page.waitForTimeout(1200);
    const reloadAuthed = !page.url().includes('/login');
    console.log(`  reload keeps auth: ${reloadAuthed}`);
    if (!reloadAuthed) await login(page);

    // Single login (admin login is rate-limited, so no per-shot relogin). Each shot navTo's to a list
    // first (the sidebar is persistent, so this resets the view), and is hard-capped at 20s so a hung
    // interaction can't stall the run.
    const capture = async (label: string, fn: () => Promise<void>) => {
      try {
        await Promise.race([
          fn(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('shot hard-timeout (20s)')), 20_000),
          ),
        ]);
        console.log(`  ✓ ${label}`);
      } catch (e) {
        console.log(`  ✗ ${label} — ${(e as Error).message.split('\n')[0]}`);
      }
    };

    const snap = (slug: string, name: string) => page.screenshot({ path: shot(slug, name) });

    // ---- list screens (sidebar nav only — reliable) ----
    for (const [link, re, slug, name] of [
      ['Products', /\/products$/, 'catalog', 'products-list'],
      ['Discounts', /\/discounts$/, 'discounts', 'discounts-list'],
      ['Customers', /\/customers$/, 'customers', 'customers-list'],
      ['Orders', /\/orders$/, 'orders', 'orders-list'],
      ['Returns', /\/returns$/, 'orders', 'returns-queue'],
      ['Taxes', /\/taxes$/, 'tax', 'tax-settings'],
      ['Shipping', /\/shipping$/, 'shipping', 'zones-rates'],
      ['Email log', /\/email-log$/, 'email', 'email-log'],
      ['Disputes', /\/disputes$/, 'payments', 'disputes-queue'],
      ['Business identity', /\/business-identity$/, 'invoicing-vat', 'business-identity'],
    ] as const) {
      await capture(`${slug}/${name}`, async () => {
        await navTo(page, link, re);
        await page.waitForTimeout(1000);
        await snap(slug, name);
      });
    }

    // ---- order with the frozen-fulfilment (dispute) banner — open the specific order by number ----
    await capture('orders/order-frozen', async () => {
      await navTo(page, 'Orders', /\/orders$/);
      await page.waitForTimeout(600);
      await page
        .locator('table tbody tr', { hasText: 'E2E-FULFIL-1001' })
        .first()
        .click({ force: true, timeout: 4000 });
      await page.waitForTimeout(1400);
      await snap('orders', 'order-frozen');
    });

    // ---- dialogs (open via "Create", screenshot, Escape) ----
    await capture('tax/new-rate-dialog', async () => {
      await navTo(page, 'Taxes', /\/taxes$/);
      await page.getByRole('button', { name: 'Create', exact: true }).last().click(FAST);
      await page.waitForTimeout(900);
      await snap('tax', 'new-rate-dialog');
      await page.keyboard.press('Escape').catch(() => {});
    });
    await capture('shipping/new-zone-dialog', async () => {
      await navTo(page, 'Shipping', /\/shipping$/);
      await page.getByRole('button', { name: 'Create', exact: true }).first().click(FAST);
      await page.waitForTimeout(900);
      await snap('shipping', 'new-zone-dialog');
      await page.keyboard.press('Escape').catch(() => {});
    });
    await capture('shipping/new-rate-dialog', async () => {
      await navTo(page, 'Shipping', /\/shipping$/);
      await page.getByRole('button', { name: 'Create', exact: true }).last().click(FAST);
      await page.waitForTimeout(900);
      await snap('shipping', 'new-rate-dialog');
      await page.keyboard.press('Escape').catch(() => {});
    });

    // ---- detail pages via force-click on the first row ----
    await capture('orders/order-detail', async () => {
      await navTo(page, 'Orders', /\/orders$/);
      await page.waitForTimeout(600);
      await page.locator('table tbody tr').first().click({ force: true, timeout: 4000 });
      await page.waitForTimeout(1400);
      await snap('orders', 'order-detail');
    });
    await capture('customers/customer-detail', async () => {
      await navTo(page, 'Customers', /\/customers$/);
      await page.waitForTimeout(600);
      // row actions are eye (view) then trash (delete); the eye opens the detail
      await page.locator('table tbody tr').first().locator('a,button').first().click(FAST);
      await page.waitForTimeout(1400);
      await snap('customers', 'customer-detail');
    });

    await capture('customers/erase-confirm', async () => {
      await navTo(page, 'Customers', /\/customers$/);
      await page.waitForTimeout(600);
      await page.locator('table tbody tr').first().locator('a,button').last().click(FAST); // trash → RGPD erase confirm
      await page.waitForTimeout(900);
      await snap('customers', 'erase-confirm');
      await page.keyboard.press('Escape').catch(() => {});
    });

    await capture('payments/refund-dialog', async () => {
      await navTo(page, 'Orders', /\/orders$/);
      await page.waitForTimeout(600);
      await page.locator('table tbody tr').first().click({ force: true, timeout: 4000 });
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: 'Refund', exact: true }).click(FAST);
      await page.waitForTimeout(900);
      await snap('payments', 'refund-dialog');
      await page.keyboard.press('Escape').catch(() => {});
    });

    // ---- security / 2FA settings ----
    await capture('settings/security-2fa', async () => {
      await navTo(page, 'Settings', /\/settings/);
      await page.waitForTimeout(800);
      await snap('getting-started', 'security-2fa');
    });

    // ---- product EDIT (now that the blank-page bug is fixed) → the Images/variants panel ----
    await capture('catalog/product-edit', async () => {
      await navTo(page, 'Products', /\/products$/);
      await page.waitForTimeout(600);
      await page.locator('table tbody tr').first().locator('a,button').first().click(FAST);
      await page.waitForTimeout(1600);
      await snap('catalog', 'product-edit');
    });

    // ---- create forms LAST (leaving a /new form pops an in-app discard guard that intercepts the
    //      next sidebar nav, so these must not precede any other admin shot) ----
    await capture('catalog/product-new-form', async () => {
      await navTo(page, 'Products', /\/products$/);
      await page
        .getByRole('button', { name: 'Create', exact: true })
        .or(page.getByRole('link', { name: /create/i }))
        .first()
        .click(FAST);
      await page.waitForTimeout(1000);
      await snap('catalog', 'product-new-form');
    });
    await capture('discounts/discount-new-form', async () => {
      await navTo(page, 'Discounts', /\/discounts$/);
      await page
        .getByRole('button', { name: 'Create', exact: true })
        .or(page.getByRole('link', { name: /create/i }))
        .first()
        .click(FAST);
      await page.waitForTimeout(1000);
      await snap('discounts', 'discount-new-form');
    });

    // ---- storefront cookie banner (separate origin; no admin token) ----
    await capture('rgpd/cookie-banner', async () => {
      const store = process.env.STORE_BASE_URL ?? 'http://localhost:3001';
      await page.context().clearCookies();
      await page.goto(`${store}/en`);
      await page.waitForTimeout(1800);
      await snap('rgpd-data-retention', 'cookie-banner');
    });
  });
});
