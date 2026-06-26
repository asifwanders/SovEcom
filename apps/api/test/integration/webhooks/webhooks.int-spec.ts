/**
 * Outbound webhooks integration. Full AppModule, real Postgres, a LOCAL
 * http receiver on 127.0.0.1 (so `WEBHOOK_ALLOW_PRIVATE_HOSTS`/`WEBHOOK_ALLOW_INSECURE` are set for
 * the suite). Covers: fan-out → delivery + verifiable HMAC signature; tenant isolation; retry →
 * backoff → exhausted + admin retry-from-failure; SSRF rejection at create; secret returned once +
 * never listed + ciphertext at rest; permissions (settings:read/write).
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  bootPaymentsApp,
  resetOrderState,
  resetStripeMock,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  seedAdminAndLogin,
  type PaymentsHarness,
} from '../payments/_payments-harness';
import { truncateWithRetry } from '../cart/_cart-harness';
import { WebhookDeliveryService } from '../../../src/webhooks/webhook-delivery.service';
import { computeSignature } from '../../../src/webhooks/webhook-signer';

let h: PaymentsHarness;
let server: http.Server;
let port: number;
let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let nextStatus = 200;
let customResponder: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;

beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true';
  process.env.WEBHOOK_ALLOW_INSECURE = 'true';
  h = await bootPaymentsApp();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      if (customResponder) {
        customResponder(req, res);
        return;
      }
      res.writeHead(nextStatus);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await h.app.close();
  await h.client.end();
  delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
  delete process.env.WEBHOOK_ALLOW_INSECURE;
});

beforeEach(async () => {
  await resetOrderState(h);
  await truncateWithRetry(
    h,
    'TRUNCATE TABLE webhook_deliveries, webhook_subscriptions RESTART IDENTITY CASCADE',
  );
  await h.redis.flushdb();
  resetStripeMock();
  received = [];
  nextStatus = 200;
  customResponder = null;
});

const hookUrl = (path = '/hook') => `http://127.0.0.1:${port}${path}`;

async function createSub(token: string, events: string[], url = hookUrl()) {
  const res = await request(h.http())
    .post('/admin/v1/webhooks/subscriptions')
    .set('Authorization', `Bearer ${token}`)
    .send({ url, events })
    .expect(201);
  return res.body as { id: string; secret: string; events: string[]; url: string };
}

async function checkoutOrder(): Promise<string> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);
  const co = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({});
  return co.body.id as string;
}

async function waitForDelivery(event: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.client<{ id: string }[]>`
      select id from webhook_deliveries where event = ${event} order by created_at desc limit 1`;
    if (rows.length > 0) return rows[0]!.id;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function deliveryService(): WebhookDeliveryService {
  return h.app.get(WebhookDeliveryService);
}

describe('fan-out + signed delivery', () => {
  it('delivers order.created with a verifiable HMAC-SHA256 signature; marks delivered', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const sub = await createSub(admin.accessToken, ['order.created']);

    const orderId = await checkoutOrder();
    const deliveryId = await waitForDelivery('order.created');
    expect(deliveryId).not.toBeNull();

    await deliveryService().processDue();

    expect(received).toHaveLength(1);
    const got = received[0]!;
    const ts = got.headers['x-sovecom-timestamp'] as string;
    const nonce = got.headers['x-sovecom-nonce'] as string;
    const sigHeader = got.headers['x-sovecom-signature'] as string;
    expect(ts).toBeTruthy();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // Receiver-side verification with the secret returned at create time.
    const expected = `sha256=${computeSignature(sub.secret, ts, nonce, got.body)}`;
    expect(sigHeader).toBe(expected);
    // Timestamp is recent (the 5-min replay window the receiver enforces).
    expect(Math.abs(Date.now() / 1000 - Number(ts))).toBeLessThan(300);

    const envelope = JSON.parse(got.body);
    expect(envelope.event).toBe('order.created');
    expect(envelope.id).toBe(deliveryId);
    expect(envelope.data.orderId).toBe(orderId);

    const [row] = await h.client<{ status: string; response_code: number; attempts: number }[]>`
      select status, response_code, attempts from webhook_deliveries where id = ${deliveryId}`;
    expect(row).toMatchObject({ status: 'delivered', response_code: 200, attempts: 1 });
  });

  it('only fans out to subscriptions subscribed to the event, and only for the event tenant', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await createSub(admin.accessToken, ['product.updated']); // NOT order.created

    // A different tenant with an order.created subscription must NOT receive this tenant's event.
    const otherTenant = '01900000-0000-7000-8000-0000000000ff';
    await h.client`insert into tenants (id, name, slug, settings) values (${otherTenant}, ${'Other'}, ${'other-wh'}, ${'{}'}::jsonb) on conflict (id) do nothing`;
    const otherSubId = '01900000-0000-7000-8000-0000000000fe';
    await h.client`
      insert into webhook_subscriptions (id, tenant_id, url, events, secret, active)
      values (${otherSubId}, ${otherTenant}, ${hookUrl()}, ${JSON.stringify(['order.created'])}::jsonb, ${'x'}, ${true})`;

    await checkoutOrder();
    // Give the fire-and-forget fan-out a moment; there should be NO order.created delivery anywhere.
    await new Promise((r) => setTimeout(r, 300));

    const all = await h.client<
      { n: number }[]
    >`select count(*)::int as n from webhook_deliveries where event = 'order.created'`;
    expect(all[0]!.n).toBe(0); // product.updated sub didn't match; other tenant not in scope

    await h.client`delete from webhook_subscriptions where tenant_id = ${otherTenant}`;
    await h.client`delete from tenants where id = ${otherTenant}`;
  });
});

describe('retry → backoff → exhausted, then admin retry-from-failure', () => {
  it('escalates failed attempts to exhausted, then a manual retry delivers', async () => {
    nextStatus = 500; // receiver rejects
    const admin = await seedAdminAndLogin(h, 'admin');
    await createSub(admin.accessToken, ['order.created']);
    await checkoutOrder();
    const deliveryId = await waitForDelivery('order.created');

    // First attempt fails → 'failed', attempts 1, backed off.
    await deliveryService().processDue();
    let row = (
      await h.client<{ status: string; attempts: number; response_code: number }[]>`
        select status, attempts, response_code from webhook_deliveries where id = ${deliveryId}`
    )[0]!;
    expect(row).toMatchObject({ status: 'failed', attempts: 1, response_code: 500 });

    // Drive to exhaustion: make it due again and re-process until the backoff schedule runs out.
    for (let i = 0; i < 8; i++) {
      await h.client`update webhook_deliveries set next_retry_at = now() - interval '1 second' where id = ${deliveryId} and status = 'failed'`;
      await deliveryService().processDue();
    }
    row = (
      await h.client<{ status: string; attempts: number }[]>`
        select status, attempts from webhook_deliveries where id = ${deliveryId}`
    )[0]!;
    expect(row.status).toBe('exhausted');
    expect(row.attempts).toBe(7); // 6 backoff steps + the final attempt

    // Admin retry-from-failure → pending; now the receiver accepts → delivered.
    nextStatus = 200;
    await request(h.http())
      .post(`/admin/v1/webhooks/deliveries/${deliveryId}/retry`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await deliveryService().processDue();
    const final = (
      await h.client<
        { status: string }[]
      >`select status from webhook_deliveries where id = ${deliveryId}`
    )[0]!;
    expect(final.status).toBe('delivered');
  });
});

describe('cross-process drain serialization (advisory lock)', () => {
  it('a second concurrent drain is skipped while the first holds the advisory lock', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await createSub(admin.accessToken, ['order.created']);
    await checkoutOrder();
    const deliveryId = await waitForDelivery('order.created');
    expect(deliveryId).not.toBeNull();

    const repo = deliveryService()['deliveries'] as {
      tryDrainLock(): Promise<(() => Promise<void>) | null>;
    };
    // Simulate instance A holding the drain lock (separate reserved connection).
    const release = await repo.tryDrainLock();
    expect(release).not.toBeNull();
    try {
      // Instance B's drain must acquire nothing and process zero rows — no double-deliver.
      const processed = await deliveryService().processDue();
      expect(processed).toBe(0);
      expect(received).toHaveLength(0);
    } finally {
      await release!();
    }

    // Once A releases, the normal drain delivers exactly once.
    const processed = await deliveryService().processDue();
    expect(processed).toBe(1);
    expect(received).toHaveLength(1);
  });
});

describe('hostile receiver cannot wedge the worker (Fable DoS blockers)', () => {
  it('settles (does not hang) on an over-cap >64KB response body', async () => {
    customResponder = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(200 * 1024, 0x61)); // 200KB > 64KB cap
    };
    const admin = await seedAdminAndLogin(h, 'admin');
    await createSub(admin.accessToken, ['order.created']);
    await checkoutOrder();
    const deliveryId = await waitForDelivery('order.created');

    // Must return promptly (not hang forever); the delivery is recorded.
    await deliveryService().processDue();
    const [row] = await h.client<{ status: string }[]>`
      select status from webhook_deliveries where id = ${deliveryId}`;
    expect(row!.status).toBe('delivered'); // 200 received despite oversized body
  }, 15_000);

  it('fails (not hang) on a receiver that never responds — hard deadline fires', async () => {
    process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = '800';
    const held: http.ServerResponse[] = [];
    customResponder = (_req, res) => {
      res.writeHead(200); // headers only — never end()
      held.push(res);
    };
    try {
      const admin = await seedAdminAndLogin(h, 'admin');
      await createSub(admin.accessToken, ['order.created']);
      await checkoutOrder();
      const deliveryId = await waitForDelivery('order.created');

      const started = Date.now();
      await deliveryService().processDue();
      expect(Date.now() - started).toBeLessThan(5000); // deadline fired, didn't hang

      const [row] = await h.client<{ status: string; attempts: number }[]>`
        select status, attempts from webhook_deliveries where id = ${deliveryId}`;
      expect(row!.status).toBe('failed');
      expect(row!.attempts).toBe(1);
    } finally {
      held.forEach((r) => r.end());
      delete process.env.WEBHOOK_DELIVERY_TIMEOUT_MS;
    }
  }, 15_000);
});

describe('security + admin API', () => {
  it('rejects a subscription to a loopback/metadata URL (SSRF) when the dev flag is off', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
    try {
      await request(h.http())
        .post('/admin/v1/webhooks/subscriptions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ url: 'https://169.254.169.254/latest/meta-data', events: ['order.created'] })
        .expect(400);
      await request(h.http())
        .post('/admin/v1/webhooks/subscriptions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ url: 'https://127.0.0.1/hook', events: ['order.created'] })
        .expect(400);
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true';
    }
  });

  it('returns the secret once on create, never on list, and stores ciphertext at rest', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const sub = await createSub(admin.accessToken, ['order.created']);
    expect(sub.secret).toMatch(/^whsec_/);

    const list = await request(h.http())
      .get('/admin/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].secret).toBeUndefined(); // never exposed on list

    const [stored] = await h.client<{ secret: string }[]>`
      select secret from webhook_subscriptions where id = ${sub.id}`;
    expect(stored!.secret).not.toBe(sub.secret); // encrypted at rest
    expect(stored!.secret).not.toContain(sub.secret);
  });

  it('enforces permissions: staff cannot create (settings:write) or list deliveries (settings:read)', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .post('/admin/v1/webhooks/subscriptions')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ url: hookUrl(), events: ['order.created'] })
      .expect(403);
    await request(h.http())
      .get('/admin/v1/webhooks/deliveries')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(403);
  });
});
