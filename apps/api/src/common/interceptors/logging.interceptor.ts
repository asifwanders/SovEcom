import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Request logging interceptor.
 *
 * Logs exactly `method + url + status + duration` — and NEVER the request body
 * or headers, which can carry passwords, tokens and cookies. If a future change
 * needs to attach structured context, route it through {@link redact} from
 * `../redaction.util` before logging; do not log raw request data.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const url = request.url;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse<Response>();
        const statusCode = response.statusCode;
        const duration = Date.now() - now;
        this.logger.log(`${method} ${url} ${statusCode} — ${duration}ms`);
      }),
    );
  }
}
