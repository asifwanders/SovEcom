/**
 * Setup-token consume race: N simultaneous `consumeToken(sameToken)` against ONE live
 * token must yield EXACTLY ONE winner.
 *
 * The single-statement `UPDATE setup_tokens SET used_at = now() WHERE token_hash=$1
 * AND used_at IS NULL AND expires_at > now() RETURNING id` lets Postgres serialise
 * the row write: only the first transaction to claim the row sees `used_at IS NULL`,
 * so it alone gets a row (→ true); the rest match zero rows (→ false). This is the
 * token-layer guarantee behind concurrent setup attempts: only one succeeds. The
 * consume and `installed=true` flip are wrapped in one transaction.
 *
 * No plaintext token is logged (it lives only in this test's local variable).
 */
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  runConcurrently,
  type ConcurrencyHarness,
} from './harness';
import { SetupTokenService } from '../../src/setup/setup-token.service';

let h: ConcurrencyHarness;
let tokens: SetupTokenService;

beforeAll(async () => {
  h = await bootConcurrencyApp();
  tokens = h.app.get(SetupTokenService, { strict: false });
}, 60_000);
afterAll(async () => {
  await teardownConcurrencyApp(h);
});
beforeEach(async () => {
  await resetConcurrencyState(h);
  await h.client.unsafe(`TRUNCATE TABLE setup_tokens RESTART IDENTITY`);
});

describe('Setup token consume race', () => {
  it('N concurrent consumeToken(sameToken) → exactly ONE true, the rest false', async () => {
    const N = 30;
    const token = await tokens.generateToken();

    const { fulfilled, rejected } = await runConcurrently(
      N,
      () => tokens.consumeToken(token),
      'setup-token consume',
    );

    // No task should throw — losers resolve to `false`, not reject.
    expect(rejected).toHaveLength(0);
    const wins = fulfilled.filter((r) => r.value === true).length;
    const losses = fulfilled.filter((r) => r.value === false).length;
    expect(wins).toBe(1);
    expect(losses).toBe(N - 1);

    // DB state: the single row is now used; no live token remains.
    const live = await h.client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is null and expires_at > now()
    `;
    expect(Number(live[0].c)).toBe(0);
    const used = await h.client<{ c: number }[]>`
      select count(*)::int as c from setup_tokens where used_at is not null
    `;
    expect(Number(used[0].c)).toBe(1);
  });
});
