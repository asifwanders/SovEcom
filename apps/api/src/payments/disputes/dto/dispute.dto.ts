/**
 * disputes query DTO. nestjs-zod `.strict`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { disputeStatusEnum } from '../../../database/schema/_enums';

const disputeStatus = z.enum(disputeStatusEnum.enumValues as [string, ...string[]]);

export const DisputesQuerySchema = z
  .object({
    status: disputeStatus.optional(),
    orderId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
  })
  .strict();
export class DisputesQueryDto extends createZodDto(DisputesQuerySchema) {}
