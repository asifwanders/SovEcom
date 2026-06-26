import { describe, it, expect } from 'vitest';
import {
  parseAndVerifyManifest,
  MODULE_PERMISSION_ALLOWLIST,
  RpcErrorCode,
  EMAIL_TO_MAX,
  EMAIL_SUBJECT_MAX,
  EMAIL_TEXT_MAX,
  EMAIL_HTML_MAX,
} from '../src/index.js';
import type { ModuleEmailMessage, ModuleEmailSendResult } from '../src/index.js';

/**
 * i — the `email:send` capability is part of the public SDK contract: it is in the
 * permission allowlist (so a manifest may DECLARE it), the SDK exposes the message DTO + bounds,
 * and the stable error vocabulary carries RATE_LIMITED for the over-limit refusal.
 */
describe('email:send — SDK contract surface', () => {
  it('email:send is in the module permission allowlist', () => {
    expect(MODULE_PERMISSION_ALLOWLIST).toContain('email:send');
  });

  it('a manifest may DECLARE email:send', () => {
    const m = parseAndVerifyManifest(
      JSON.stringify({
        name: 'notify',
        displayName: 'Back-in-stock notify',
        version: '1.0.0',
        compatibleCore: '^1.0.0',
        permissions: ['email:send'],
      }),
    );
    expect(m.permissions).toContain('email:send');
  });

  it('exposes RATE_LIMITED as a stable error code', () => {
    expect(RpcErrorCode.RATE_LIMITED).toBe('rate_limited');
  });

  it('exposes the message bounds as positive finite constants', () => {
    for (const n of [EMAIL_TO_MAX, EMAIL_SUBJECT_MAX, EMAIL_TEXT_MAX, EMAIL_HTML_MAX]) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  it('the DTO types are structurally what the broker validates', () => {
    // Compile-time shape assertion (no runtime behaviour — the broker is the enforcement point).
    const msg: ModuleEmailMessage = { to: 'a@b.test', subject: 's', text: 't' };
    const res: ModuleEmailSendResult = { queued: true };
    expect(msg.to).toBe('a@b.test');
    expect(res.queued).toBe(true);
  });
});
