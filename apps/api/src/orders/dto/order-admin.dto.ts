/**
 * Admin order DTOs (nestjs-zod `.strict`).
 *
 * - OrderListQueryDto: offset pagination + optional status / customerId facets.
 * - TransitionOrderDto: the target status + an optional free-text note for the
 *   `order_status_history` row. `to` is validated against the order_status enum;
 *   edge legality is enforced by the state machine, not the DTO.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { orderStatusEnum } from '../../database/schema/_enums';

const orderStatus = z.enum(orderStatusEnum.enumValues as [string, ...string[]]);

export const OrderListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
    status: orderStatus.optional(),
    customerId: z.string().uuid().optional(),
  })
  .strict();
export class OrderListQueryDto extends createZodDto(OrderListQuerySchema) {}

export const TransitionOrderSchema = z
  .object({
    to: orderStatus,
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export class TransitionOrderDto extends createZodDto(TransitionOrderSchema) {}
