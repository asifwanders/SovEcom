/**
 * SetupBootService (SECURITY-CRITICAL).
 *
 * On application bootstrap, if the system is NOT installed:
 *   (a) supersede any prior unused/unexpired tokens (so only the latest is live),
 *   (b) mint ONE fresh setup token (24h TTL), and
 *   (c) print a prominent multi-line stdout banner with the PLAINTEXT token + the
 *       `/setup` URL + the 24h note.
 *
 * This banner is the ONE and ONLY place the plaintext token is ever emitted
 *. A container restart while still not-installed regenerates a fresh
 * token and invalidates the prior one. Installed ⇒ nothing happens (no token, no
 * banner).
 *
 * Like {@link CartFlushService}, the AUTOMATIC bootstrap is suppressed under
 * `NODE_ENV=test`: every integration suite boots the full AppModule, and an
 * unconditional token-mint + banner-to-stdout on each boot would spam test output
 * with plaintext tokens and create nondeterministic `setup_tokens` rows. Tests
 * drive {@link runBootSequence} explicitly after staging the `installed` flag.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SetupStateService } from './setup-state.service';
import { SetupTokenService } from './setup-token.service';

@Injectable()
export class SetupBootService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupBootService.name);

  constructor(
    private readonly state: SetupStateService,
    private readonly tokens: SetupTokenService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Suppress the automatic mint+banner under tests (see class doc). Integration
    // tests call runBootSequence() directly with a controlled `installed` flag.
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    await this.runBootSequence();
  }

  /**
   * The real boot logic, callable directly by tests. If already installed, does
   * nothing. Otherwise supersedes prior tokens, mints a new one, and prints the
   * banner. A failure here must NOT crash the app (logged, swallowed) — the API
   * stays up so an operator can still reach `GET /setup/v1/status`.
   */
  async runBootSequence(): Promise<void> {
    try {
      if (await this.state.isInstalled()) {
        return;
      }
      await this.tokens.supersedeUnusedTokens();
      const token = await this.tokens.generateToken();
      // Print the plaintext banner everywhere EXCEPT tests: integration suites
      // call runBootSequence() to assert token MINTING, and spraying real
      // plaintext tokens across CI logs (even though they're throwaway) is noise
      // and an own-goal for "no token leak" log hygiene.
      if (process.env.NODE_ENV !== 'test') {
        SetupBootService.printBanner(token);
      }
    } catch (err) {
      this.logger.error(
        `Setup boot sequence failed; the API is up but no setup token was issued. ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Print the first-boot banner to stdout. VERY visible by design: clear
   * separators + blank lines around the plaintext token. This is the SOLE
   * emission of the plaintext token.
   */
  private static printBanner(token: string): void {
    const setupUrl = process.env.SETUP_URL ?? 'http://YOUR_HOST/setup';
    const line = '═'.repeat(63);
    /* eslint-disable no-console */
    console.log('\n');
    console.log(line);
    console.log('  SovEcom is not yet configured.');
    console.log(`  Open the setup wizard at: ${setupUrl}`);
    console.log('  Enter this one-time setup token:');
    console.log('');
    console.log(`     ${token}`);
    console.log('');
    console.log('  This token will expire in 24 hours and can be used once.');
    console.log('  Regenerate it by restarting the container if needed.');
    console.log(line);
    console.log('\n');
    /* eslint-enable no-console */
  }
}
