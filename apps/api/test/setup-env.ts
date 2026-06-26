/**
 * Shared test environment defaults (jest `setupFiles`).
 *
 * Any suite that boots the full `AppModule` (the health integration test, the
 * OpenAPI e2e test) transitively loads `AuthModule`, whose `AeadService` and
 * `TokenService` require `MASTER_KEY` / `JWT_SECRET` at construction time. Pin
 * sane test values here so a suite does not have to plumb env itself.
 *
 * `??=` so an explicitly-provided env (e.g. CI) still wins.
 *
 * IMPORTANT: `MASTER_KEY` MUST decode to the same 32 bytes the auth integration
 * harness uses for `new AeadService(TEST_MASTER_KEY)` (`Buffer.alloc(32, 0x2a)`),
 * otherwise a TOTP secret seeded by that harness would not decrypt under the
 * running app's key. Keep these two in lockstep.
 */
import * as os from 'os';
import * as path from 'path';

process.env.NODE_ENV ??= 'test';
process.env.JWT_SECRET ??= 'integration-jwt-secret-integration-jwt-secret-32+';
process.env.MASTER_KEY ??= Buffer.alloc(32, 0x2a).toString('base64');

// StorageModule: default to a tmp path so the local adapter can
// write its health probe without needing /data/uploads to exist in CI.
process.env.LOCAL_STORAGE_PATH ??= path.join(os.tmpdir(), 'sovecom-test-uploads');
process.env.STORAGE_SIGNING_SECRET ??= 'test-signing-secret';

// ModulesModule: keep the secure tarball ingest well away from the real
// `/data/modules` in CI — extract into a per-run tmp dir instead.
process.env.MODULES_DATA_PATH ??= path.join(os.tmpdir(), 'sovecom-test-modules');

// ThemesModule: same for theme tarball ingest — keep it off the real
// `/data/themes` in CI; extract into a per-run tmp dir instead.
process.env.THEMES_DATA_PATH ??= path.join(os.tmpdir(), 'sovecom-test-themes');
