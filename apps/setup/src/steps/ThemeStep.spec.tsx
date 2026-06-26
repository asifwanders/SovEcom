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

/** Seed progress directly onto the Theme step (index 7) with a live token. */
function seedTheme() {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 7, data: {} }));
  sessionStorage.setItem(TOKEN_KEY, 'good-token');
}

describe('ThemeStep', () => {
  it('loads the themes and pre-selects the default, with an honest "more coming" note', async () => {
    seedTheme();
    const { api, get } = createMockApi();
    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /storefront theme/i })).toBeInTheDocument();
    // The default theme card renders and is selected.
    expect(await screen.findByText(/^default$/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /default/i })).toBeChecked();
    // Honest stub messaging.
    expect(screen.getByText(/more themes are coming/i)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/setup/v1/themes');
  });

  it('activates the selected theme and advances', async () => {
    seedTheme();
    const user = userEvent.setup();
    const { api, post } = createMockApi();
    render(<App api={api} />);
    await screen.findByRole('heading', { name: /storefront theme/i });
    await screen.findByText(/^default$/i);

    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/setup/v1/themes/activate', { themeId: 'default' });
    expect((await screen.findAllByText(/step 9 of 11/i)).length).toBeGreaterThan(0);
  });
});
