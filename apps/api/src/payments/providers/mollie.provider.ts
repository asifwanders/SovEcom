import { Injectable, NotImplementedException } from '@nestjs/common';
import type {
  PaymentProvider,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  CreateRefundParams,
  RefundResult,
} from './payment-provider.interface';

/**
 * Mollie provider STUB. The full Mollie integration ships as a
 * separate v1.1 module. This empty implementation proves the seam is
 * provider-agnostic; every method throws until the module is built.
 */
@Injectable()
export class MollieProvider implements PaymentProvider {
  readonly name = 'mollie';

  createPaymentIntent(_params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    throw new NotImplementedException('Mollie ships as a v1.1 module');
  }

  createRefund(_params: CreateRefundParams): Promise<RefundResult> {
    throw new NotImplementedException('Mollie ships as a v1.1 module');
  }
}
