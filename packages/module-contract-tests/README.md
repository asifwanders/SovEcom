# @sovecom/module-contract-tests

> README **stub** — the full author guide is forthcoming.

Author-run contract validator for a SovEcom module. Run it against your module directory before
publishing to catch the common mistakes the core would otherwise reject at install time.

```bash
# programmatic
import { runContractChecks } from '@sovecom/module-contract-tests';
const report = runContractChecks('./my-module');
if (!report.ok) process.exit(1);

# CLI
module-contract-tests ./my-module
```

## What it checks

| Check                     | Kind         | What it does                                                                                                                                                       |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manifest valid            | hard         | Reuses the SDK's `parseAndVerifyManifest` (no second validator).                                                                                                   |
| Tables namespaced         | hard         | Every declared table and detected `CREATE TABLE` is `mod_<name>_*`.                                                                                                |
| Permissions sufficient    | hard         | Statically detects used `sdk.*` capabilities; asserts each maps to a declared permission. Flags declared-but-unused permissions as a least-privilege **advisory**. |
| Core-version compatible   | hard         | Reuses the SDK's `assertCoreCompatible`.                                                                                                                           |
| Migration reversibility   | **advisory** | Heuristic reminder — NOT verified.                                                                                                                                 |
| Webhook/event idempotency | **advisory** | Heuristic reminder — NOT verified.                                                                                                                                 |

Hard checks gate the exit code (non-zero on any failure). **Advisory checks never fail the run** —
they are best-effort reminders this suite cannot prove statically, and it never claims otherwise.

### Static permission detection — honest limits

Capability usage is detected with the TypeScript compiler API (no new dependency). It is a
best-effort syntactic scan: usage reached through aliasing (`const s = sdk`), destructuring
(`const { http } = sdk`), or dynamic property access (`sdk[name]`) may be missed. The core broker
enforces permissions at runtime regardless; this check is an author-side convenience.
