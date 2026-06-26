import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface Captured {
  status: number;
  body: any;
}

function run(exception: unknown): Captured {
  const captured: Captured = { status: 0, body: undefined };

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };

  const request = { method: 'POST', url: '/admin/v1/auth/login' };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  const filter = new AllExceptionsFilter();
  filter.catch(exception, host);
  return captured;
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    // Silence error logging during the suite.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('returns the safe { statusCode, error, message } shape for an HttpException', () => {
    const { status, body } = run(new UnauthorizedException());
    expect(status).toBe(401);
    expect(body).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Unauthorized',
    });
  });

  it('collapses a non-HttpException to a generic 500 with no internal detail', () => {
    const { status, body } = run(new Error('connection string postgres://user:pw@host failed'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    // The raw error message must not leak.
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(JSON.stringify(body)).not.toContain('pw@host');
  });

  it('does NOT echo a request payload carrying secrets (the bug this filter fixes)', () => {
    // Simulate a validation/exception whose response object reflects the body,
    // including a password and a token — exactly the leak class 022.11 fixes.
    const leaky = new BadRequestException({
      statusCode: 400,
      message: 'Validation failed',
      error: 'Bad Request',
      receivedBody: {
        email: 'admin@shop.io',
        password: 'hunter2',
        token: 'reset-token-abc123',
        refreshToken: 'rt-secret',
      },
    });

    const { status, body } = run(leaky);
    const serialized = JSON.stringify(body);

    expect(status).toBe(400);
    // None of the secret VALUES appear anywhere in the response.
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('reset-token-abc123');
    expect(serialized).not.toContain('rt-secret');

    // If the leaked object rode through at all, its secret-named fields are
    // redacted (defense in depth) — but the values are gone regardless.
    if (body.receivedBody) {
      expect(body.receivedBody.password).toBe('[REDACTED]');
      expect(body.receivedBody.token).toBe('[REDACTED]');
      expect(body.receivedBody.refreshToken).toBe('[REDACTED]');
    }
    // The controlled scalar fields stay standard.
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('Bad Request');
  });

  it('does not echo a raw string HttpException response into the body', () => {
    const ex = new HttpException('email already exists for user secret-leak', HttpStatus.CONFLICT);
    const { status, body } = run(ex);
    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Conflict',
    });
    expect(JSON.stringify(body)).not.toContain('secret-leak');
  });

  it('preserves the /health 503 structured detail (intact behavior)', () => {
    const detail = {
      status: 'error',
      uptime: 12.3,
      postgres: 'ok',
      redis: 'down',
      meilisearch: 'ok',
    };
    const { status, body } = run(new ServiceUnavailableException(detail));
    expect(status).toBe(503);
    expect(body.statusCode).toBe(503);
    expect(body.status).toBe('error');
    expect(body.redis).toBe('down');
    expect(body.postgres).toBe('ok');
    expect(body.meilisearch).toBe('ok');
    expect(body.uptime).toBe(12.3);
  });

  it('uses generic 500 shape for a plain thrown string/unknown', () => {
    const { status, body } = run('boom with token=abc.def');
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(JSON.stringify(body)).not.toContain('abc.def');
  });
});
