/**
 * compliance/configure step DTO.
 *
 * Cookie consent is LOCKED on (RGPD non-negotiable — Plausible-by-default posture);
 * the DTO accepts only `true` and the service hard-pins it regardless. Analytics are
 * opt-in modules: Plausible (privacy-friendly, no PII), and the RGPD-warned GA / Meta
 * integrations (off unless an id/pixel is supplied). No secrets here — just the public
 * tracking ids/markers persisted into `settings.compliance`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ComplianceConfigureSchema = z
  .object({
    /** RGPD: cookie consent is always on; only `true` is accepted. */
    cookieConsent: z.literal(true),
    analytics: z
      .object({
        plausible: z.boolean().optional(),
        /**
         * Plausible `data-domain` — the only analytics id captured at
         * setup (GA/Meta stay admin-only). Allowlist mirrors the service-side parse: hostnames
         * (letters/digits/dot/hyphen) plus comma for Plausible multi-domain. Written through to
         * `settings.analytics.plausibleDomain`, which the storefront actually reads.
         */
        plausibleDomain: z
          .string()
          .trim()
          .min(1)
          .max(253)
          .regex(/^[A-Za-z0-9.,-]+$/)
          .optional(),
        ga: z
          .object({ id: z.string().trim().min(1).max(64) })
          .strict()
          .optional(),
        meta: z
          .object({ pixelId: z.string().trim().min(1).max(64) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export class ComplianceConfigureDto extends createZodDto(ComplianceConfigureSchema) {}
