/**
 * TagsService.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../audit/audit.service';
import { isUniqueViolation } from '../../common/pg-error.util';
import { slugify } from '../products/products.service';
import { TagsRepository } from './tags.repository';
import type { Tag } from '../../database/schema/tags';
import type { CreateTagDto } from './dto/create-tag.dto';
import type { UpdateTagDto } from './dto/update-tag.dto';
import type { StoreTagDto } from './dto/store-tag.dto';

const MAX_SLUG_RETRIES = 20;

@Injectable()
export class TagsService {
  constructor(
    private readonly repo: TagsRepository,
    private readonly audit: AuditService,
  ) {}

  // ── Slug generation ─────────────────────────────────────────────────────────

  async generateUniqueSlug(tenantId: string, base: string, excludeId?: string): Promise<string> {
    const baseSlug = slugify(base);
    if (!(await this.repo.slugExists(tenantId, baseSlug, excludeId))) {
      return baseSlug;
    }
    for (let i = 2; i <= MAX_SLUG_RETRIES; i++) {
      const candidate = `${baseSlug}-${i}`;
      if (!(await this.repo.slugExists(tenantId, candidate, excludeId))) {
        return candidate;
      }
    }
    return `${baseSlug}-${uuidv7().slice(-8)}`;
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateTagDto,
    ip?: string,
    userAgent?: string,
  ): Promise<Tag> {
    const slug = dto.slug
      ? await this.generateUniqueSlug(tenantId, dto.slug)
      : await this.generateUniqueSlug(tenantId, dto.name);

    const id = uuidv7();

    let tag: Tag;
    try {
      tag = await this.repo.insert({ id, tenantId, name: dto.name, slug });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const retrySlug = await this.generateUniqueSlug(tenantId, dto.slug ?? dto.name);
        tag = await this.repo.insert({ id, tenantId, name: dto.name, slug: retrySlug });
      } else {
        throw err;
      }
    }

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'tag.created',
      resourceType: 'tag',
      resourceId: id,
      ip,
      userAgent,
      changes: { name: dto.name, slug },
    });

    return tag;
  }

  // ── List (admin) ────────────────────────────────────────────────────────────

  async adminList(tenantId: string): Promise<Tag[]> {
    return this.repo.findAll(tenantId);
  }

  // ── Get by ID (admin) ───────────────────────────────────────────────────────

  async adminFindById(tenantId: string, id: string): Promise<Tag> {
    const tag = await this.repo.findById(tenantId, id);
    if (!tag) throw new NotFoundException(`Tag ${id} not found`);
    return tag;
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateTagDto,
    ip?: string,
    userAgent?: string,
  ): Promise<Tag> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Tag ${id} not found`);

    let newSlug: string | undefined;
    if (dto.slug && dto.slug !== existing.slug) {
      newSlug = await this.generateUniqueSlug(tenantId, dto.slug, id);
    }

    const changes: Record<string, unknown> = {};
    if (dto.name !== undefined) changes['name'] = dto.name;
    if (newSlug) changes['slug'] = newSlug;

    const updated = await this.repo.update(tenantId, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(newSlug ? { slug: newSlug } : {}),
    });

    if (!updated) throw new NotFoundException(`Tag ${id} not found`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'tag.updated',
      resourceType: 'tag',
      resourceId: id,
      ip,
      userAgent,
      changes,
    });

    return updated;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async delete(
    tenantId: string,
    actorId: string,
    id: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const existing = await this.repo.findById(tenantId, id);
    if (!existing) throw new NotFoundException(`Tag ${id} not found`);

    const deleted = await this.repo.hardDelete(tenantId, id);
    if (!deleted) throw new NotFoundException(`Tag ${id} not found`);

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId,
      action: 'tag.deleted',
      resourceType: 'tag',
      resourceId: id,
      ip,
      userAgent,
      changes: { name: existing.name },
    });
  }

  // ── Store endpoints ─────────────────────────────────────────────────────────

  async storeList(tenantId: string): Promise<StoreTagDto[]> {
    const tags = await this.repo.findAll(tenantId);
    return tags.map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
  }
}
