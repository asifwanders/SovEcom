/**
 * return DTOs. nestjs-zod `.strict`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { returnTypeEnum, returnStatusEnum } from '../../database/schema/_enums';

const returnType = z.enum(returnTypeEnum.enumValues as [string, ...string[]]);
const returnStatus = z.enum(returnStatusEnum.enumValues as [string, ...string[]]);

export const CreateReturnSchema = z
  .object({
    type: returnType,
    items: z
      .array(
        z
          .object({ orderItemId: z.string().uuid(), quantity: z.number().int().positive() })
          .strict(),
      )
      .min(1),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export class CreateReturnDto extends createZodDto(CreateReturnSchema) {}

export const ReturnsQuerySchema = z
  .object({
    status: returnStatus.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
  })
  .strict();
export class ReturnsQueryDto extends createZodDto(ReturnsQuerySchema) {}

export const RejectReturnSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export class RejectReturnDto extends createZodDto(RejectReturnSchema) {}
