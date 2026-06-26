import { Injectable, NotImplementedException } from '@nestjs/common';
import type {
  PaymentProvider,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  CreateRefundParams,
  RefundResult,
} from './payment-provider.interface';

/**
 * Manual / offline provider stub. Offline payments (bank transfer, COD) are recorded
 * via the admin UI. This adapter ensures the provider seam is complete; online methods
 * are intentionally not implemented — there is no online intent for an offline payment.
 */
@Injectable()
export class ManualProvider implements PaymentProvider {
  readonly name = 'manual';

  createPaymentIntent(_params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    throw new NotImplementedException('Manual payments are recorded via the admin UI');
  }

  createRefund(_params: CreateRefundParams): Promise<RefundResult> {
    throw new NotImplementedException('Manual refunds are recorded by an admin');
  }
}
