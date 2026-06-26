import { Injectable } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import type {
  PaymentProvider,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  CreateRefundParams,
  RefundResult,
} from './payment-provider.interface';

/**
 * the LIVE Stripe provider. Implements the swappable
 * {@link PaymentProvider} by delegating to {@link StripeService} (the SDK wrapper). Kept thin
 * so the swap seam is obvious; Stripe-specific concerns (webhook verify, customer creation)
 * stay on the service.
 */
@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(private readonly stripe: StripeService) {}

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    return this.stripe.createPaymentIntent(params);
  }

  createRefund(params: CreateRefundParams): Promise<RefundResult> {
    return this.stripe.createRefund(params);
  }
}
