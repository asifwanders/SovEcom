import { describe, it, expect, vi } from 'vitest';
import { defineModule } from '../src/index.js';
import type { ModuleSdk } from '../src/index.js';

const fakeSdk = {} as ModuleSdk;

describe('defineModule', () => {
  it('returns an object exposing the author activate body', () => {
    const activate = vi.fn();
    const mod = defineModule({ activate });
    expect(typeof mod.activate).toBe('function');
  });

  it('forwards the sdk to the author activate body', async () => {
    const activate = vi.fn(async (_sdk: ModuleSdk) => {});
    const mod = defineModule({ activate });
    await mod.activate(fakeSdk);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(fakeSdk);
  });

  it('propagates a sync return / async resolution from the author body', async () => {
    const mod = defineModule({ activate: () => Promise.resolve() });
    await expect(mod.activate(fakeSdk)).resolves.toBeUndefined();
  });

  it('rejects a config whose activate is not a function', () => {
    // @ts-expect-error — author passed a non-function activate
    expect(() => defineModule({ activate: 'nope' })).toThrow(/activate must be a function/);
  });

  it('rejects a config missing activate', () => {
    // @ts-expect-error — author omitted activate
    expect(() => defineModule({})).toThrow(/activate must be a function/);
  });

  it('rejects a non-object config', () => {
    // @ts-expect-error — author passed a non-object config
    expect(() => defineModule(null)).toThrow(/config must be an object/);
  });

  it('produces an object the worker loader would accept (typeof activate === function)', () => {
    const mod = defineModule({ activate: () => {} });
    // Mirror worker-entry.ts's isModule() check.
    expect(typeof mod === 'object' && mod !== null && typeof mod.activate === 'function').toBe(
      true,
    );
  });
});
