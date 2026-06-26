/**
 * DisputesService: the admin read surface over disputes + the one
 * write action (clear the fulfillment freeze). Won/lost RESOLUTION stays webhook-driven (Stripe is
 * the source of truth — never a manual status flip here).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DisputeRepository, type DisputeListResult } from '../dispute.repository';
import { OrderRepository } from '../../orders/order.repository';
import type { Dispute } from '../../database/schema/disputes';
import type { DisputeStatus } from './dispute.types';

@Injectable()
export class DisputesService {
  constructor(
    private readonly disputes: DisputeRepository,
    private readonly orders: OrderRepository,
  ) {}

  list(
    tenantId: string,
    opts: { status?: DisputeStatus; orderId?: string; page: number; pageSize: number },
  ): Promise<DisputeListResult> {
    return this.disputes.list(tenantId, opts);
  }

  /**
   * Clear the fulfillment freeze a dispute placed on its order. The webhook freezes on open
   * but never auto-unfreezes. This is an explicit admin action. Tenant-scoped; 404 if the
   * dispute is unknown. Audited at the controller.
   */
  async unfreezeFulfillment(tenantId: string, disputeId: string): Promise<{ orderId: string }> {
    const dispute = await this.disputes.findById(tenantId, disputeId);
    if (!dispute) throw new NotFoundException(`Dispute ${disputeId} not found`);
    await this.orders.setFulfillmentFrozen(tenantId, dispute.orderId, false);
    return { orderId: dispute.orderId };
  }

  findById(tenantId: string, id: string): Promise<Dispute | null> {
    return this.disputes.findById(tenantId, id);
  }
}
