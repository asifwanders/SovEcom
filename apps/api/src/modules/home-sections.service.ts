/**
 * HomeSectionsService — admin-side replace + both admin and store reads.
 *
 * Validation boundary: `replace()` maps every raw array entry through `parseMarketingSection`
 * from `@sovecom/theme-sdk` and REJECTS THE WHOLE REQUEST (422) if any entry is invalid (fail-
 * closed — no partial saves, no unvalidated data ever reaches the DB). The array is also bounded
 * to {@link MAX_SECTIONS} entries; oversized arrays are rejected before any DB access.
 *
 * `getForStore()` re-validates each stored entry on read and DROPS invalid ones (defence-in-depth
 * against a row mutated out-of-band) — mirroring `safeTemplates` in `themes.service.ts`. The
 * store endpoint never throws on corrupt data; it returns whatever valid sections remain.
 */
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { parseMarketingSection, type MarketingSectionDescriptor } from '@sovecom/theme-sdk';
import { HomeSectionsRepository } from './home-sections.repository';

/** Maximum number of sections allowed per tenant home page. */
export const MAX_SECTIONS = 50;

/** The validated section list returned to both admin and store surfaces. */
export interface HomeSectionsView {
  readonly sections: MarketingSectionDescriptor[];
  readonly updatedAt: Date;
}

@Injectable()
export class HomeSectionsService {
  constructor(private readonly repo: HomeSectionsRepository) {}

  /**
   * Get the home sections for the admin surface. Returns the stored (and re-validated on read)
   * sections, or an empty list if none have been set yet.
   */
  async getForAdmin(tenantId: string): Promise<HomeSectionsView> {
    const row = await this.repo.get(tenantId);
    if (!row) {
      return { sections: [], updatedAt: new Date(0) };
    }
    const sections = HomeSectionsService.safeSections(row.sections);
    return { sections, updatedAt: row.updatedAt };
  }

  /**
   * Replace the home sections for this tenant. Validation is fail-closed:
   *   1. The array length must not exceed {@link MAX_SECTIONS}.
   *   2. Every entry is parsed through `parseMarketingSection` — a single invalid entry rejects
   *      the ENTIRE request (422). No partial saves.
   * Only after ALL entries are validated does the service write to the repository.
   */
  async replace(tenantId: string, rawArray: unknown[]): Promise<HomeSectionsView> {
    if (rawArray.length > MAX_SECTIONS) {
      throw new UnprocessableEntityException(
        `sections array exceeds the maximum of ${MAX_SECTIONS} entries`,
      );
    }

    const validated: MarketingSectionDescriptor[] = [];
    for (let i = 0; i < rawArray.length; i++) {
      const descriptor = parseMarketingSection(rawArray[i]);
      if (descriptor === null) {
        throw new UnprocessableEntityException(
          `sections[${i}] is invalid: unknown type or settings failed validation`,
        );
      }
      validated.push(descriptor);
    }

    const row = await this.repo.set(tenantId, validated);
    return { sections: validated, updatedAt: row.updatedAt };
  }

  /**
   * Get the home sections for the public store surface. Re-validates every stored entry on read
   * and drops any that fail (defence-in-depth). Never throws — a corrupt row degrades to fewer
   * sections, never to a 500.
   */
  async getForStore(tenantId: string): Promise<HomeSectionsView> {
    const row = await this.repo.get(tenantId);
    if (!row) {
      return { sections: [], updatedAt: new Date(0) };
    }
    const sections = HomeSectionsService.safeSections(row.sections);
    return { sections, updatedAt: row.updatedAt };
  }

  /**
   * Re-validate stored sections JSONB on read. Any entry that fails `parseMarketingSection` is
   * silently dropped (not thrown). Returns an empty array if the stored value is not an array.
   * Never throws. Mirrors `ThemesService.safeTemplates`.
   */
  private static safeSections(raw: unknown): MarketingSectionDescriptor[] {
    if (!Array.isArray(raw)) return [];
    const out: MarketingSectionDescriptor[] = [];
    for (const entry of raw) {
      const descriptor = parseMarketingSection(entry);
      if (descriptor !== null) {
        out.push(descriptor);
      }
    }
    return out;
  }
}
