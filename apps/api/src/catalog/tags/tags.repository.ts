/**
 * TagsRepository.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, asc } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { tags, type Tag, type NewTag } from '../../database/schema/tags';

@Injectable()
export class TagsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(tenantId: string, id: string): Promise<Tag | null> {
    const rows = await this.db.db
      .select()
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.tenantId, tenantId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findAll(tenantId: string): Promise<Tag[]> {
    return this.db.db
      .select()
      .from(tags)
      .where(eq(tags.tenantId, tenantId))
      .orderBy(asc(tags.name));
  }

  async slugExists(tenantId: string, slug: string, excludeId?: string): Promise<boolean> {
    const rows = await this.db.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.slug, slug)))
      .limit(1);
    if (rows.length === 0) return false;
    if (excludeId && rows[0]!.id === excludeId) return false;
    return true;
  }

  async insert(value: NewTag): Promise<Tag> {
    const rows = await this.db.db.insert(tags).values(value).returning();
    return rows[0]!;
  }

  async update(tenantId: string, id: string, patch: Partial<NewTag>): Promise<Tag | null> {
    const rows = await this.db.db
      .update(tags)
      .set(patch)
      .where(and(eq(tags.id, id), eq(tags.tenantId, tenantId)))
      .returning();
    return rows[0] ?? null;
  }

  async hardDelete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.tenantId, tenantId)))
      .returning({ id: tags.id });
    return rows.length > 0;
  }
}
