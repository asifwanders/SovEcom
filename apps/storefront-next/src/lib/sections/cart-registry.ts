'use client';

/**
 * Cart CLIENT section registry — the `type → ClientSection` map the cart page composes its body from
 * via `renderClientSections`. The cart body is a client island (it reads `useCart()`), so it can't use
 * the server registry's async-loader sections; this is its client counterpart.
 */
import type { ClientSection } from './renderClientSections';
import { ClientColumns } from '@/components/sections/ClientColumnsSection';
import {
  CartLineItemsSection,
  CartDiscountSection,
  CartShippingSection,
  CartSummarySection,
} from '@/components/cart/CartSections';

/** The `columns` LAYOUT client section: lays out the renderer-supplied regions per the template settings. */
const ColumnsClientSection: ClientSection = {
  type: 'columns',
  Component: ClientColumns,
};

/** The bundled cart client section registry, keyed by `type` for O(1) lookup in the renderer. */
export const cartSectionRegistry: Readonly<Record<string, ClientSection>> = {
  [ColumnsClientSection.type]: ColumnsClientSection,
  [CartLineItemsSection.type]: CartLineItemsSection,
  [CartDiscountSection.type]: CartDiscountSection,
  [CartShippingSection.type]: CartShippingSection,
  [CartSummarySection.type]: CartSummarySection,
};
