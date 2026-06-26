/**
 * SMTP transport: a send error must NOT leak the recipient address (nodemailer embeds
 * it in `err.message` on a 550 rejection). The transport surfaces only PII-free codes.
 */
const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail })),
}));

import { createSmtpTransport } from './smtp.transport';

const ORIGINAL_HOST = process.env.SMTP_HOST;

afterEach(() => {
  if (ORIGINAL_HOST === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = ORIGINAL_HOST;
  sendMail.mockReset();
});

describe('createSmtpTransport', () => {
  it('returns null when SMTP_HOST is absent', () => {
    delete process.env.SMTP_HOST;
    expect(createSmtpTransport()).toBeNull();
  });

  it('returns the provider message id on success', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    sendMail.mockResolvedValue({ messageId: '<id@smtp>' });
    const t = createSmtpTransport()!;
    expect(t.name).toBe('smtp');
    const res = await t.send({
      from: 'a@b.test',
      to: 'buyer@example.invalid',
      subject: 's',
      text: 't',
    });
    expect(res.messageId).toBe('<id@smtp>');
  });

  it('on a recipient-rejection error throws codes ONLY — never the recipient address', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    const nodemailerErr = Object.assign(
      new Error(
        'Message failed: 550 5.1.1 <buyer@example.invalid>: Recipient address rejected: User unknown',
      ),
      { responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' },
    );
    sendMail.mockRejectedValue(nodemailerErr);
    const t = createSmtpTransport()!;

    const err = await t
      .send({ from: 'a@b.test', to: 'buyer@example.invalid', subject: 's', text: 't' })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('550');
    expect(err!.message).toContain('EENVELOPE');
    expect(err!.message).not.toContain('buyer@example.invalid');
    expect(err!.message).not.toMatch(/@/);
  });
});
