# @sovecom/theme-sdk

The public, author-facing SDK for building [SovEcom](../../README.md) themes.

> **Status:** stub. This package is `private` and consumed in-repo via the pnpm workspace; it is
> not yet published to npm. This README is a placeholder — the full author guide is forthcoming.

## What it is

This package is the **single source of truth** for the SovEcom theme **manifest** contract: the
`sovecom.theme.json` schema, its validator, the byte cap + semver gate, and the author ergonomics.
The core runtime (`apps/api`) imports these same definitions, so the published contract can never
drift from what the core enforces at install time.

A theme is a **declarative asset**: there is **no `activate`, no worker, no runtime entrypoint, no
capabilities, no namespaced tables**. So this package exports the manifest contract, author-time
validation/typing helpers, and the two store-contract types a storefront reads — nothing executable.
The shared core-API primitives (`CORE_API_VERSION`, `assertCoreCompatible`, `MANIFEST_MAX_BYTES`)
are reused from `@sovecom/module-sdk` so both SDKs gate against one core version.

## Authoring a theme

```ts
import { defineTheme, defineThemeSlots, defineThemeSettings } from '@sovecom/theme-sdk';

// defineTheme validates the config and returns the typed, validated manifest OBJECT
// (NOT an `{ activate }` entry — a theme has no runtime body):
export default defineTheme({
  name: 'aurora',
  displayName: 'Aurora',
  version: '1.0.0',
  compatibleCore: '^1.0.0',
  slots: defineThemeSlots(['product-page', 'cart-drawer']),
  settingsSchema: './settings.schema.json', // path stays opaque; never read here
});

// Optional: type your theme's default settings shape (pure compile-time helper):
export const defaults = defineThemeSettings({ accentColor: '#6c5ce7', showBadges: true });
```

## Exports

- `defineTheme(config)` — validates the config and returns the typed, validated `ThemeManifest`
  object. A theme has no runtime entrypoint, so it returns a manifest, not an `{ activate }`.
- `defineThemeSlots(slots)` — typed, validated builder for the manifest's declarative slot-slug
  array (lowercase slugs, no duplicates).
- `defineThemeSettings(defaults)` — pure compile-time helper to type the author's settings object.
- Manifest types + validators: `ThemeManifest`, `themeManifestSchema`, `parseAndVerifyThemeManifest`,
  `THEME_NAME_RE`, `SLOT_SLUG_RE`.
- Shared core-API primitives (re-exported from `@sovecom/module-sdk`): `CORE_API_VERSION`,
  `assertCoreCompatible`, `MANIFEST_MAX_BYTES`.
- Store-contract types (consumed by the storefront): `ActiveTheme` (`{ name, version, settings }`),
  `SlotMap` (`Record<slot, { module, component }>`), `SlotBinding`.

## License

MIT. A theme is derivative of the MIT reference storefront across the HTTP API boundary, so this
SDK — distinct from the AGPL-3.0 core and the AGPL `@sovecom/module-sdk` — is MIT. See the
`LICENSE` file in this package.
