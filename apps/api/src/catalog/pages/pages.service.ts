/**
 * PagesService.
 *
 * Business rules (mirrors CategoriesService discipline):
 *   1. Tenant isolation: every DB call goes through the repository with tenantId.
 *   2. Store read returns ONLY `status='published'` rows for the exact
 * `(tenant_id, slug, locale)` — no default-locale fallback.
 *      Missing/draft/wrong-locale → 404.
 *   3. Admin CRUD by id; missing → 404.
 *   4. A `(tenant_id, slug, locale)` UNIQUE collision on create/update → 409.
 *   5. Audit every admin mutation (create/update/delete) via AuditService.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { isUniqueViolation } from '../../common/pg-error.util';
import { PagesRepository, type PageRow, type PageListFilter } from './pages.repository';
import type { CreatePageDto } from './dto/create-page.dto';
import type { UpdatePageDto } from './dto/update-page.dto';
import type { StorePageDto } from './dto/store-page.dto';

const DUPLICATE_MESSAGE =
  'A page with this slug already exists for this locale. Use a different slug or locale.';

@Injectable()
export class PagesService {
  constructor(
    private readonly repo: PagesRepository,
    private readonly audit: AuditService,
  ) {}

  // ── Store read ──────────────────────────────────────────────────────────────

  /**
   * Public store read: the published row for `(tenantId, slug, locale)`, mapped
   * to the {@link StorePageDto} allowlist. 404 on anything else.
   */
  async storeFindBySlug(tenantId: string, slug: string, locale: string): Promise<StorePageDto> {
    const page = await this.repo.findPublishedBySlugLocale(tenantId, slug, locale);
    if (!page) throw new NotFoundException('Page not found');
    return this._toStoreDto(page);
  }

  // ── Admin reads ───────────────────────────────────────────────────────────

  async adminList(tenantId: string, filter: PageListFilter = {}): Promise<PageRow[]> {
    return this.repo.findAll(tenantId, filter);
  }

  async adminFindById(tenantId: string, id: string): Promise<PageRow> {
    const page = await this.repo.findById(tenantId, id);
    if (!page) throw new NotFoundException(`Page ${id} not found`);
    return page;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    actorId: string,
    dto: CreatePageDto,
    ip?: string,
    userAgent?: string,
  ): Promise<PageRow> {
    let page: PageRow;
    try {
      page = await this.repo.insert({
        tenantId,
        slug: dto.slug,
        title: dto.title,
        body: dto.body,
        locale: dto.locale,
        status: dto.status ?? 'draft',
        seoTitle: dto.seoTitle ?? null,
        seoDescription: dto.seoDescription ?? null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(DUPLICATE_MESSAGE);
      throw err;
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'page.created',
      resourceType: 'page',
      resourceId: page.id,
      ip,
      userAgent,
      changes: { slug: dto.slug, locale: dto.locale, status: page.status },
    });

    return page;
  }

  // ── Update / PATCH ──────────────────────────────────────────────────────────

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdatePageDto,
    ip?: string,
    userAgent?: string,
  ): Promise<PageRow> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Page ${id} not found`);

    // Build the patch + an audit diff of only the fields that actually changed.
    const patch: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};
    const fields = [
      'slug',
      'title',
      'body',
      'locale',
      'status',
      'seoTitle',
      'seoDescription',
    ] as const;
    for (const f of fields) {
      const next = dto[f];
      if (next !== undefined && next !== existing[f]) {
        patch[f] = next;
        // Keep the body OUT of the audit changeset (it can be ~100k chars); record
        // only that it changed, mirroring "don't persist bulky/secret payloads".
        changes[f] = f === 'body' ? '[changed]' : next;
      }
    }

    if (Object.keys(patch).length === 0) {
      // No-op PATCH: nothing to persist, but still return the current row.
      return existing;
    }

    let updated: PageRow | null;
    try {
      updated = await this.repo.update(tenantId, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(DUPLICATE_MESSAGE);
      throw err;
    }
    if (!updated) throw new NotFoundException(`Page ${id} not found`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'page.updated',
      resourceType: 'page',
      resourceId: id,
      ip,
      userAgent,
      changes,
    });

    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(
    tenantId: string,
    actorId: string,
    id: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Page ${id} not found`);

    const deleted = await this.repo.delete(tenantId, id);
    if (!deleted) throw new NotFoundException(`Page ${id} not found`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'page.deleted',
      resourceType: 'page',
      resourceId: id,
      ip,
      userAgent,
      changes: { slug: existing.slug, locale: existing.locale },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _toStoreDto(page: PageRow): StorePageDto {
    return {
      slug: page.slug,
      title: page.title,
      body: page.body,
      locale: page.locale,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
    };
  }
}
