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

/** Seed progress directly onto the Payments step (index 4) with a live token. */
function seedPayments() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 4, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('PaymentsStep', () => {
  it('renders the method checklist with Stripe keys hidden', async () => {
    seedPayments();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /^payments$/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /stripe \(cards\)/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /sepa/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /apple pay/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /manual/i })).toBeInTheDocument();
    // Stripe key fields are hidden until Stripe is checked.
    expect(screen.queryByLabelText(/secret key/i)).not.toBeInTheDocument();
  });

  it('reveals the Stripe key fields only when Stripe is checked', async () => {
    seedPayments();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^payments$/i });

    await user.click(screen.getByRole('checkbox', { name: /stripe \(cards\)/i }));
    expect(screen.getByLabelText(/secret key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/publishable key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/webhook signing secret/i)).toBeInTheDocument();
    // The secret fields are password-type.
    expect(screen.getByLabelText(/secret key/i)).toHaveAttribute('type', 'password');
  });

  it('requires Stripe keys when Stripe is selected', async () => {
    seedPayments();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^payments$/i });

    await user.click(screen.getByRole('checkbox', { name: /stripe \(cards\)/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/enter your stripe secret key/i)).toBeInTheDocument();
    expect(screen.getByText(/enter your stripe publishable key/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('continues with no methods selected (all optional)', async () => {
    seedPayments();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^payments$/i });

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/setup/v1/payments/configure', { methods: [] }),
    );
    expect((await screen.findAllByText(/step 6 of 11/i)).length).toBeGreaterThan(0);
  });

  it('posts the selected methods + Stripe keys and advances', async () => {
    seedPayments();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^payments$/i });

    await user.click(screen.getByRole('checkbox', { name: /stripe \(cards\)/i }));
    await user.click(screen.getByRole('checkbox', { name: /manual/i }));
    await user.type(screen.getByLabelText(/secret key/i), 'sk_test_x');
    await user.type(screen.getByLabelText(/publishable key/i), 'pk_test_x');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/setup/v1/payments/configure');
    expect(body).toEqual({
      methods: ['stripe', 'manual'],
      stripe: { secretKey: 'sk_test_x', publishableKey: 'pk_test_x', webhookSecret: undefined },
    });
    expect((await screen.findAllByText(/step 6 of 11/i)).length).toBeGreaterThan(0);
  });
});
