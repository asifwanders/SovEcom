/**
 * TokenService (SECURITY-CRITICAL).
 *
 * Access tokens: HS256 JWT `{ sub, tid, role, tv, purpose:'access', iat, exp }`,
 * 15-minute lifetime. Verification PINS `alg:'HS256'` (rejecting `alg:none`,
 * RS256/algorithm-confusion, and tampered tokens) AND rejects any token whose
 * `purpose` is not `'access'` (token-kind confusion — e.g. a 2fa-challenge token
 * signed with the same secret must NOT pass as an access token).
 *
 * Refresh tokens: 64-byte CSPRNG opaque, exposed as `{ plaintext, hash, familyId }`
 * where `hash = sha256(plaintext)`. Only the hash is ever persisted — never the
 * plaintext, never a JWT.
 *
 * The signing key is read via `getSigningKey()` indirection over `ConfigService`.
 * In production the key is rejected if missing, < 32 bytes, or a known default.
 */
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ACCESS_TTL = '15m';
const ACCESS_ALG = 'HS256' as const;
const ACCESS_PURPOSE = 'access';
const REFRESH_BYTES = 64;
const MIN_SECRET_BYTES = 32; // 256-bit
const KNOWN_DEFAULT_SECRETS = new Set(['changeme', 'secret', 'dev']);

/** Shape required to mint an access token (the authoritative DB user row). */
export interface AccessTokenSubject {
  id: string;
  tenantId: string;
  role: string;
  tokenVersion: number;
}

/** The verified, trusted claims of an access token. */
export interface AccessTokenClaims {
  sub: string;
  tid: string;
  role: string;
  tv: number;
  purpose: string;
  iat: number;
  exp: number;
}

/** A freshly minted opaque refresh token (plaintext returned exactly once). */
export interface MintedRefreshToken {
  plaintext: string;
  hash: string;
  familyId: string;
}

/** Minimal ConfigService surface this service depends on. */
interface ConfigLike {
  get(key: string): string | undefined;
}

@Injectable()
export class TokenService {
  private readonly jwt: JwtService;

  constructor(private readonly config: ConfigLike) {
    this.jwt = new JwtService({});
  }

  /**
   * Resolve and validate the HS256 signing key. In production a missing key, a
   * key shorter than 256 bits, or a known-default value is a hard failure.
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

  /** Mint a 15-minute HS256 access token for the given (DB-loaded) subject. */
  issueAccessToken(subject: AccessTokenSubject): Promise<string> {
    const payload = {
      sub: subject.id,
      tid: subject.tenantId,
      role: subject.role,
      tv: subject.tokenVersion,
      purpose: ACCESS_PURPOSE,
    };
    return this.jwt.signAsync(payload, {
      algorithm: ACCESS_ALG,
      expiresIn: ACCESS_TTL,
      secret: this.getSigningKey(),
    });
  }

  /**
   * Verify an access token. Pins `alg:'HS256'` (rejects none/RS/confusion and
   * tampered tokens) and rejects any token that is not `purpose:'access'`.
   * Throws on any failure.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
      algorithms: [ACCESS_ALG],
      secret: this.getSigningKey(),
    });
    if (claims.purpose !== ACCESS_PURPOSE) {
      throw new Error('not an access token');
    }
    return claims;
  }

  /**
   * Mint an opaque refresh token. Returns the plaintext (to set as a cookie,
   * once), its `sha256` hash (the only value persisted), and a new family id.
   */
  issueRefreshToken(): MintedRefreshToken {
    const plaintext = randomBytes(REFRESH_BYTES).toString('hex');
    const hash = TokenService.hashToken(plaintext);
    return { plaintext, hash, familyId: randomUUID() };
  }

  /** SHA-256 of a token plaintext (the at-rest representation). */
  static hashToken(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}
