import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createMockApi } from '../test-utils';
import { PROGRESS_KEY, TOKEN_KEY } from '../wizard/storage';

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: () => {} },
  });
});

/** Seed progress directly onto the Email step (index 3) with a live token. */
function seedEmail() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 3, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('EmailStep', () => {
  it('renders the provider choice (Brevo default) and the prerequisite note', async () => {
    seedEmail();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /email delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /brevo/i })).toBeChecked();
    expect(screen.getByLabelText(/brevo api key/i)).toBeInTheDocument();
    // The note explaining email is needed before the Admin OTP step.
    expect(screen.getByText(/one-time code sent here/i)).toBeInTheDocument();
  });

  it('reveals SMTP fields when Custom SMTP is chosen', async () => {
    seedEmail();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.click(screen.getByRole('radio', { name: /custom smtp/i }));
    expect(screen.getByLabelText(/^host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^port/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /secure/i })).toBeInTheDocument();
  });

  it('blocks Continue with inline errors when required fields are empty', async () => {
    seedEmail();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/enter your brevo api key/i)).toBeInTheDocument();
    expect(screen.getByText(/enter the “from” address/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('send-test requires a recipient address inline', async () => {
    seedEmail();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.click(screen.getByRole('button', { name: /send test/i }));
    expect(await screen.findByText(/enter the address to send the test to/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('send-test shows loading then an inline success', async () => {
    seedEmail();
    const user = userEvent.setup();
    let resolve!: (v: { ok: true }) => void;
    const { api } = createMockApi({
      post: () => new Promise<{ ok: true }>((r) => (resolve = r)),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.type(screen.getByLabelText(/brevo api key/i), 'xkeysib-abc');
    await user.type(screen.getByLabelText(/from address/i), 'store@example.com');
    await user.type(screen.getByLabelText(/test recipient address/i), 'me@example.com');

    const sendBtn = screen.getByRole('button', { name: /send test/i });
    await user.click(sendBtn);
    await waitFor(() => expect(sendBtn).toHaveAttribute('aria-busy', 'true'));

    resolve({ ok: true });
    expect(await screen.findByText(/sent — check your inbox/i)).toBeInTheDocument();
  });

  it('send-test shows the sanitized error inline on failure', async () => {
    seedEmail();
    const user = userEvent.setup();
    const { api } = createMockApi({
      post: async () => ({ ok: false, error: 'Authentication failed.' }),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.type(screen.getByLabelText(/brevo api key/i), 'xkeysib-abc');
    await user.type(screen.getByLabelText(/from address/i), 'store@example.com');
    await user.type(screen.getByLabelText(/test recipient address/i), 'me@example.com');
    await user.click(screen.getByRole('button', { name: /send test/i }));

    expect(await screen.findByText(/authentication failed/i)).toBeInTheDocument();
  });

  it('configures Brevo (mapped to its relay) and advances', async () => {
    seedEmail();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /email delivery/i });

    await user.type(screen.getByLabelText(/brevo api key/i), 'xkeysib-abc');
    await user.type(screen.getByLabelText(/from address/i), 'store@example.com');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/setup/v1/smtp/configure');
    expect(body).toMatchObject({
      host: 'smtp-relay.brevo.com',
      port: 587,
      pass: 'xkeysib-abc',
      from: 'store@example.com',
    });
    expect((await screen.findAllByText(/step 5 of 11/i)).length).toBeGreaterThan(0);
  });
});
