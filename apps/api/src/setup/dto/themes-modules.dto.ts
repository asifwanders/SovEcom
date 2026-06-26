/**
 * Setup theme-step + module-step DTOs.
 *
 * `themes/activate` activates the named installed theme (the wizard sends the theme NAME).
 * `modules/install` installs + enables the selected BUILT-IN modules. `moduleIds` is bounded
 * (string slugs, ≤64 entries) at the boundary; the SECURITY gate that ONLY the platform's
 * bundled module ids are installable is enforced server-side against the BUNDLED_MODULES
 * allowlist (in SetupOnboardingService) BEFORE any filesystem/ingest work — the DTO just bounds
 * the input shape, it does not authorise arbitrary names.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ThemeActivateSchema = z.object({ themeId: z.string().trim().min(1).max(64) }).strict();

export class ThemeActivateDto extends createZodDto(ThemeActivateSchema) {}

export const ModulesInstallSchema = z
  .object({ moduleIds: z.array(z.string().trim().min(1).max(128)).max(64) })
  .strict();

export class ModulesInstallDto extends createZodDto(ModulesInstallSchema) {}
