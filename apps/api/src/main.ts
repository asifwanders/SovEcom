import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { buildOpenApiConfig } from './common/openapi.config';
import { buildCorsConfig } from './common/cors.config';

async function bootstrap(): Promise<void> {
  // `rawBody: true` captures the unparsed request body on `req.rawBody` (alongside the
  // parsed `req.body`) — required for Stripe webhook signature verification, which must
  // hash the EXACT bytes Stripe signed. The parsed body is still available everywhere else.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Boundary infra. Order matters: parse cookies and apply
  // security headers before anything else touches the request.

  // Trust exactly one proxy hop (Caddy). NEVER `true` — that would let a client
  // spoof `X-Forwarded-For` and poison per-IP throttle keys.
  app.set('trust proxy', 1);

  // httpOnly refresh-cookie parsing for the auth flow.
  app.use(cookieParser());

  // CORS allowlist for the credentialed cross-origin clients.
  // BOTH the admin SPA (`ADMIN_ORIGIN`) and the storefront (`STORE_ORIGIN` — the same env
  // the customer refresh-CSRF allowlist uses) are credentialed (refresh + `sov_cart` cookies),
  // so `credentials:true` is required AND the origin MUST be an explicit allowlist (never `*`
  // with credentials). Both are comma-separated; when neither is set (dev) CORS is fail-closed.
  // `X-Order-Token` (guest-order lookup) is added to the allowed headers.
  app.enableCors(
    buildCorsConfig({
      ADMIN_ORIGIN: process.env.ADMIN_ORIGIN,
      STORE_ORIGIN: process.env.STORE_ORIGIN,
    }),
  );

  // Security headers + a sensible Content-Security-Policy. The admin SPA is a
  // separate app; the API itself serves only JSON + the Swagger UI, so the CSP
  // is intentionally tight (self-only, no inline except what Swagger needs).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          baseUri: [`'self'`],
          fontSrc: [`'self'`, 'https:', 'data:'],
          // Swagger UI ships its own bundled styles/scripts.
          scriptSrc: [`'self'`, `'unsafe-inline'`],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          imgSrc: [`'self'`, 'data:'],
          objectSrc: [`'none'`],
          frameAncestors: [`'none'`],
          formAction: [`'self'`],
          upgradeInsecureRequests: [],
        },
      },
      // The API is consumed cross-origin by the admin SPA; don't block it with
      // COEP. Same-origin policies above still apply.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Validate every Zod DTO at the boundary (DTOs are `.strict()` — unknown
  // fields rejected). nestjs-zod's pipe is global so controllers stay clean.
  app.useGlobalPipes(new ZodValidationPipe());

  // Safe error shape (no payload echo) + method/url/status logging only.
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // The Swagger UI + OpenAPI JSON expose the full admin API surface; mount
  // it everywhere EXCEPT production. Dev/test still mount at the same path.
  if (process.env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
    SwaggerModule.setup('admin/v1/docs', app, document, {
      jsonDocumentUrl: 'admin/v1/openapi.json',
    });
  }

  const port = process.env.API_PORT ? Number(process.env.API_PORT) : 3000;
  await app.listen(port);

  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
