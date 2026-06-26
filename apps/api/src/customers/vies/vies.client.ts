/**
 * VIES client seam (SECURITY-/TAX-ADJACENT).
 *
 * VIES (the EU VAT-number validation service) is reached through this injectable
 * seam so that tests/CI MOCK it (no network egress — EU-privacy + determinism)
 * while production swaps in a real SOAP/HTTP client. The interface deliberately
 * returns a STATUS tri-state, not a boolean:
 *
 *   - 'valid'       — the MS positively confirmed the number; `consultationRef`
 *                     is the durable proof of record (persisted in metadata).
 *   - 'invalid'     — the MS said the number is bad → charge VAT permanently.
 *   - 'unreachable' — VIES/MS down, timeout, or transport error → charge VAT for
 *                     now, but the number MAY be valid → must be re-checked later
 *                     (background job; status captured now so it is actionable).
 *                     Availability fails OPEN (never blocks signup); tax fails SAFE
 *                     (`vat_validated` stays false).
 *
 * A boolean cannot express the invalid-vs-unreachable distinction — so the seam is
 * a status, not a flag.
 */

/** DI token for the VIES client — tests bind a mock, prod binds the real client. */
export const VIES_CLIENT = Symbol('customers:VIES_CLIENT');

/** The tri-state outcome of a VIES check. */
export type ViesStatus = 'valid' | 'invalid' | 'unreachable';

/** Normalised VIES check result returned by every client implementation. */
export interface ViesCheckResult {
  status: ViesStatus;
  /** Trader name VIES echoes back on a positive check (optional). */
  companyName?: string;
  /** Trader address VIES echoes back on a positive check (optional). */
  address?: string;
  /**
   * VIES consultation reference — per-consultation PROOF a LIVE check occurred
   * (valid only). A `consultationRef` is evidence of one specific consultation
   * and is therefore NEVER cached and NEVER fabricated for a different customer.
   * It is present ONLY on a fresh, live `valid` response.
   */
  consultationRef?: string;
  /**
   * True when this `valid` result came from the 24h positive cache (perf only),
   * NOT a live VIES consultation. A cached result carries NO `consultationRef`
   * (the caller persists `{status:'valid', cached:true}` as the metadata proof).
   */
  cached?: boolean;
}

/** The injectable VIES client contract. */
export interface ViesClient {
  /**
   * Check a VAT number for `country` (ISO 3166-1 alpha-2) + `number` (the digits
   * after the country prefix). MUST NOT throw on a transport/timeout failure —
   * it resolves to `{ status: 'unreachable' }` so the caller never blocks signup.
   */
  check(country: string, number: string): Promise<ViesCheckResult>;
}

/**
 * Real-client STUB. The seam + mock is the deliverable for 1.8; a production SOAP
 * integration against `ec.europa.eu/taxation_customs/vies` lands later. Until then
 * this fails SAFE-OPEN: it reports `unreachable` (never throws, never blocks, never
 * positively validates — so VAT is charged) rather than pretending to validate.
 */
export class RealViesClient implements ViesClient {
  check(_country: string, _number: string): Promise<ViesCheckResult> {
    // No network call wired yet (background re-validation pending).
    return Promise.resolve({ status: 'unreachable' });
  }
}
