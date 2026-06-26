import { describe, it, expect } from 'vitest';
import { markSigningOut, consumeSigningOut } from './account-session';

describe('account-session sign-out flag', () => {
  it('is false by default', () => {
    expect(consumeSigningOut()).toBe(false);
  });

  it('is a one-shot: true exactly once after markSigningOut, then false', () => {
    markSigningOut();
    expect(consumeSigningOut()).toBe(true);
    expect(consumeSigningOut()).toBe(false);
  });
});
