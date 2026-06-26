/**
 * `none` resolver unit tests.
 *
 * Returns { taxTotal: 0, lines: [] } ALWAYS — regardless of destination, B2B status,
 * or inclusive/exclusive. The non-EU-merchant path; formalises the 2.2 no-op.
 */
import { NoneResolver } from './none-resolver';
import type { TaxInput } from './tax-resolver';

const resolver = new NoneResolver();

function input(overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    currency: 'EUR',
    destinationCountry: 'FR',
    components: [{ description: 'Items', amount: 10000 }],
    pricesIncludeTax: false,
    customer: null,
    ...overrides,
  };
}

describe('NoneResolver', () => {
  it('returns zero tax for a domestic EU cart', () => {
    expect(resolver.resolve(input())).toEqual({ taxTotal: 0, lines: [] });
  });

  it('returns zero tax regardless of B2B status', () => {
    const res = resolver.resolve(input({ customer: { isB2b: true, vatValidated: true } }));
    expect(res).toEqual({ taxTotal: 0, lines: [] });
  });

  it('returns zero tax regardless of destination', () => {
    expect(resolver.resolve(input({ destinationCountry: 'US' }))).toEqual({ taxTotal: 0, lines: [] }); // prettier-ignore
    expect(resolver.resolve(input({ destinationCountry: null }))).toEqual({ taxTotal: 0, lines: [] }); // prettier-ignore
  });

  it('returns zero tax regardless of inclusive/exclusive', () => {
    expect(resolver.resolve(input({ pricesIncludeTax: true })).taxTotal).toBe(0);
  });
});
