/**
 * COMPILE-TIME type-conformance guard.
 *
 * This file has no runtime assertions and no tests; it exists ONLY to fail `tsc --noEmit` (the
 * CI typecheck) if the in-tree broker ever drifts from the published `@sovecom/module-sdk`
 * contract. It is the SDK-seam analogue of the OpenAPI drift guard: one type
 * definition, consumed by both sides, with a build-time proof they still agree.
 *
 * It is intentionally NOT a `*.spec.ts` (jest's testRegex skips it) — its only job is to be
 * type-checked. The `_` names are deliberately unused (eslint allows the `_` prefix).
 */
import { createModuleSdk } from './worker-sdk';
import type { ModuleSdk } from '@sovecom/module-sdk';
import type { RpcPeer } from './rpc';

// 1. The broker's createModuleSdk return type must SATISFY the exported ModuleSdk contract.
//    If the broker narrows/changes a method shape, this `satisfies` fails to compile.
declare const _peer: RpcPeer;
const _brokerSdk = createModuleSdk(_peer) satisfies ModuleSdk;

// 2. And, symmetrically, the broker's value must be ASSIGNABLE to the contract type — so the
//    broker cannot DROP a capability the contract promises authors.
const _asContract: ModuleSdk = createModuleSdk(_peer);

// 3. ReturnType identity: the inferred broker return must be assignable to ModuleSdk in BOTH
//    directions would over-constrain (the broker may legitimately be a structural subtype), so we
//    only assert the broker → contract direction. Reference the bindings so they are not elided.
export type _BrokerReturn = ReturnType<typeof createModuleSdk>;
void _brokerSdk;
void _asContract;
