/**
 * CustomerTokenService (SECURITY-CRITICAL.1).
 *
 * The customer-side mirror of the admin {@link TokenService}. It mints + verifies
 * a SECOND, ISOLATED access-token kind:
 *
 *   `{ sub: customerId, tid, tv, purpose:'customer', iat, exp }`, H, 15m.
 *
 * Isolation is enforced by PINNING both `alg:'HS256'` (rejects alg:none / RS /
 * algorithm-confusion / tampering) AND `purpose:'customer'`. Because the admin
 * TokenService pins `purpose:'access'` and this one pins `purpose:'customer'`,
 * a token of one kind is structurally rejected by the other guard EVEN THOUGH
 * both are signed with the same JWT_SECRET — the purpose claim is the kind tag,
 * verified, not trusted. (.1: "a customer token can never reach an admin
 * route and an admin token can never act as a customer.")
 *
 * Refresh tokens are the SAME opaque-CSPRNG primitive as admin (reused from
 * TokenService.issueRefreshToken / hashToken) — only the access JWT differs.
 */
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const ACCESS_TTL = '15m';
const ACCESS_ALG = 'HS256' as const;
/** The customer access-token kind tag — DISTINCT from admin's `'access'`. */
const CUSTOMER_PURPOSE = 'customer';
const MIN_SECRET_BYTES = 32; // 256-bit
const KNOWN_DEFAULT_SECRETS = new Set(['changeme', 'secret', 'dev']);

/** Shape required to mint a customer access token (the authoritative DB row). */
export interface CustomerTokenSubject {
  id: string;
  tenantId: string;
  tokenVersion: number;
}

/** The verified, trusted claims of a customer access token. */
export interface CustomerTokenClaims {
  sub: string;
  tid: string;
  tv: number;
  purpose: string;
  iat: number;
  exp: number;
}

/** Minimal ConfigService surface this service depends on. */
interface ConfigLike {
  get(key: string): string | undefined;
}

@Injectable()
export class CustomerTokenService {
  private readonly jwt: JwtService;

  constructor(private readonly config: ConfigLike) {
    this.jwt = new JwtService({});
  }

  /**
   * Resolve and validate the HS256 signing key — the SAME JWT_SECRET as the admin
   * surface (the kind separation is the `purpose` claim, not a second secret). In
   * production a missing / < 256-bit / known-default key is a hard failure.
   */
  private getSigningKey(): string {
    const secret = this.config.get('JWT_SECRET');
    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
        throw new Error('JWT_SECRET must be set and at least 256 bits in production');
      }
      if (KNOWN_DEFAULT_SECRETS.has(secret)) {
        throw new Error('JWT_SECRET must not be a known default in production');
      }
    }
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    return secret;
  }

  /** Mint a 15-minute HS256 `purpose:'customer'` access token for a DB-loaded row. */
  issueAccessToken(subject: CustomerTokenSubject): Promise<string> {
    const payload = {
      sub: subject.id,
      tid: subject.tenantId,
      tv: subject.tokenVersion,
      purpose: CUSTOMER_PURPOSE,
    };
    return this.jwt.signAsync(payload, {
      algorithm: ACCESS_ALG,
      expiresIn: ACCESS_TTL,
      secret: this.getSigningKey(),
    });
  }

  /**
   * Verify a customer access token. Pins `alg:'HS256'` and REJECTS any token whose
   * `purpose` is not `'customer'` — so an admin `purpose:'access'` token (same
   * secret) fails here. Throws on any failure.
   */
  async verifyAccessToken(token: string): Promise<CustomerTokenClaims> {
    const claims = await this.jwt.verifyAsync<CustomerTokenClaims>(token, {
      algorithms: [ACCESS_ALG],
      secret: this.getSigningKey(),
    });
    if (claims.purpose !== CUSTOMER_PURPOSE) {
      throw new Error('not a customer token');
    }
    return claims;
  }
}
