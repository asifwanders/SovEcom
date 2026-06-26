# @sovecom/module-sdk

The public, author-facing SDK for building [SovEcom](../../README.md) modules.

> **Status:** stub. This package is `private` and consumed in-repo via the pnpm workspace; it is
> not yet published to npm. This README is a placeholder — the full author guide is forthcoming.

## What it is

This package is the **single source of truth** for the SovEcom module contract: the capability
interfaces the core broker enforces, the data-transfer types it returns, the manifest validators, and
the author ergonomics. The core runtime (`apps/api`) imports these same definitions, so the published
contract can never drift from what the broker actually enforces.

It is a **contract package, not a code-execution surface**. All permission / tenant / refusal
enforcement lives in the core-side broker; nothing here can disable or weaken it.

## Authoring a module

```ts
import { defineModule, defineSlots, createNamespacedTable } from '@sovecom/module-sdk';

export default defineModule({
  async activate(sdk) {
    // `sdk` is the capability object: store, admin, tables, events, http, serve.
    const products = await sdk.store.products.list({ limit: 20 });

    await sdk.events.on('order.paid', async (payload) => {
      // react to a core event
    });

    sdk.serve((req) => ({ status: 200, body: JSON.stringify({ ok: true }) }));
  },
});

// Declarative slot metadata for the manifest (NOT a runtime call):
export const slots = defineSlots([{ slot: 'product-page', component: 'my-widget' }]);

// DDL/migration helper — enforces the `mod_<name>_` table prefix:
const itemsTable = createNamespacedTable('my-module', 'items'); // → 'mod_my-module_items'
```

## Exports

- `defineModule(config)` — wraps your `activate(sdk)` body into the `{ activate }` object the
  worker loader expects.
- `defineSlots(entries)` — typed, validated builder for the manifest's declarative `slots` array.
- `createNamespacedTable(name, suffix)` — DDL identifier helper enforcing the `mod_<name>_` prefix
  (it returns a table NAME; it is not a live query builder).
- Capability types: `ModuleSdk`, `StoreClient`, `AdminClient`, `HttpClient`, `TablesClient`,
  `EventsClient`.
- DTOs: `ModuleProductDto`, `ModuleCategoryDto`, `ModuleOrderDto`, `ModuleCustomerDto`,
  `ListQuery`, `ListResult`.
- HTTP contract: `ModuleHttpRequest`, `ModuleHttpResponse`, `ModuleHttpHandler`,
  `ModuleHttpSurface`.
- Manifest types + validators: `ModuleManifest`, `ModuleSlotEntry`, `ModulePermission`,
  `MODULE_PERMISSION_ALLOWLIST`, `moduleManifestSchema`, `parseAndVerifyManifest`,
  `assertCoreCompatible`, `CORE_API_VERSION`.
- `RpcErrorCode` — stable broker error codes for author error-handling.

## License

AGPL-3.0 (core). See the repository root.
