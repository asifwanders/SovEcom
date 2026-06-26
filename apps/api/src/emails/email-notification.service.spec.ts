/**
 * EmailNotificationService unit tests: the inline retry loop, the
 * single-outcome log row, and the resend guards. Mail/log/composer are mocked.
 */
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { EmailNotificationService } from './email-notification.service';
import type { IMailService } from '../mail/mail.service';
import type { EmailLogRepository } from './email-log.repository';
import type { EmailComposer, ComposedEmail } from './email-composer.service';
import type { EmailLog } from '../database/schema/email_logs';
import type { NewEmailLog } from '../database/schema/email_logs';

const TENANT = '00000000-0000-0000-0000-0000000000aa';

function composed(over: Partial<ComposedEmail> = {}): ComposedEmail {
  return {
    type: 'order_confirmation',
    recipient: 'cust@example.invalid',
    orderId: '00000000-0000-0000-0000-0000000000b0',
    referenceId: null,
    rendered: { subject: 'Order SO-1 confirmed', text: 'text', html: '<p>html</p>' },
    ...over,
  };
}

describe('EmailNotificationService', () => {
  let mail: jest.Mocked<IMailService>;
  let logs: jest.Mocked<Pick<EmailLogRepository, 'insert' | 'findById'>>;
  let composer: jest.Mocked<Pick<EmailComposer, 'compose'>>;
  let svc: EmailNotificationService;
  let inserted: NewEmailLog[];

  beforeEach(() => {
    process.env.EMAIL_RETRY_BASE_MS = '0'; // no real backoff in tests
    inserted = [];
    mail = {
      send: jest.fn(),
      sendPasswordReset: jest.fn(),
      sendEmailChangeVerification: jest.fn(),
      sendEmailChangeNotice: jest.fn(),
      sendCustomerPasswordReset: jest.fn(),
    };
    logs = {
      insert: jest.fn(async (v: NewEmailLog) => {
        inserted.push(v);
        return { id: 'log-1', ...v } as unknown as EmailLog;
      }),
      findById: jest.fn(),
    };
    composer = { compose: jest.fn() };
    svc = new EmailNotificationService(
      mail,
      logs as unknown as EmailLogRepository,
      composer as unknown as EmailComposer,
    );
  });

  describe('dispatch / send', () => {
    it('sends once on success → one "sent" log with the provider message id', async () => {
      mail.send.mockResolvedValue({ messageId: 'msg-123' });
      composer.compose.mockResolvedValue(composed());

      await svc.dispatch(TENANT, 'order_confirmation', composed().orderId, null);

      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        status: 'sent',
        attempts: 1,
        providerMessageId: 'msg-123',
        error: null,
        type: 'order_confirmation',
      });
      expect(inserted[0]!.sentAt).toBeInstanceOf(Date);
    });

    it('retries up to 3 times then records ONE "failed" log (no further sends)', async () => {
      mail.send.mockRejectedValue(new Error('smtp 421 try later'));
      composer.compose.mockResolvedValue(composed());

      await svc.dispatch(TENANT, 'order_confirmation', composed().orderId, null);

      expect(mail.send).toHaveBeenCalledTimes(3);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        status: 'failed',
        attempts: 3,
        providerMessageId: null,
        error: 'smtp 421 try later',
      });
      expect(inserted[0]!.sentAt).toBeNull();
    });

    it('scrubs any email address out of the persisted error (RGPD belt-and-braces)', async () => {
      mail.send.mockRejectedValue(
        new Error('550 <buyer@example.invalid>: Recipient address rejected'),
      );
      composer.compose.mockResolvedValue(composed());

      await svc.dispatch(TENANT, 'order_confirmation', composed().orderId, null);

      expect(inserted[0]!.status).toBe('failed');
      expect(inserted[0]!.error).not.toContain('buyer@example.invalid');
      expect(inserted[0]!.error).toContain('<email>');
    });

    it('recovers if a later attempt succeeds (attempts counts the tries)', async () => {
      mail.send
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({ messageId: 'msg-2' });
      composer.compose.mockResolvedValue(composed());

      await svc.dispatch(TENANT, 'order_confirmation', composed().orderId, null);

      expect(mail.send).toHaveBeenCalledTimes(2);
      expect(inserted[0]).toMatchObject({
        status: 'sent',
        attempts: 2,
        providerMessageId: 'msg-2',
      });
    });

    it('no-ops (no send, no log) when the composer can find no source data', async () => {
      composer.compose.mockResolvedValue(null);
      const result = await svc.dispatch(TENANT, 'order_confirmation', composed().orderId, null);
      expect(result).toBeNull();
      expect(mail.send).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    });
  });

  describe('resend', () => {
    it('404s when the log row is absent (tenant-scoped lookup)', async () => {
      logs.findById.mockResolvedValue(null);
      await expect(svc.resend(TENANT, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('422s when the logged email has no source order', async () => {
      logs.findById.mockResolvedValue({
        id: 'log-1',
        orderId: null,
        type: 'order_confirmation',
        referenceId: null,
      } as unknown as EmailLog);
      await expect(svc.resend(TENANT, 'log-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('422s when the source data can no longer be composed', async () => {
      logs.findById.mockResolvedValue({
        id: 'log-1',
        orderId: composed().orderId,
        type: 'order_confirmation',
        referenceId: null,
      } as unknown as EmailLog);
      composer.compose.mockResolvedValue(null);
      await expect(svc.resend(TENANT, 'log-1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('re-renders + resends + writes a fresh log row on success', async () => {
      logs.findById.mockResolvedValue({
        id: 'log-1',
        orderId: composed().orderId,
        type: 'order_confirmation',
        referenceId: null,
      } as unknown as EmailLog);
      composer.compose.mockResolvedValue(composed());
      mail.send.mockResolvedValue({ messageId: 'msg-resend' });

      await svc.resend(TENANT, 'log-1');

      expect(composer.compose).toHaveBeenCalledWith(
        TENANT,
        'order_confirmation',
        composed().orderId,
        null,
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({ status: 'sent', providerMessageId: 'msg-resend' });
    });
  });
});
