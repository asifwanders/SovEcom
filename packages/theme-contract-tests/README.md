# @sovecom/theme-contract-tests

> README **stub** — the full author guide is forthcoming.

Author-run contract validator for a SovEcom theme. Run it against your theme directory before
publishing to catch the common mistakes the core would otherwise reject at install time.

```bash
# programmatic
import { runThemeContractChecks } from '@sovecom/theme-contract-tests';
const report = runThemeContractChecks('./my-theme');
if (!report.ok) process.exit(1);

# CLI
theme-contract-tests ./my-theme
```

## What it checks

| Check                   | Kind | What it does                                                          |
| ----------------------- | ---- | --------------------------------------------------------------------- |
| Manifest valid          | hard | Reuses the SDK's `parseAndVerifyThemeManifest` (no second validator). |
| Core-version compatible | hard | Reuses the SDK's `assertCoreCompatible`.                              |
| Slots are valid slugs   | hard | Every declared slot matches the SDK's `SLOT_SLUG_RE`.                 |
| LICENSE is MIT          | hard | Reads `LICENSE`; asserts it is the MIT License and NOT the AGPL.      |

A theme is a declarative ASSET: NO code, NO permissions, NO namespaced tables.
So — unlike `@sovecom/module-contract-tests` — there is **no permission-sufficiency check, no source
scan, and no advisory heuristics**: every check is HARD. Hard checks gate the exit code (non-zero on
any failure). The validator never executes theme code (a theme has none).

### The MIT license boundary

The LICENSE check is the load-bearing difference from the module side: a theme is derivative of the
MIT reference storefront across the HTTP API boundary, so its `LICENSE` must be MIT — not the AGPL
the core and modules carry. Getting this wrong locks out commercial theme creators. The check
normalises whitespace, requires the canonical MIT permission grant + "as is" disclaimer, and
explicitly rejects the AGPL title.
