/**
 * notify-back-in-stock — slot DATA integration test. Verifies the module's `GET /slot` body validates
 * to a `submit-form` descriptor via the theme-sdk validator, and that the own-mount action path
 * validates against the strict action-path schema.
 */
import { describe, it, expect } from 'vitest';
import { parseWidget } from '@sovecom/theme-sdk';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { NotifyRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables } from './_mock-sdk';

function makeDeps(): HandlerDeps {
  return {
    repo: new NotifyRepository(new FakeTables()),
    settings: resolveSettings(),
  };
}

const slotReq = (query: Record<string, string>): ModuleHttpRequest => ({
  surface: 'store',
  tenantId: 't1',
  method: 'GET',
  path: '/slot',
  query,
  headers: {},
});

describe('notify-back-in-stock slot — parseWidget integration', () => {
  it('GET /slot body parseWidget-validates to a submit-form (own-mount action path passes C1)', async () => {
    const res = await handleRequest(
      slotReq({ slot: 'product-detail-actions', route: 'variant-1' }),
      makeDeps(),
    );
    expect(res.status).toBe(200);
    const widget = parseWidget(res.body);
    expect(widget).not.toBeNull();
    expect(widget?.type).toBe('submit-form');
    if (widget?.type === 'submit-form') {
      expect(widget.props.action.path).toMatch(/^\/store\/v1\/modules\/notify-back-in-stock\//);
      expect(widget.props.fields.some((f) => f.kind === 'email')).toBe(true);
    }
  });

  it('an unknown-slot 204 decline produces no parseWidget-valid descriptor', async () => {
    const res = await handleRequest(slotReq({ slot: 'unknown', route: 'variant-1' }), makeDeps());
    expect(res.status).toBe(204);
    expect(parseWidget(res.body ?? '')).toBeNull();
  });
});
