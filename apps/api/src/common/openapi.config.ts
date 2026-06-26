import { DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Single source of truth for the OpenAPI document config.
 *
 * Imported by BOTH `main.ts` (which serves the spec at `/admin/v1/openapi.json`) and the
 * `openapi-dump` spec (which emits `apps/api/openapi.json`, the committed source for
 * `@sovecom/client-js`'s generated types). Centralising it here means the served spec and the
 * dumped spec cannot silently diverge — change the surface once, both follow.
 */
export function buildOpenApiConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('SovEcom API')
    .setDescription('The SovEcom headless ecommerce API')
    .setVersion('1.0.0')
    .addTag('Health')
    .build();
}
