/**
 * StoreProductDto (allowlist).
 *
 * ENUMERATES fields returned on store (public) endpoints. Never expose:
 *   - embedding, metadata (internal)
 *   - tenant_id (leak)
 *   - raw stock_quantity (only coarse availability boolean)
 *   - cost, margin, supplier (none yet, but allowlist by construction)
 *   - draft/archived products (filtered at query level too)
 *
 * Shape mirrors exactly what the service maps; any field not listed here
 * is NOT in the response.
 */

export interface StoreVariantDto {
  id: string;
  title: string | null;
  /**
   * Variant options (e.g. { size: 'M', color: 'red' }). NOTE (Fable, deferred):
   * this jsonb is world-readable on the store — including the `free` flag. That
   * is acceptable for v1 (no secrets belong in options); revisit if options ever
   * carries internal data.
   */
  options: Record<string, unknown>;
  priceAmount: number;
  currency: string;
  compareAtAmount: number | null;
  /** Coarse availability: stockQuantity > 0 OR allowBackorder = true. */
  availability: boolean;
  position: number;
}

export interface StoreImageDto {
  /** Public URL of the thumbnail variant (smallest size). */
  thumbnailUrl: string;
  altText: string | null;
  position: number;
}

export interface StoreProductDto {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  /** Always 'published' on store responses (guard filters). */
  status: 'published';
  seoTitle: string | null;
  seoDescription: string | null;
  variants: StoreVariantDto[];
  images: StoreImageDto[];
  createdAt: string;
  updatedAt: string;
}

export interface StoreProductListDto {
  data: StoreProductDto[];
  /** Opaque base64 cursor for the next page. Absent on last page. */
  nextCursor: string | null;
}
