/**
 * email template unit tests: minor-units money formatting,
 * HTML-escaping (stored-XSS-in-email), and the privacy invariant (no external assets / no
 * tracking pixels).
 */
import { renderOrderConfirmation } from './order-confirmation.template';
import { renderOrderShipped } from './order-shipped.template';
import { renderRefundIssued } from './refund-issued.template';
import { renderEmailChangeVerification } from './email-change-verification.template';
import { renderEmailChangeNotice } from './email-change-notice.template';

const baseOrder = {
  orderNumber: 'SO-1001',
  currency: 'EUR',
  subtotalAmount: 2000,
  discountAmount: 0,
  shippingAmount: 500,
  taxAmount: 400,
  totalAmount: 2900,
  items: [
    {
      productTitle: 'Widget',
      sku: 'WID-1',
      quantity: 2,
      unitPriceAmount: 1000,
      lineTotalAmount: 2000,
    },
  ],
  shippingAddress: {
    name: 'Alice',
    line1: '1 rue de Test',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
  },
};

/** No external resource may be referenced by a transactional email (privacy). */
function assertNoExternalAssets(html: string): void {
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/src\s*=/i);
  expect(html).not.toMatch(/https?:\/\//i); // no remote links/pixels/fonts/css
  expect(html).not.toMatch(/background-image/i);
}

describe('renderOrderConfirmation', () => {
  it('formats money in minor units and lists items + totals', () => {
    const out = renderOrderConfirmation(baseOrder);
    expect(out.subject).toBe('Order SO-1001 confirmed');
    expect(out.text).toContain('20.00 EUR'); // line total 2000 minor units → 20.00
    expect(out.text).toContain('Total: 29.00 EUR');
    expect(out.text).toContain('2 x Widget (WID-1) — 20.00 EUR');
    expect(out.text).toContain('Paris');
    assertNoExternalAssets(out.html);
  });

  it('HTML-escapes attacker-controlled product titles (no stored XSS)', () => {
    const out = renderOrderConfirmation({
      ...baseOrder,
      items: [
        {
          productTitle: '<script>alert(1)</script>',
          sku: 'X"><img src=x>',
          quantity: 1,
          unitPriceAmount: 100,
          lineTotalAmount: 100,
        },
      ],
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    // (no assertNoExternalAssets here — the payload deliberately contains an ESCAPED "src=";
    //  the privacy invariant is checked on the clean-input cases.)
  });

  it('omits the discount line when there is no discount', () => {
    const out = renderOrderConfirmation(baseOrder);
    expect(out.text).not.toContain('Discount');
    const withDisc = renderOrderConfirmation({ ...baseOrder, discountAmount: 300 });
    expect(withDisc.text).toContain('Discount: -3.00 EUR');
  });
});

describe('renderOrderShipped', () => {
  it('renders subject + address, escapes, no external assets', () => {
    const out = renderOrderShipped({
      orderNumber: 'SO-2',
      shippingAddress: {
        name: '<b>Bob</b>',
        line1: '2 st',
        city: 'Lyon',
        postalCode: '69001',
        country: 'FR',
      },
    });
    expect(out.subject).toBe('Order SO-2 is on its way');
    expect(out.html).toContain('&lt;b&gt;Bob&lt;/b&gt;');
    expect(out.text).toContain('Lyon');
    assertNoExternalAssets(out.html);
  });
});

describe('renderRefundIssued', () => {
  it('formats zero-decimal (JPY) and 3-decimal (KWD) currencies correctly', () => {
    expect(renderRefundIssued({ orderNumber: 'O1', amount: 1000, currency: 'JPY' }).text).toContain(
      'Refund amount: 1000 JPY',
    );
    expect(renderRefundIssued({ orderNumber: 'O1', amount: 1234, currency: 'KWD' }).text).toContain(
      'Refund amount: 1.234 KWD',
    );
  });

  it('includes the credit-note reference when present and omits it otherwise', () => {
    const withCn = renderRefundIssued({
      orderNumber: 'O1',
      amount: 500,
      currency: 'EUR',
      creditNoteReference: 'CN-42',
    });
    expect(withCn.text).toContain('Credit note: CN-42');
    expect(withCn.html).toContain('CN-42');

    const noCn = renderRefundIssued({ orderNumber: 'O1', amount: 500, currency: 'EUR' });
    expect(noCn.text).not.toContain('Credit note:');
    assertNoExternalAssets(withCn.html);
  });
});

// ── FR/EN localization ──────────────────────
describe('email localization (FR/EN) — prose localized, DATA identical', () => {
  it('order confirmation renders FR copy but identical amounts + order ref', () => {
    const en = renderOrderConfirmation({ ...baseOrder, locale: 'en' });
    const fr = renderOrderConfirmation({ ...baseOrder, locale: 'fr' });

    // Prose differs by locale.
    expect(en.subject).toBe('Order SO-1001 confirmed');
    expect(fr.subject).toBe('Commande SO-1001 confirmée');
    expect(fr.text).toContain('Merci pour votre commande');
    expect(fr.text).toContain('Sous-total');
    expect(fr.html).toContain('Merci pour votre commande');

    // DATA is identical across locales: amounts (integer-cents → formatMoney) + order ref + SKU.
    for (const out of [en, fr]) {
      expect(out.text).toContain('20.00 EUR'); // line total
      expect(out.text).toContain('29.00 EUR'); // total
      expect(out.text).toContain('SO-1001');
      expect(out.text).toContain('WID-1');
      assertNoExternalAssets(out.html);
    }
  });

  it("defaults to English when locale omitted (composer's null → 'en' fallback)", () => {
    const out = renderOrderConfirmation(baseOrder); // no locale
    expect(out.subject).toBe('Order SO-1001 confirmed');
    expect(out.text).toContain('Thank you for your order');
  });

  it('order shipped + refund render FR copy with identical data', () => {
    const shippedFr = renderOrderShipped({
      orderNumber: 'SO-9',
      shippingAddress: { name: 'Bob', city: 'Lyon', country: 'FR' },
      locale: 'fr',
    });
    expect(shippedFr.subject).toBe('Votre commande SO-9 est en route');
    expect(shippedFr.text).toContain('Bonne nouvelle');
    expect(shippedFr.text).toContain('SO-9');

    const refundFr = renderRefundIssued({
      orderNumber: 'O7',
      amount: 1234,
      currency: 'KWD',
      creditNoteReference: 'CN-9',
      locale: 'fr',
    });
    expect(refundFr.subject).toBe('Remboursement émis pour la commande O7');
    expect(refundFr.text).toContain('Montant remboursé: 1.234 KWD'); // 3-decimal currency, identical
    expect(refundFr.text).toContain('Avoir: CN-9'); // credit-note reference unchanged
    expect(refundFr.text).toContain('O7');
  });

  it('the order number is bolded inside the localized FR intro (introHtml)', () => {
    const fr = renderOrderConfirmation({ ...baseOrder, locale: 'fr' });
    expect(fr.html).toContain('<strong>SO-1001</strong>');
  });
});

// ── 3.8c C3 — email-change emails ─────────────────────

describe('renderEmailChangeVerification (verify-before-switch)', () => {
  const verifyUrl = 'https://store.test/en/account/email-confirm?token=abc123';

  it('EN: embeds the verify URL in text + an escaped href, no tracking pixel', () => {
    const out = renderEmailChangeVerification({ verifyUrl, locale: 'en' });
    expect(out.subject).toBe('Confirm your new email address');
    expect(out.text).toContain(verifyUrl);
    expect(out.html).toContain(`href="${verifyUrl}"`);
    // Privacy invariant: no external image/asset.
    expect(out.html).not.toMatch(/<img|src=/i);
  });

  it('FR: localized prose, same URL data', () => {
    const out = renderEmailChangeVerification({ verifyUrl, locale: 'fr' });
    expect(out.subject).toBe('Confirmez votre nouvelle adresse e-mail');
    expect(out.text).toContain(verifyUrl);
  });

  it('escapes a hostile URL so it cannot break out of the href (stored-XSS-in-email)', () => {
    const evil = 'https://x.test/c?t="><script>alert(1)</script>';
    const out = renderEmailChangeVerification({ verifyUrl: evil, locale: 'en' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('renderEmailChangeNotice (security notice to the old address)', () => {
  const newEmail = 'new.owner@example.com';

  it('EN requested: includes the new email + the secure-your-account guidance', () => {
    const out = renderEmailChangeNotice({ kind: 'requested', newEmail, locale: 'en' });
    expect(out.subject).toBe('Email change requested on your account');
    expect(out.text).toContain(newEmail);
    expect(out.text.toLowerCase()).toContain('was not you');
  });

  it('EN confirmed: states the email WAS changed to the new address + contact support', () => {
    const out = renderEmailChangeNotice({ kind: 'confirmed', newEmail, locale: 'en' });
    expect(out.subject).toBe('Your account email was changed');
    expect(out.text).toContain(newEmail);
    expect(out.text.toLowerCase()).toContain('contact support');
  });

  it('FR requested + confirmed: localized prose, same new-email data', () => {
    const reqFr = renderEmailChangeNotice({ kind: 'requested', newEmail, locale: 'fr' });
    expect(reqFr.subject).toBe('Demande de changement d’e-mail sur votre compte');
    expect(reqFr.text).toContain(newEmail);

    const confFr = renderEmailChangeNotice({ kind: 'confirmed', newEmail, locale: 'fr' });
    expect(confFr.subject).toBe('L’e-mail de votre compte a été modifié');
    expect(confFr.text).toContain(newEmail);
  });

  it('escapes a hostile new email (stored-XSS-in-email)', () => {
    const out = renderEmailChangeNotice({
      kind: 'confirmed',
      newEmail: '"><script>alert(1)</script>@x.test',
      locale: 'en',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});
