/**
 * SSRF guard unit tests: blocked-address classification (v4/v6/mapped) and
 * create-time URL validation (scheme + resolve-and-reject).
 */
import { isBlockedAddress, assertSafeWebhookUrl, isLiteralAddressBlocked } from './ssrf';

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe('isBlockedAddress', () => {
  it('blocks loopback / private / link-local / metadata / CGNAT (IPv4)', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('blocks loopback / ULA / link-local and IPv4-mapped private (IPv6)', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false); // public v6
  });

  it('blocks IPv4-mapped/compat/NAT64 in EVERY textual form (Fable BLOCKER-1)', () => {
    for (const ip of [
      '::ffff:7f00:1', // hex form of ::ffff:127.0.0.1 (loopback)
      '0:0:0:0:0:ffff:127.0.0.1', // fully expanded mapped loopback
      '::ffff:a00:1', // = 10.0.0.1 (RFC1918)
      '::ffff:a9fe:a9fe', // = 169.254.169.254 (cloud metadata)
      '::ffff:c0a8:1', // = 192.168.0.1
      '::127.0.0.1', // IPv4-compatible (deprecated) loopback
      '64:ff9b::7f00:1', // NAT64-wrapped 127.0.0.1
      '64:ff9b::a9fe:a9fe', // NAT64-wrapped metadata
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    // A mapped PUBLIC v4 is still allowed.
    expect(isBlockedAddress('::ffff:1.1.1.1')).toBe(false);
    expect(isBlockedAddress('::ffff:0101:0101')).toBe(false); // 1.1.1.1 in hex
  });

  it('blocks non-IP input', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('assertSafeWebhookUrl', () => {
  beforeEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS;
    delete process.env.WEBHOOK_ALLOW_INSECURE;
  });

  it('rejects non-https schemes (unless the insecure flag is set)', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook')).rejects.toThrow();
    await expect(assertSafeWebhookUrl('ftp://example.com')).rejects.toThrow();
    process.env.WEBHOOK_ALLOW_INSECURE = 'true';
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true'; // skip DNS in the unit test
    await expect(assertSafeWebhookUrl('http://example.com/hook')).resolves.toBeUndefined();
  });

  it('rejects a literal loopback / private / metadata host', async () => {
    await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow();
    await expect(assertSafeWebhookUrl('https://[::1]/hook')).rejects.toThrow();
    await expect(
      assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data'),
    ).rejects.toThrow();
    await expect(assertSafeWebhookUrl('https://192.168.0.10/hook')).rejects.toThrow();
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toThrow();
  });

  it('accepts a public literal IP and (with the flag) a private host for dev/test', async () => {
    await expect(assertSafeWebhookUrl('https://1.1.1.1/hook')).resolves.toBeUndefined();
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true';
    await expect(assertSafeWebhookUrl('https://127.0.0.1:9999/hook')).resolves.toBeUndefined();
  });

  it('IGNORES the escape hatches outside dev/test (production, staging, unset) — allowlist guard', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS = 'true';
    process.env.WEBHOOK_ALLOW_INSECURE = 'true';
    try {
      for (const env of ['production', 'staging', '']) {
        process.env.NODE_ENV = env;
        // http rejected despite ALLOW_INSECURE; loopback rejected despite ALLOW_PRIVATE_HOSTS;
        // and the delivery-time literal guard still blocks (covers safeLookup's sibling path).
        await expect(assertSafeWebhookUrl('http://example.com/hook')).rejects.toThrow();
        await expect(assertSafeWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow();
        expect(isLiteralAddressBlocked('127.0.0.1')).toBe(true);
        expect(isLiteralAddressBlocked('::ffff:169.254.169.254')).toBe(true);
      }
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
