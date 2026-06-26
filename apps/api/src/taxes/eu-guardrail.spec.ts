/**
 * Unit tests for the SHARED EU VAT guardrail.
 *
 * This is the single rule enforced by BOTH the admin tax-settings PUT and the setup
 * wizard's tax/configure step. The tests pin the exact behaviour both surfaces rely on
 * so a regression here surfaces immediately rather than as a tax-illegal config.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { enforceEuGuardrail } from './eu-guardrail';

describe('enforceEuGuardrail', () => {
  it('rejects tax_mode=none for an EU effective origin (422)', () => {
    expect(() => enforceEuGuardrail('none', 'FR')).toThrow(UnprocessableEntityException);
  });

  it('rejects tax_mode=none when the CURRENT origin is EU even if effective is cleared', () => {
    // "clear origin + set none" in one request must not bypass the guardrail.
    expect(() => enforceEuGuardrail('none', null, 'DE')).toThrow(UnprocessableEntityException);
  });

  it('allows tax_mode=none for a non-EU origin', () => {
    expect(() => enforceEuGuardrail('none', 'US')).not.toThrow();
    expect(() => enforceEuGuardrail('none', null)).not.toThrow();
  });

  it('rejects tax_mode=eu_vat with no effective origin (422)', () => {
    expect(() => enforceEuGuardrail('eu_vat', null)).toThrow(UnprocessableEntityException);
    expect(() => enforceEuGuardrail('eu_vat', undefined)).toThrow(UnprocessableEntityException);
  });

  it('allows tax_mode=eu_vat with an origin country', () => {
    expect(() => enforceEuGuardrail('eu_vat', 'FR')).not.toThrow();
    // Non-EU eu_vat origin is allowed by the guardrail (origin just must be present).
    expect(() => enforceEuGuardrail('eu_vat', 'CH')).not.toThrow();
  });

  it('defaults currentOrigin to effectiveOrigin when omitted', () => {
    // Single-argument-origin (setup wizard) form: EU origin + none → reject.
    expect(() => enforceEuGuardrail('none', 'IT')).toThrow(UnprocessableEntityException);
  });
});
