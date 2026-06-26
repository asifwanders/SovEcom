/**
 * Payments integration harness.
 *
 * Boots the full AppModule against real Postgres + Redis, but overrides the Stripe client seam
 * (STRIPE_CLIENT) with a controllable mock — no live keys, no network (brief §6). Tests drive
 * `stripeMock.*` to shape PaymentIntent/webhook behaviour. `STRIPE_WEBHOOK_SECRET` is set before
 * boot so StripeService is "configured" (it never calls the real SDK — the mock stands in).
 *
 * Reuses the orders/cart seed + reset helpers (re-exported) so payment specs read like the rest.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import Redis from 'ioredis';
import * as schema from '../../../src/database/schema';
import { AppModule } from '../../../src/app.module';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';
import { RedisService } from '../../../src/redis/redis.service';
import {
  VIES_CLIENT,
  type ViesClient,
  type ViesCheckResult,
} from '../../../src/customers/vies/vies.client';
import { STRIPE_CLIENT } from '../../../src/payments/stripe/stripe.client';
import { DEFAULT_TENANT_ID } from '../cart/_cart-harness';

const MIGRATIONS = 'src/database/migrations';

export {
  resetOrderState,
  seedSimpleProduct,
  seedBundleProduct,
  driveCartToCheckoutReady,
  seedAdminAndLogin,
  extractCartTokenCookie,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from '../orders/_orders-harness';

class StubViesClient implements ViesClient {
  async check(_c: string, _v: string): Promise<ViesCheckResult> {
    return { valid: false, name: null, address: null };
  }
}

/** The controllable Stripe mock. Reset + configure per test. */
export const stripeMock = {
  paymentIntents: { create: jest.fn() },
  refunds: { create: jest.fn() },
  customers: { create: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};

export function resetStripeMock(): void {
  stripeMock.paymentIntents.create.mockReset();
  stripeMock.refunds.create.mockReset();
  stripeMock.customers.create.mockReset();
  stripeMock.webhooks.constructEvent.mockReset();
  // Sensible defaults.
  stripeMock.paymentIntents.create.mockResolvedValue({
    id: `pi_${Date.now()}`,
    client_secret: 'cs_test_secret',
    status: 'requires_payment_method',
  });
  stripeMock.customers.create.mockResolvedValue({ id: `cus_${Date.now()}` });
  stripeMock.refunds.create.mockResolvedValue({ id: `re_${Date.now()}`, status: 'succeeded' });
}

export interface PaymentsHarness {
  app: INestApplication;
  client: ReturnType<typeof postgres>;
  db: PostgresJsDatabase<typeof schema>;
  redis: Redis;
  http(): Express.Application;
}

export async function bootPaymentsApp(): Promise<PaymentsHarness> {
  // StripeService reads STRIPE_WEBHOOK_SECRET in its constructor (at app.init) — set it first.
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';

  const client = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(VIES_CLIENT)
    .useValue(new StubViesClient())
    .overrideProvider(STRIPE_CLIENT)
    .useValue(stripeMock)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.use(cookieParser());
  await app.init();

  const redisService = app.get(RedisService);
  await redisService.ping();
  const redis = redisService.client;
  await redis.flushdb();

  const storeTenant = app.get(StoreTenantService, { strict: false }) as unknown as {
    defaultTenantId: string | null;
  };
  storeTenant.defaultTenantId = DEFAULT_TENANT_ID;

  return { app, client, db, redis, http: () => app.getHttpServer() };
}

/** Poll for the invoice issued by the (fire-and-forget) order.paid listener. */
export async function waitForInvoice(
  h: PaymentsHarness,
  orderId: string,
  timeoutMs = 5000,
): Promise<{ invoice_number: string; storage_key: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.client<{ invoice_number: string; storage_key: string | null }[]>`
      select invoice_number, storage_key from invoices where order_id = ${orderId} and type = 'invoice'
    `;
    if (rows.length > 0) return rows[0]!;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}
