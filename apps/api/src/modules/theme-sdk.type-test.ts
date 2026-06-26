/**
 * COMPILE-TIME type-conformance guard.
 *
 * This file has no runtime assertions and no tests; it exists ONLY to fail `tsc --noEmit` (the
 * CI typecheck) if the in-tree store/slot view types ever drift from the published
 * `@sovecom/theme-sdk` store contract. It is the SDK-seam analogue of the OpenAPI drift guard
 * and the module conformance check: one type definition, consumed by
 * both sides, with a build-time proof they still agree.
 *
 * It is intentionally NOT a `*.spec.ts` (jest's testRegex skips it) — its only job is to be
 * type-checked. The `_` names are deliberately unused (eslint allows the `_` prefix).
 */
import type { ActiveTheme, SlotMap } from '@sovecom/theme-sdk';
import type { ActiveThemeView } from './themes.service';
// The REAL store slot map the storefront controller returns (GET /store/v1/slots) — imported from
// the controller itself, NOT a hand-copy. If the controller's `StoreSlotMap` ever diverges from the
// exported `SlotMap` contract, the assignment below fails to compile (this is the actual seam).
import type { StoreSlotMap } from './slots.controller.store';

// 1. The in-tree active-theme view must be ASSIGNABLE to the exported ActiveTheme contract — so
//    the store endpoint can never return a shape the SDK does not promise the storefront.
declare const _activeView: ActiveThemeView;
const _activeAsContract: ActiveTheme = _activeView;

// 2. And the in-tree store slot map must be ASSIGNABLE to the exported SlotMap contract.
declare const _storeMap: StoreSlotMap;
const _mapAsContract: SlotMap = _storeMap;

// Reference the bindings so they are not elided.
void _activeAsContract;
void _mapAsContract;
