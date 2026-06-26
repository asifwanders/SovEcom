/**
 * `none` tax regime.
 *
 * No tax at checkout: `tax_total = 0`, no tax lines, regardless of destination /
 * B2B / inclusive-vs-exclusive. The default for a fresh store and the path for
 * non-EU merchants (e.g. Pakistan) who reconcile tax at filing, not per order.
 * Formalises the 2.2 no-op resolver. NEVER reads `tax_rates`.
 */
import type { TaxInput, TaxResolver, TaxResult } from './tax-resolver';

export class NoneResolver implements TaxResolver {
  resolve(_input: TaxInput): TaxResult {
    return { taxTotal: 0, lines: [] };
  }
}
