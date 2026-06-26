/**
 * emitted AFTER a refund + its credit note commit. The 2.12 email
 * listener subscribes (no email is sent). Post-commit, so a rolled-back refund fires nothing.
 */
export class RefundIssuedEvent {
  static readonly EVENT_NAME = 'refund.issued';

  constructor(
    public readonly tenantId: string,
    public readonly orderId: string,
    public readonly refundId: string,
    public readonly amount: number,
    public readonly currency: string,
    public readonly creditNoteId: string | null,
  ) {}
}
