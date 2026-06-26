/**
 * payments step DTO.
 *
 * `methods` is the set of enabled payment methods (persisted into
 * `tenants.settings.payments`). `stripe` carries the Stripe key blob, AEAD-encrypted
 * into `tenant_secrets` under kind `stripe` — the keys are never persisted in
 * settings, never logged, never echoed. All fields bounded at the boundary.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Stripe credential blob (encrypted at rest under kind `stripe`). */
export const StripeKeysSchema = z
  .object({
    secretKey: z.string().min(1).max(512),
    publishableKey: z.string().min(1).max(512),
    webhookSecret: z.string().max(512).optional(),
  })
  .strict();

export const PaymentsConfigureSchema = z
  .object({
    /** Enabled method identifiers, e.g. `['stripe','manual']`. Bounded list. */
    methods: z.array(z.string().min(1).max(64)).max(32),
    stripe: StripeKeysSchema.optional(),
  })
  .strict();

export class PaymentsConfigureDto extends createZodDto(PaymentsConfigureSchema) {}
