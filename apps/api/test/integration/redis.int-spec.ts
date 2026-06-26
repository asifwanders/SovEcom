import Redis from 'ioredis';
import { keys } from '../../src/redis/keys';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('redis (integration)', () => {
  let client: Redis;

  beforeAll(() => {
    client = new Redis(url);
  });

  afterAll(async () => {
    if (client) await client.quit();
  });

  it('responds to PING', async () => {
    expect(await client.ping()).toBe('PONG');
  });

  it('round-trips a tenant-scoped cart key with TTL', async () => {
    const key = keys.cart('t1', 's1');
    await client.set(key, 'value', 'EX', 60);
    expect(await client.get(key)).toBe('value');
    expect(await client.ttl(key)).toBeGreaterThan(0);
    await client.del(key);
    expect(await client.get(key)).toBeNull();
  });
});
