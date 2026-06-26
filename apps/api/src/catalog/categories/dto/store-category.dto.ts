/**
 * StoreCategoryDto (public allowlist).
 *
 * Never expose: tenant_id, timestamps, description/SEO fields, embedding.
 */

export interface StoreCategoryDto {
  id: string;
  slug: string;
  name: string;
  position: number;
  parentId: string | null;
  productCount?: number;
  children?: StoreCategoryDto[];
}

export interface StoreCategoryListDto {
  data: StoreCategoryDto[];
}
