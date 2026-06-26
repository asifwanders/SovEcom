/**
 * WebhooksService: subscription CRUD.
 *
 * On create: SSRF-validate the URL, generate a signing secret, store it AEAD-encrypted (AAD = the
 * subscription id, so a copied row fails closed), and return the plaintext secret EXACTLY ONCE.
 * List/get never expose the secret; it is never logged.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { AeadService } from '../auth/crypto/aead.service';
import { WebhookSubscriptionRepository } from './webhook-subscription.repository';
import { assertSafeWebhookUrl } from './ssrf';
import type { WebhookEventName } from './webhook.types';

/** The public (secret-free) view of a subscription. */
export interface PublicSubscription {
  id: string;
  url: string;
  events: WebhookEventName[];
  active: boolean;
  createdAt: Date;
}

export interface CreatedSubscription extends PublicSubscription {
  /** The signing secret — returned ONLY here, at create time. Never again. */
  secret: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly repo: WebhookSubscriptionRepository,
    private readonly aead: AeadService,
  ) {}

  async create(
    tenantId: string,
    input: { url: string; events: WebhookEventName[] },
  ): Promise<CreatedSubscription> {
    await assertSafeWebhookUrl(input.url); // throws BadRequestException on a blocked/invalid URL

    const id = uuidv7();
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const encrypted = this.aead.encrypt(secret, id); // AAD = subscription id

    const row = await this.repo.insert({
      id,
      tenantId,
      url: input.url,
      events: input.events,
      secret: encrypted,
    });
    this.logger.log(`webhook subscription ${id} created (${input.events.length} event(s))`);

    return { ...this.toPublic(row), secret };
  }

  async list(tenantId: string): Promise<PublicSubscription[]> {
    const rows = await this.repo.listForTenant(tenantId);
    return rows.map((r) => this.toPublic(r));
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const removed = await this.repo.deleteById(tenantId, id);
    if (!removed) throw new NotFoundException(`Webhook subscription ${id} not found`);
  }

  private toPublic(row: {
    id: string;
    url: string;
    events: unknown;
    active: boolean;
    createdAt: Date;
  }): PublicSubscription {
    return {
      id: row.id,
      url: row.url,
      events: row.events as WebhookEventName[],
      active: row.active,
      createdAt: row.createdAt,
    };
  }
}
