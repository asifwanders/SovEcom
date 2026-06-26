/**
 * Brevo transport unit tests: it activates only with an API key,
 * parses the sender, and on error surfaces ONLY the status + code slug — never the response body
 * (which can echo the recipient address) and never the API key.
 */
import { createBrevoTransport } from './brevo.transport';

const ORIGINAL_KEY = process.env.BREVO_API_KEY;
const SECRET = 'xkeysib-super-secret-key';

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BREVO_API_KEY;
  else process.env.BREVO_API_KEY = ORIGINAL_KEY;
  jest.restoreAllMocks();
});

describe('createBrevoTransport', () => {
  it('returns null when no BREVO_API_KEY is configured', () => {
    delete process.env.BREVO_API_KEY;
    expect(createBrevoTransport()).toBeNull();
  });

  it('posts to the Brevo API and returns the provider message id', async () => {
    process.env.BREVO_API_KEY = SECRET;
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ messageId: '<abc@brevo>' }), { status: 201 }),
      );
    const transport = createBrevoTransport()!;
    expect(transport.name).toBe('brevo');

    const res = await transport.send({
      from: 'Shop <no-reply@shop.test>',
      to: 'buyer@example.invalid',
      subject: 'Hi',
      text: 'body',
      html: '<p>body</p>',
    });

    expect(res.messageId).toBe('<abc@brevo>');
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.sender).toEqual({ email: 'no-reply@shop.test', name: 'Shop' });
    expect(body.to).toEqual([{ email: 'buyer@example.invalid' }]);
    // No tracking params requested by us (privacy).
    expect(JSON.stringify(body)).not.toMatch(/track/i);
  });

  it('on error throws status + code ONLY — never the body (PII) or the API key', async () => {
    process.env.BREVO_API_KEY = SECRET;
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'invalid_parameter',
          message: 'recipient buyer@example.invalid is blocked',
        }),
        { status: 400 },
      ),
    );
    const transport = createBrevoTransport()!;

    const err = await transport
      .send({ from: 'a@b.test', to: 'buyer@example.invalid', subject: 's', text: 't' })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('400');
    expect(err!.message).toContain('invalid_parameter');
    expect(err!.message).not.toContain('buyer@example.invalid'); // no recipient PII
    expect(err!.message).not.toContain(SECRET); // no API key
  });
});
