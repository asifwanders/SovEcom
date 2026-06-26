'use client';

/**
 * interactive variant selector. Replaces the PDP's 3.6/3.7
 * DISPLAY-ONLY variant block with a client island that lets the shopper choose a variant, then surfaces
 * THAT variant's price + availability and feeds its id to {@link AddToCartButton}.
 *
 * This is a CLIENT ISLAND inside the RSC PDP: the server page keeps emitting the Product/Offer +
 * BreadcrumbList JSON-LD (it renders `<StructuredData>` itself); this component renders no structured
 * data and does not touch the server markup, so SEO is unchanged.
 *
 * MONEY: the price shown is the SERVER's integer minor-unit `priceAmount` for the resolved variant,
 * rendered via `formatPrice` (currency-exponent aware — never `/100`, never client arithmetic).
 *
 * Resolution model (no new API; works off the variant list the PDP already fetched):
 *   - 0 variants → renders nothing (the PDP shows its own no-variant state).
 *   - 1 variant  → no selector; that variant is the selection immediately (price + add button).
 *   - N variants → one `<select>` per OPTION AXIS (the union of option keys across variants). The
 *     resolved variant is the one whose options match every chosen axis value. When the variants have
 *     NO option keys (just multiple unnamed variants), we fall back to a single by-title/by-id select.
 *   - Until a full combination is chosen, there is no resolved variant → the add button is disabled
 *     and a prompt invites a selection.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatPrice } from '@/lib/api';
import type { ProductVariantView } from '@/lib/catalog';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { AddToCartButton } from '@/components/cart/AddToCartButton';

/** The ordered set of option axis keys across all variants (e.g. ['Size','Color']). */
function optionAxes(variants: ProductVariantView[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const v of variants) {
    for (const key of Object.keys(v.options)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  return order;
}

/** The distinct values for one axis, in first-seen order. */
function axisValues(variants: ProductVariantView[], axis: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const v of variants) {
    const raw = v.options[axis];
    if (raw === undefined || raw === null) continue;
    const val = String(raw);
    if (!seen.has(val)) {
      seen.add(val);
      order.push(val);
    }
  }
  return order;
}

/** Find the single variant matching every chosen axis value (or null when none/ambiguous-incomplete). */
function resolveByAxes(
  variants: ProductVariantView[],
  axes: string[],
  selection: Record<string, string>,
): ProductVariantView | null {
  // Every axis must have a chosen value before we can resolve.
  if (axes.some((a) => selection[a] === undefined || selection[a] === '')) return null;
  const match = variants.find((v) =>
    axes.every((a) => String(v.options[a] ?? '') === selection[a]),
  );
  return match ?? null;
}

export function VariantSelector({
  variants,
  locale,
}: {
  variants: ProductVariantView[];
  locale: string;
}): React.ReactElement | null {
  const t = useTranslations('product');
  const axes = useMemo(() => optionAxes(variants), [variants]);
  // For axis-based products, the selection maps axis → chosen value. For optionless multi-variant
  // products we key directly on variant id.
  const [axisSelection, setAxisSelection] = useState<Record<string, string>>({});
  const [variantById, setVariantById] = useState<string>('');

  if (variants.length === 0) return null;

  const single = variants.length === 1 ? variants[0]! : null;
  const hasAxes = axes.length > 0;

  let resolved: ProductVariantView | null;
  if (single) {
    resolved = single;
  } else if (hasAxes) {
    resolved = resolveByAxes(variants, axes, axisSelection);
  } else {
    resolved = variants.find((v) => v.id === variantById) ?? null;
  }

  return (
    <div className="space-y-4">
      {/* Selectors — only when there is more than one variant. */}
      {!single && hasAxes && (
        <div className="space-y-3">
          {axes.map((axis) => {
            const values = axisValues(variants, axis);
            const selectId = `variant-axis-${axis}`;
            return (
              <div key={axis} className="flex flex-col gap-1.5">
                <label htmlFor={selectId} className="text-sm font-medium text-foreground">
                  {axis}
                </label>
                {/* The visible <label htmlFor> is the accessible name — no redundant aria-label. */}
                <Select
                  id={selectId}
                  value={axisSelection[axis] ?? ''}
                  onChange={(e) =>
                    setAxisSelection((prev) => ({ ...prev, [axis]: e.target.value }))
                  }
                >
                  <option value="">{t('chooseOptions')}</option>
                  {values.map((val) => (
                    <option key={val} value={val}>
                      {val}
                    </option>
                  ))}
                </Select>
              </div>
            );
          })}
        </div>
      )}

      {!single && !hasAxes && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="variant-by-id" className="text-sm font-medium text-foreground">
            {t('variants')}
          </label>
          {/* The visible <label htmlFor> is the accessible name — no redundant aria-label. */}
          <Select
            id="variant-by-id"
            value={variantById}
            onChange={(e) => setVariantById(e.target.value)}
          >
            <option value="">{t('chooseOptions')}</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title ?? v.id}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Resolved-variant price + availability (server minor units; never client math). Wrapped in an
          aria-live="polite" region so a screen-reader user hears the price/availability change when
          they pick a different option (the displayed price is changing — worth announcing). */}
      <div aria-live="polite">
        {resolved ? (
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold text-primary">
              {formatPrice(resolved.priceAmount, resolved.currency, locale)}
            </span>
            <Badge variant="availability" tone={resolved.availability ? 'success' : 'destructive'}>
              {resolved.availability ? t('inStock') : t('outOfStock')}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('selectVariantPrompt')}</p>
        )}
      </div>

      <AddToCartButton
        variantId={resolved?.id ?? null}
        available={resolved?.availability ?? false}
      />
    </div>
  );
}
