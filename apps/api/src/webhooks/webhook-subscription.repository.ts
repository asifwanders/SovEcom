/**
 * WebhookSubscriptionRepository. Tenant-scoped access to
 * `webhook_subscriptions`. The `secret` column is ciphertext; this layer never decrypts.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  webhookSubscriptions,
  type WebhookSubscription,
  type NewWebhookSubscription,
} from '../database/schema/webhook_subscriptions';

@Injectable()
export class WebhookSubscriptionRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async insert(values: NewWebhookSubscription): Promise<WebhookSubscription> {
    const [row] = await this.db.insert(webhookSubscriptions).values(values).returning();
    return row!;
  }

  async findById(tenantId: string, id: string): Promise<WebhookSubscription | null> {
    const [row] = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.tenantId, tenantId), eq(webhookSubscriptions.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** All subscriptions for the tenant (admin list, newest first). */
  async listForTenant(tenantId: string): Promise<WebhookSubscription[]> {
    return this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.tenantId, tenantId))
      .orderBy(desc(webhookSubscriptions.createdAt));
  }

  /** Active subscriptions for the tenant (fan-out). */
  async listActiveForTenant(tenantId: string): Promise<WebhookSubscription[]> {
    return this.db
      .select()
      .from(webhookSubscriptions)
      .where(
        and(eq(webhookSubscriptions.tenantId, tenantId), eq(webhookSubscriptions.active, true)),
      );
  }

  /** Hard-delete a subscription (cascades its deliveries). Returns true if a row was removed. */
  async deleteById(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.tenantId, tenantId), eq(webhookSubscriptions.id, id)))
      .returning({ id: webhookSubscriptions.id });
    return rows.length === 1;
  }
}
