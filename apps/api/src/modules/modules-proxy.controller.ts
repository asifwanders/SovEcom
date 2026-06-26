/**
 * module endpoint mounting.
 *
 * Mounts a catch-all under `/{store,admin}/v1/modules/:name/*` and proxies each request to the
 * module's worker via {@link ModuleRuntimeService.handleHttp} (broker `http.handle` RPC). The
 * STORE surface is PUBLIC; the ADMIN surface requires the admin JWT + `modules:use`. Requests are
 * shaped + sanitized here (the module never sees the caller's auth token / cookies / core
 * internals), tenant-scoped (store → default tenant, admin → the JWT tenant), and the worker's
 * (untrusted) response is bounded in the runtime service. 404 if the module isn't enabled.
 *
 * Registered AFTER ModulesAdminController so the management routes (install/list/uninstall) win;
 * the proxy only catches `:name/<subpath>`.
 */
import { All, Controller, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { StoreModuleCustomerAuthGuard } from '../customers/auth/store-module-customer-auth.guard';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { ModuleRuntimeService } from './runtime/module-runtime.service';
import {
  MAX_MODULE_REQUEST_BODY_BYTES,
  type ModuleHttpRequest,
  type ModuleHttpSurface,
} from './runtime/module-http';

/** Request headers never forwarded to a module (auth/session/hop-by-hop). */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-setup-token',
  'x-forwarded-for',
  'x-forwarded-host',
]);

const MODULE_NAME_RE = /^[a-z][a-z0-9-]*$/;

@ApiExcludeController() // dynamic module routes — not part of the core OpenAPI surface
@Controller()
export class ModulesProxyController {
  constructor(
    private readonly runtime: ModuleRuntimeService,
    private readonly storeTenant: StoreTenantService,
  ) {}

  // `@Public()` opts out of the GLOBAL admin JwtAuthGuard; the per-route
  // StoreModuleCustomerAuthGuard then OPTIONALLY verifies a customer JWT if one is presented
  // (valid → req.customer; absent → anonymous, still allowed; bad/expired → 401). Only this
  // verified principal — never client input — reaches the module (see proxy()).
  @Public()
  @UseGuards(StoreModuleCustomerAuthGuard)
  @All('store/v1/modules/:name/*path')
  async store(
    @Param('name') name: string,
    @Param('path') path: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    await this.proxy('store', tenantId, name, path, req, res);
  }

  @RequirePermission(PERMISSIONS.MODULES_USE)
  @All('admin/v1/modules/:name/*path')
  async admin(
    @Param('name') name: string,
    @Param('path') path: string | string[],
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.proxy('admin', user.tenantId, name, path, req, res);
  }

  private async proxy(
    surface: ModuleHttpSurface,
    tenantId: string,
    name: string,
    rawPath: string | string[],
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!MODULE_NAME_RE.test(name)) {
      res.status(404).json({ message: 'module not found' });
      return;
    }
    const subPath = '/' + (Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? ''));
    // The customer principal is sourced EXCLUSIVELY from the guard-verified `req.customer` (set by
    // StoreModuleCustomerAuthGuard from a JWT core verified itself). A client-supplied `customer`
    // in the body/query/headers can NEVER influence this — those never populate `req.customer`, and
    // the raw token is stripped below — so a module cannot be made to trust a spoofed identity.
    const verifiedCustomer = (req as Request & { customer?: AuthenticatedCustomer }).customer;
    const moduleReq: ModuleHttpRequest = {
      surface,
      tenantId,
      method: req.method,
      path: subPath,
      query: req.query as Record<string, string | string[]>,
      headers: sanitizeRequestHeaders(req.headers),
      body: serializeBody(req),
      customer: verifiedCustomer ? { id: verifiedCustomer.id } : undefined,
    };
    // handleHttp throws 404 (NotFoundException) if the module isn't enabled — let it propagate to
    // the global exception filter.
    const result = await this.runtime.handleHttp(name, moduleReq);
    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
    res.send(result.body ?? '');
  }
}

function sanitizeRequestHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

/** Serialize the (already body-parsed) request body to a bounded string for the module. */
function serializeBody(req: Request): string | undefined {
  const b: unknown = req.body;
  if (b === undefined || b === null) return undefined;
  let s: string;
  if (typeof b === 'string') s = b;
  else if (Buffer.isBuffer(b)) s = b.toString('utf8');
  else {
    try {
      s = JSON.stringify(b);
    } catch {
      return undefined;
    }
  }
  if (s === '') return undefined;
  if (Buffer.byteLength(s, 'utf8') > MAX_MODULE_REQUEST_BODY_BYTES) {
    // Too large to proxy — surface as an empty body rather than blow memory; the module sees none.
    return undefined;
  }
  return s;
}
