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

/** Seed progress directly onto the Tax step (index 5) with a live token. */
function seedTax() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 5, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

async function selectCountry(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = screen.getByLabelText(/business country/i);
  await user.selectOptions(select, code);
}

describe('TaxStep', () => {
  it('renders the country select with no tax mode chosen until a country is picked', async () => {
    seedTax();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /^tax$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/business country/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/default currency/i)).toBeInTheDocument();
  });

  it('defaults EU VAT + tax-inclusive pricing and shows the guidance banner for an EU country', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'FR');

    // EU VAT radio is selected.
    expect(screen.getByRole('radio', { name: /eu vat/i })).toBeChecked();
    // Friendly guidance banner naming the country.
    expect(screen.getByText(/france is in the eu/i)).toBeInTheDocument();
    // Tax-inclusive pricing defaulted on.
    expect(screen.getByRole('switch', { name: /prices include tax/i })).toBeChecked();
    // Currency pre-filled to EUR.
    expect(screen.getByLabelText(/default currency/i)).toHaveValue('EUR');
  });

  it('defaults to no tax for a non-EU country (no eu_vat fields)', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'US');

    expect(screen.getByRole('radio', { name: /no tax/i })).toBeChecked();
    expect(screen.getByText(/united states is outside the eu/i)).toBeInTheDocument();
    // eu_vat-only fields are hidden.
    expect(screen.queryByLabelText(/eu vat number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/oss posture/i)).not.toBeInTheDocument();
    // Currency pre-filled to USD.
    expect(screen.getByLabelText(/default currency/i)).toHaveValue('USD');
  });

  it('eu_vat reveals the VAT number + OSS fields; switching to none hides them', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'DE');
    expect(screen.getByLabelText(/eu vat number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/oss posture/i)).toBeInTheDocument();

    // Override to "no tax" — fields disappear (and the guardrail appears).
    await user.click(screen.getByRole('radio', { name: /no tax/i }));
    expect(screen.queryByLabelText(/eu vat number/i)).not.toBeInTheDocument();
  });

  it('shows the EU guardrail warning when overriding to none for an EU country', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'IT');
    await user.click(screen.getByRole('radio', { name: /no tax/i }));

    expect(screen.getByText(/an eu business must charge vat/i)).toBeInTheDocument();
    // Continue is blocked client-side — no POST attempted.
    const cont = screen.getByRole('button', { name: /continue/i });
    expect(cont).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the right eu_vat payload and advances, reflecting a valid VIES status', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api, post } = createMockApi({
      post: async () => ({ ok: true, vatStatus: 'valid' }),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'FR');
    await user.type(screen.getByLabelText(/eu vat number/i), 'FR12345678901');
    await user.click(screen.getByRole('button', { name: /validate & continue/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/setup/v1/tax/configure');
    expect(body).toEqual({
      businessCountry: 'FR',
      defaultCurrency: 'EUR',
      taxMode: 'eu_vat',
      pricesIncludeTax: true,
      vatNumber: 'FR12345678901',
      ossPosture: 'below_threshold',
    });
    // Advanced to step 7 (Compliance).
    expect((await screen.findAllByText(/step 7 of 11/i)).length).toBeGreaterThan(0);
  });

  it('posts a none payload (no VAT/OSS) for a non-EU country', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'US');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0]!;
    expect(body).toEqual({
      businessCountry: 'US',
      defaultCurrency: 'USD',
      taxMode: 'none',
      pricesIncludeTax: false,
    });
  });

  it('requires a VAT number for eu_vat before submitting', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    await selectCountry(user, 'ES');
    await user.click(screen.getByRole('button', { name: /validate & continue/i }));

    expect(await screen.findByText(/enter your eu vat number/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('renders a 422 guardrail response inline', async () => {
    seedTax();
    const user = userEvent.setup();
    const { api } = createMockApi({
      post: async () => {
        throw new SetupApiError(
          422,
          "Cannot set tax_mode='none' for an EU-based business (origin FR).",
        );
      },
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /^tax$/i });

    // Pick an EU country, then submit eu_vat with a VAT number, but force a server 422.
    await selectCountry(user, 'FR');
    await user.type(screen.getByLabelText(/eu vat number/i), 'FR12345678901');
    await user.click(screen.getByRole('button', { name: /validate & continue/i }));

    expect(
      await screen.findByText(/cannot set tax_mode='none' for an eu-based business/i),
    ).toBeInTheDocument();
    // Did not advance.
    expect(screen.getByRole('heading', { name: /^tax$/i })).toBeInTheDocument();
  });
});
