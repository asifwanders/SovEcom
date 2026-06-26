import { redact, SECRET_KEYS, REDACTED, MAX_REDACT_DEPTH } from './redaction.util';

describe('redact — stem matching + depth safety (S1/S2 regression)', () => {
  it('redacts secret-key VARIANTS via substring stems, not just exact names', () => {
    const out = redact({
      apiKey: 'sk_live_LEAKED',
      'x-api-key': 'k',
      client_secret: 'cs',
      sessionToken: 'st',
      authToken: 'at',
      dbPassword: 'pw',
      passphrase: 'pp',
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) {
      expect(out[k]).toBe(REDACTED);
    }
  });

  it('preserves clearly non-secret keys', () => {
    const out = redact({ id: 1, name: 'A', count: 3, email: 'a@b.test' }) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ id: 1, name: 'A', count: 3, email: 'a@b.test' });
  });

  it('does not throw on pathologically deep input (depth-capped)', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < MAX_REDACT_DEPTH + 50; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('drops prototype-pollution keys', () => {
    const out = redact(JSON.parse('{"__proto__":{"polluted":true},"ok":1}')) as Record<
      string,
      unknown
    >;
    expect(out.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('redact — app-config secret field names (regression)', () => {
  it('redacts the SMTP password field `pass` and the DB credential field `url`', () => {
    const out = redact({ pass: 'x', url: 'postgres://u:pw@h/db' }) as Record<string, unknown>;
    expect(out.pass).toBe(REDACTED);
    expect(out.url).toBe(REDACTED);
  });

  it('also redacts the connection-string aliases `uri` and `dsn`', () => {
    const out = redact({
      uri: 'redis://u:pw@h:6379',
      dsn: 'postgres://u:pw@h/db',
    }) as Record<string, unknown>;
    expect(out.uri).toBe(REDACTED);
    expect(out.dsn).toBe(REDACTED);
  });
});

describe('redact', () => {
  it('returns non-objects unchanged (string/number/boolean/null/undefined)', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('does NOT redact a bare secret-shaped string at the top level (keyed on name, not value)', () => {
    // Redaction is property-name driven; a lone string has no key.
    expect(redact('super-secret-token-value')).toBe('super-secret-token-value');
  });

  it('redacts the value of every SECRET_KEY at the top level (case-insensitive)', () => {
    for (const key of SECRET_KEYS) {
      const lower = redact({ [key]: 'sensitive' }) as Record<string, unknown>;
      expect(lower[key]).toBe(REDACTED);

      const upper = key.toUpperCase();
      const mixed = redact({ [upper]: 'sensitive' }) as Record<string, unknown>;
      expect(mixed[upper]).toBe(REDACTED);
    }
  });

  it('covers the full required SECRET_KEYS set', () => {
    const required = [
      'password',
      'newPassword',
      'currentPassword',
      'token',
      'refreshToken',
      'accessToken',
      'totpCode',
      'totpSecret',
      'secret',
      'otpauthUrl',
      'qrDataUrl',
      'challengeId',
      'authorization',
      'cookie',
      'set-cookie',
      'jwt',
    ];
    for (const k of required) {
      expect(SECRET_KEYS.has(k.toLowerCase())).toBe(true);
    }
  });

  it('preserves non-secret keys verbatim', () => {
    const input = { id: 'abc', email: 'a@b.co', count: 3, nested: { name: 'x' } };
    expect(redact(input)).toEqual(input);
  });

  it('redacts secret keys at arbitrary depth', () => {
    const input = {
      level1: {
        ok: 'keep',
        password: 'p1',
        level2: {
          token: 't2',
          deeper: { refreshToken: 'r3', plain: 'visible' },
        },
      },
    };
    const out = redact(input) as any;
    expect(out.level1.ok).toBe('keep');
    expect(out.level1.password).toBe(REDACTED);
    expect(out.level1.level2.token).toBe(REDACTED);
    expect(out.level1.level2.deeper.refreshToken).toBe(REDACTED);
    expect(out.level1.level2.deeper.plain).toBe('visible');
  });

  it('redacts secret keys inside arrays and nested arrays', () => {
    const input = {
      items: [
        { secret: 's0', keep: 'a' },
        { totpCode: '123456', keep: 'b' },
        [{ accessToken: 'jwt-here' }],
      ],
    };
    const out = redact(input) as any;
    expect(out.items[0].secret).toBe(REDACTED);
    expect(out.items[0].keep).toBe('a');
    expect(out.items[1].totpCode).toBe(REDACTED);
    expect(out.items[1].keep).toBe('b');
    expect(out.items[2][0].accessToken).toBe(REDACTED);
  });

  it('handles cycles without infinite recursion', () => {
    const a: any = { name: 'root', password: 'pw' };
    a.self = a;
    a.child = { token: 'tok', parent: a };

    const out = redact(a) as any;
    expect(out.name).toBe('root');
    expect(out.password).toBe(REDACTED);
    expect(out.self).toBe('[Circular]');
    expect(out.child.token).toBe(REDACTED);
    expect(out.child.parent).toBe('[Circular]');
  });

  it('does not mutate the input (purity)', () => {
    const input = { password: 'secret', nested: { token: 'abc' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it('redacts a realistic auth payload end-to-end', () => {
    const input = {
      method: 'POST',
      url: '/admin/v1/auth/login',
      body: { email: 'admin@shop.io', password: 'hunter2' },
      headers: {
        authorization: 'Bearer abc.def.ghi',
        cookie: 'refresh=xyz',
        'set-cookie': 'refresh=new',
        'user-agent': 'jest',
      },
      challengeId: 'chal_12345',
      otpauthUrl: 'otpauth://totp/...',
      qrDataUrl: 'data:image/png;base64,...',
    };
    const out = redact(input) as any;
    expect(out.method).toBe('POST');
    // `url` is now a redacted key: a DB/SMTP credential URL must never
    // ride out in a log line, so the safety net redacts the field name outright.
    expect(out.url).toBe(REDACTED);
    expect(out.body.email).toBe('admin@shop.io');
    expect(out.body.password).toBe(REDACTED);
    expect(out.headers.authorization).toBe(REDACTED);
    expect(out.headers.cookie).toBe(REDACTED);
    expect(out.headers['set-cookie']).toBe(REDACTED);
    expect(out.headers['user-agent']).toBe('jest');
    expect(out.challengeId).toBe(REDACTED);
    expect(out.otpauthUrl).toBe(REDACTED);
    expect(out.qrDataUrl).toBe(REDACTED);
  });
});
