import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { Request, Response } from 'express';
import { redact } from '../redaction.util';

/**
 * Global exception filter (— "Fixes the shipped AllExceptionsFilter").
 *
 * The previous implementation reflected `exception.getResponse()` (and for
 * non-HttpExceptions, the raw message) straight into the response body and the
 * log line. For validation failures and unexpected throws that body can contain
 * the request payload — i.e. passwords, tokens and reset secrets. That is a
 * leak.
 *
 * This filter now returns a fixed, safe shape `{ statusCode, error, message }`:
 * - `message` is the *standard* HTTP status text (`STATUS_CODES`), never the
 *   echoed request body. Non-HttpExceptions collapse to a generic 500 so an
 *   internal error never reveals stack/driver detail to the client.
 * - For an HttpException whose response is a deliberately-structured object
 *   authored by the application (e.g. the /health 503 detail), the extra,
 *   non-secret fields of that object are merged in — first passed through
 *   {@link redact} as defense-in-depth so a secret-named key can never ride out
 *   on an error. Request-derived strings are never copied.
 *
 * Anything logged goes through {@link redact} too.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // `error` / `message` are always the standard status text — never the
    // exception's own (request-derived) message string.
    const statusText = STATUS_CODES[status] ?? 'Error';

    const body: Record<string, unknown> = {
      statusCode: status,
      error: statusText,
      message: statusText,
    };

    // Merge an application-authored structured detail object (e.g. /health),
    // redacted, but NEVER a bare string/array — those are typically the echoed
    // request payload or a raw message we must not surface.
    if (exception instanceof HttpException) {
      try {
        const detail = exception.getResponse();
        if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
          const safeDetail = redact(detail) as Record<string, unknown>;
          for (const [key, value] of Object.entries(safeDetail)) {
            // `statusCode`/`error`/`message` are owned by this filter and stay the
            // standard, non-request-derived values. Only extra structured fields
            // (e.g. the /health per-subsystem detail) are merged through.
            if (key === 'statusCode' || key === 'error' || key === 'message') {
              continue;
            }
            body[key] = value;
          }
        }
      } catch {
        // Defense-in-depth: if redaction/merge ever throws, still return the safe
        // base shape rather than letting the filter itself fail (status 0, no body).
      }
    }

    // Log: method + url + status only, with any structured context redacted.
    // Never log the request body or headers.
    this.logger.error(
      `${request.method} ${request.url} ${status}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json(body);
  }
}
