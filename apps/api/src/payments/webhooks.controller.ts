/**
 * Stripe webhook receiver. `POST /webhooks/stripe`.
 *
 * Public (no auth — Stripe calls it) but EVERY request is signature-verified inside the
 * service; an unsigned/forged body is rejected 400 and does nothing. Thin by design: it hands
 * the RAW body (required for signature verification) + the `stripe-signature` header to the
 * service and returns 200 so Stripe stops retrying a handled (or duplicate) event.
 */
import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentWebhookService } from './payment-webhook.service';

@Public()
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async handleStripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    await this.webhooks.processWebhook(req.rawBody, signature);
    return { received: true };
  }
}
