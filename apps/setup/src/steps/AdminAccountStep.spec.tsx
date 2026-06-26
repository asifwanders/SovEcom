import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createMockApi } from '../test-utils';
import { SetupApiError } from '../lib/api';
import { PROGRESS_KEY, TOKEN_KEY } from '../wizard/storage';

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: () => {} },
  });
});

/** Seed progress directly onto the Admin step (index 9) with a live token. */
function seedAdmin() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 9, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

const STRONG_PASSWORD = 'correct-horse-battery-staple-92';

describe('AdminAccountStep — request the code', () => {
  it('renders the request form (email + name) with the OTP rationale', async () => {
    seedAdmin();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /your admin account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send verification code/i })).toBeInTheDocument();
  });

  it('blocks the request with inline errors when fields are empty', async () => {
    seedAdmin();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });

    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();
    expect(screen.getByText(/enter a valid email/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts to admin-account/start and advances to the verify phase on success', async () => {
    seedAdmin();
    const user = userEvent.setup();
    const { api, post } = createMockApi({ post: async () => ({ sent: true }) });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });

    await user.type(screen.getByLabelText(/your name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/setup/v1/admin-account/start');
    expect(body).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace' });

    // The verify phase is now visible: the code prompt mentions the email.
    expect(await screen.findByText(/ada@example\.com/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/verification code/i)).toBeInTheDocument();
  });

  it('shows a "configure SMTP first" message with a Back affordance on a 422', async () => {
    seedAdmin();
    const user = userEvent.setup();
    const { api } = createMockApi({
      post: async () => {
        throw new SetupApiError(422, 'configure SMTP before creating the admin account');
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });

    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    expect(await screen.findByText(/set up email first/i)).toBeInTheDocument();
    // A way back to the Email step is offered.
    expect(screen.getByRole('button', { name: /back to email/i })).toBeInTheDocument();
  });

  it('shows a wait message on a 429 rate limit', async () => {
    seedAdmin();
    const user = userEvent.setup();
    const { api } = createMockApi({
      post: async () => {
        throw new SetupApiError(429, 'Too Many Requests');
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });

    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });
});

describe('AdminAccountStep — verify + set password', () => {
  async function reachVerifyPhase(post: () => Promise<unknown>) {
    seedAdmin();
    const user = userEvent.setup();
    const mock = createMockApi({ post });
    render(<App api={mock.api} />);
    await screen.findByRole('heading', { name: /your admin account/i });
    await user.type(screen.getByLabelText(/your name/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));
    await screen.findByLabelText(/verification code/i);
    return { user, ...mock };
  }

  it('limits the OTP input to 6 numeric digits', async () => {
    const { user } = await reachVerifyPhase(async () => ({ sent: true }));
    const otp = screen.getByLabelText(/verification code/i) as HTMLInputElement;
    await user.type(otp, '12ab34cd5678');
    expect(otp.value).toBe('123456');
  });

  it('requires a 6-digit code and a 12+ char password inline', async () => {
    const { user, post } = await reachVerifyPhase(async () => ({ sent: true }));
    post.mockClear();

    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/enter the 6-digit code/i)).toBeInTheDocument();
    expect(screen.getByText(/12 characters or more/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('flags a password-confirm mismatch inline', async () => {
    const { user, post } = await reachVerifyPhase(async () => ({ sent: true }));
    post.mockClear();

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm password/i), 'different-but-also-long');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(
      await screen.findByText(/passwords don’t match|passwords don't match/i),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('verifies and advances to Done on success', async () => {
    const calls: Array<[string, unknown]> = [];
    const { user, post } = await reachVerifyPhase(async () => ({ sent: true }));
    post.mockImplementation(async (path: string, body: unknown) => {
      calls.push([path, body]);
      return { ok: true };
    });

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const [path, body] = calls[0]!;
    expect(path).toBe('/setup/v1/admin-account/verify');
    expect(body).toMatchObject({
      email: 'ada@example.com',
      otp: '123456',
      password: STRONG_PASSWORD,
    });
    // Advanced to Done.
    expect(
      await screen.findByRole('heading', { name: /you’re all set|you're all set/i }),
    ).toBeInTheDocument();
  });

  it('surfaces a 401 wrong-code error inline', async () => {
    seedAdmin();
    const user = userEvent.setup();
    let phase: 'start' | 'verify' = 'start';
    const { api } = createMockApi({
      post: async () => {
        if (phase === 'start') {
          phase = 'verify';
          return { sent: true };
        }
        throw new SetupApiError(401, 'invalid or expired verification code');
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });
    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));
    await screen.findByLabelText(/verification code/i);

    await user.type(screen.getByLabelText(/verification code/i), '000000');
    await user.type(screen.getByLabelText(/^password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/code is invalid or expired/i)).toBeInTheDocument();
  });

  it('surfaces a 422 weak-password error on the password field', async () => {
    seedAdmin();
    const user = userEvent.setup();
    let phase: 'start' | 'verify' = 'start';
    const { api } = createMockApi({
      post: async () => {
        if (phase === 'start') {
          phase = 'verify';
          return { sent: true };
        }
        throw new SetupApiError(422, 'password is too weak');
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /your admin account/i });
    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: /send verification code/i }));
    await screen.findByLabelText(/verification code/i);

    await user.type(screen.getByLabelText(/verification code/i), '123456');
    await user.type(screen.getByLabelText(/^password/i), 'commonpassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'commonpassword1');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/too weak|choose a stronger/i)).toBeInTheDocument();
  });

  it('toggles password visibility', async () => {
    const { user } = await reachVerifyPhase(async () => ({ sent: true }));
    const pwd = screen.getByLabelText(/^password/i) as HTMLInputElement;
    expect(pwd.type).toBe('password');
    await user.click(screen.getByRole('button', { name: /show password/i }));
    expect(pwd.type).toBe('text');
  });

  it('resends the code from the verify step', async () => {
    const { user, post } = await reachVerifyPhase(async () => ({ sent: true }));
    post.mockClear();
    await user.click(screen.getByRole('button', { name: /resend code/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe('/setup/v1/admin-account/start');
  });
});
