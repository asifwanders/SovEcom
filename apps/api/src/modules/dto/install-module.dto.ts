/**
 * install-request validation.
 *
 * The ONLY client-supplied trust input to `POST /admin/v1/modules/install` (besides the
 * tarball itself) is `grantedPermissions`: the admin's approved subset of the module's
 * requested capabilities. It arrives as a MULTIPART form field, so it's a string — a JSON
 * array literal (`["read:products"]`). We parse + validate it is a `string[]` here; the
 * SERVICE then intersects it with the re-verified manifest (default-deny). This function
 * does NOT decide what is allowed — it only guarantees a well-typed list reaches the service.
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** A bounded list of permission STRINGS — content is validated downstream by the intersection. */
const grantedPermissionsSchema = z.array(z.string().min(1).max(128)).max(64);

/**
 * Coerce the multipart `grantedPermissions` field to a validated `string[]`.
 *   - absent / empty → `[]` (a permissionless install is valid: grant nothing).
 *   - a JSON string  → parsed, then shape-checked.
 *   - an array       → shape-checked directly (defensive, in case a parser pre-decoded it).
 * Anything else (a number, an object, a non-string array element, malformed JSON) → 400.
 */
export function parseGrantedPermissions(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];

  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        'grantedPermissions must be a JSON array of permission strings',
      );
    }
  }

  const result = grantedPermissionsSchema.safeParse(candidate);
  if (!result.success) {
    throw new BadRequestException('grantedPermissions must be an array of permission strings');
  }
  return result.data;
}
