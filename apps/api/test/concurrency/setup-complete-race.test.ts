/**
 * /complete consume+flip race: N simultaneous
 * `SetupInstallService.complete(token)` against ONE live token + satisfied preconditions
 * must yield EXACTLY ONE token consume AND EXACTLY ONE install flip (no double).
 *
 * The atomic single-statement token claim
 *   `UPDATE setup_tokens SET used_at = now() WHERE token_hash=$1 AND used_at IS NULL
 *      AND expires_at > now() RETURNING id`
 * rides the SAME transaction as the `installed=true` upsert, so the lone winner
 * consumes-and-installs as one unit; the losers claim zero rows, do NOT flip, and (since
 * the system IS installed by then) report the idempotent `{installed:true}` end-state.
 * Net effect: one token used, installed=true set once — only one succeeds for the
 * final install step.
 *
 * No plaintext token is logged (it lives only in this test's local variable).
 */
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  runConcurrently,
  DEFAULT_TENANT_ID,
  newId,
  type ConcurrencyHarness,
} from './harness';
import { SetupTokenService } from '../../src/setup/setup-token.service';
import { SetupInstallService } from '../../src/setup/setup-install.service';
import { TenantSettingsService } from '../../src/taxes/tenant-settings.service';

let h: ConcurrencyHarness;
let tokens: SetupTokenService;
let install: SetupInstallService;
let settings: TenantSettingsService;

beforeAll(async () => {
  h = await bootConcurrencyApp();
  tokens = h.app.get(SetupTokenService, { strict: false });
  install = h.app.get(SetupInstallService, { strict: false });
  settings = h.app.get(TenantSettingsService, { strict: false });
}, 60_000);

afterAll(async () => {
  await teardownConcurrencyApp(h);
});

beforeEach(async () => {
  await resetConcurrencyState(h);
  await h.client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
  await h.client.unsafe(`DELETE FROM system_state WHERE key IN ('installed','admin_configured')`);
  settings.invalidate(DEFAULT_TENANT_ID);
});

describe('Setup /complete consume+flip race', () => {
  it('N concurrent complete(sameToken) → exactly ONE token used + ONE install flip', async () => {
    const N = 20;
    const token = await tokens.generateToken();

    // Satisfy the preconditions: an owner shell + admin_configured marker + a tax profile.
    await h.client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${newId()}, ${DEFAULT_TENANT_ID}, ${'owner@race.test'},
              ${'$argon2id$v=19$m=65536,t=3,p=4$c2VlZHNhbHQ$bm90LWEtcmVhbC1oYXNo'},
              ${'Owner'}, ${'owner'})
    `;
    await h.client`
      insert into system_state (key, value) values ('admin_configured', to_jsonb(true))
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    // Non-EU business so tax_mode='none' satisfies the precondition (business country set).
    await settings.updateOnboardingProfile(DEFAULT_TENANT_ID, {
      businessCountry: 'US',
      defaultCurrency: 'USD',
    });
    settings.invalidate(DEFAULT_TENANT_ID);

    const { fulfilled, rejected } = await runConcurrently(
      N,
      () => install.complete(DEFAULT_TENANT_ID, token),
      'setup-complete consume+flip',
    );

    // Every task resolves to the idempotent success shape — losers see installed=true.
    expect(rejected).toHaveLength(0);
    expect(fulfilled.every((r) => r.value.installed === true)).toBe(true);

    // EXACTLY ONE token consumed.
    const used = await h.client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is not null`;
    expect(Number(used[0].c)).toBe(1);
    const live = await h.client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is null and expires_at > now()`;
    expect(Number(live[0].c)).toBe(0);

    // installed flipped exactly once (a single row, value true).
    const installed = await h.client<{ value: boolean }[]>`
      select value from system_state where key = 'installed'`;
    expect(installed).toHaveLength(1);
    expect(installed[0].value).toBe(true);
  });
});
