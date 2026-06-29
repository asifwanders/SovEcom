/**
 * DTOs for the admin staff-accounts endpoints.
 *
 * Zod + nestjs-zod for runtime validation + automatic Swagger docs.
 * All shapes mirror the frontend contract in the spec (§ CONTRACT).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Allowed roles that may be created or assigned via the admin panel. */
const STAFF_ROLES = ['admin', 'staff'] as const;

/** Body for POST /admin/v1/users */
export const CreateUserSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase(),
    name: z.string().min(1).max(255),
    role: z.enum(STAFF_ROLES),
    password: z.string().min(12).max(1024),
  })
  .strict();

export class CreateUserDto extends createZodDto(CreateUserSchema) {}

/** Body for PATCH /admin/v1/users/:id/role */
export const ChangeRoleSchema = z
  .object({
    role: z.enum(STAFF_ROLES),
  })
  .strict();

export class ChangeRoleDto extends createZodDto(ChangeRoleSchema) {}

/** Query for GET /admin/v1/users */
export const UsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export class UsersQueryDto extends createZodDto(UsersQuerySchema) {}
