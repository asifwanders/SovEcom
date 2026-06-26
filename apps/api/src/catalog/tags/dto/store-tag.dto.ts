/**
 * StoreTagDto (public allowlist).
 *
 * Never expose: tenant_id, timestamps, internal fields.
 */

export interface StoreTagDto {
  id: string;
  slug: string;
  name: string;
}

export interface StoreTagListDto {
  data: StoreTagDto[];
}
