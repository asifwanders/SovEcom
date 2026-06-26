/**
 * email-log query DTO. nestjs-zod `.strict`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { emailTypeEnum, emailStatusEnum } from '../../database/schema/_enums';

const emailType = z.enum(emailTypeEnum.enumValues as [string, ...string[]]);
const emailStatus = z.enum(emailStatusEnum.enumValues as [string, ...string[]]);

export const EmailLogsQuerySchema = z
  .object({
    status: emailStatus.optional(),
    type: emailType.optional(),
    orderId: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
  })
  .strict();
export class EmailLogsQueryDto extends createZodDto(EmailLogsQuerySchema) {}
