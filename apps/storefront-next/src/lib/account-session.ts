/**
 * one-shot cross-component sign-out flag.
 *
 * `logout()` flips the auth context to "guest", which re-renders `AccountGate` and would fire its
 * redirect-to-login effect — racing the explicit "return home" navigation in `AccountNav.onSignOut`
 * (non-deterministic landing: home OR /login). `AccountNav` raises this flag immediately before
 * `logout()`; the gate consumes it when the session flips to guest and SKIPS the login redirect, so
 * the sign-out navigation home wins deterministically. It is a one-shot: reading clears it, so a later
 * genuine guest visit still redirects to login.
 */
let signingOut = false;

/** Mark that the next guest transition is an intentional sign-out (call right before `logout()`). */
export function markSigningOut(): void {
  signingOut = true;
}

/** Read-and-clear the flag. Returns true exactly once after `markSigningOut()`. */
export function consumeSigningOut(): boolean {
  const was = signingOut;
  signingOut = false;
  return was;
}
