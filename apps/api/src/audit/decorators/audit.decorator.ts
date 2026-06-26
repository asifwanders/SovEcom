/**
 * `@Audit(action)` decorator.
 *
 * Marks a mutating admin route for coverage by the global `AuditInterceptor`.
 * ONLY apply this to routes under /admin/v1 that do NOT already call
 * `AuditService.record` in their service layer. Applying it to a self-auditing
 * route would write TWO rows — a double-row that corrupts the audit trail.
 *
 * The interceptor checks for this metadata before writing; if absent the
 * interceptor is a no-op for that route.
 *
 * Convention: `action` follows `resource.verb` notation, e.g. `'image.uploaded'`.
 */
import { SetMetadata, CustomDecorator } from '@nestjs/common';

/** Unique metadata key — a Symbol prevents string-keyed spoofing. */
export const AUDIT_ACTION_KEY = Symbol('audit:action');

/**
 * Tag a handler with the audit action name that `AuditInterceptor` should record
 * on a successful (2xx) response.
 */
export const Audit = (action: string): CustomDecorator<symbol> =>
  SetMetadata(AUDIT_ACTION_KEY, action);
