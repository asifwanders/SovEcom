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

/** Seed progress directly onto the Compliance step (index 6) with a live token. */
function seedCompliance() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 6, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('ComplianceStep', () => {
  it('locks cookie consent on (disabled, checked) and defaults Plausible on', async () => {
    seedCompliance();
    const { api } = createMockApi();
    render(<App api={api} />);

    expect(
      await screen.findByRole('heading', { name: /privacy & compliance/i }),
    ).toBeInTheDocument();

    const cookie = screen.getByRole('switch', { name: /cookie consent/i });
    expect(cookie).toBeChecked();
    expect(cookie).toBeDisabled();

    expect(screen.getByRole('switch', { name: /plausible/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /google analytics/i })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /meta pixel/i })).not.toBeChecked();
  });

  it('shows an RGPD warning + id field when Google Analytics is enabled', async () => {
    seedCompliance();
    const user = userEvent.setup();
    const { api } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /privacy & compliance/i });

    expect(screen.queryByText(/rgpd warning/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /google analytics/i }));

    expect(screen.getByText(/rgpd warning/i)).toBeInTheDocument();
    expect(screen.getByText(/sends visitor data to google/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/measurement id/i)).toBeInTheDocument();
  });

  it('requires the GA id when GA is enabled', async () => {
    seedCompliance();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /privacy & compliance/i });

    await user.click(screen.getByRole('switch', { name: /google analytics/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(
      await screen.findByText(/enter your google analytics measurement id/i),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts the privacy-first defaults (cookie locked on, Plausible on, no GA/Meta)', async () => {
    seedCompliance();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /privacy & compliance/i });

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/setup/v1/compliance/configure');
    expect(body).toEqual({ cookieConsent: true, analytics: { plausible: true } });
    expect((await screen.findAllByText(/step 8 of 11/i)).length).toBeGreaterThan(0);
  });

  it('posts the Plausible domain when one is entered', async () => {
    seedCompliance();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /privacy & compliance/i });

    await user.type(screen.getByLabelText(/site domain/i), 'shop.example.com');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0]!;
    expect(body).toEqual({
      cookieConsent: true,
      analytics: { plausible: true, plausibleDomain: 'shop.example.com' },
    });
  });

  it('posts GA + Meta ids when both are enabled with ids', async () => {
    seedCompliance();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /privacy & compliance/i });

    await user.click(screen.getByRole('switch', { name: /google analytics/i }));
    await user.type(screen.getByLabelText(/measurement id/i), 'G-ABC123');
    await user.click(screen.getByRole('switch', { name: /meta pixel/i }));
    await user.type(screen.getByLabelText(/pixel id/i), '99887766');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0]!;
    expect(body).toEqual({
      cookieConsent: true,
      analytics: {
        plausible: true,
        ga: { id: 'G-ABC123' },
        meta: { pixelId: '99887766' },
      },
    });
  });
});
