/**
 * Home-sections editor specs (WS-3c).
 *
 * Mocks `apiFetch` and `@sovecom/theme-sdk`. Covers:
 *   - Renders loaded sections from GET.
 *   - Add section mutates state (new card appears).
 *   - Reorder (up/down) mutates order.
 *   - Remove mutates state (card disappears).
 *   - PUT payload is the correct {type, settings}[] structure.
 *   - 422 from the API surfaces an error to the user (not silent).
 *   - Image upload sets the field from the returned URL.
 *   - Nav item is visible for themes:write (owner/admin) and hidden for staff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// ── mocks ──────────────────────────────────────────────────────────────────────

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    constructor(
      msg: string,
      public status: number,
      public body: unknown,
    ) {
      super(msg);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@sovecom/theme-sdk', async () => {
  const actual = await vi.importActual<typeof import('@sovecom/theme-sdk')>('@sovecom/theme-sdk');
  return actual;
});

import { LocaleProvider } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import HomeSectionsPage from '../home-sections';

// ── helpers ────────────────────────────────────────────────────────────────────

function setRole(role: string | null) {
  useAuthStore
    .getState()
    .setUser(role ? { id: 'u1', email: 'u@x.io', name: 'U', role, totpEnabled: false } : null);
}

const HERO_SECTION = {
  type: 'hero-banner' as const,
  settings: {
    headline: 'Welcome',
    subheadline: 'Shop now',
    imageUrl: undefined,
    ctaLabel: 'Shop',
    ctaHref: '/products',
    align: 'center' as const,
    overlay: false,
  },
};

const CTA_SECTION = {
  type: 'cta-banner' as const,
  settings: {
    headline: 'Big Sale',
    ctaLabel: 'Buy now',
    ctaHref: '/sale',
  },
};

const GET_RESPONSE = {
  sections: [HERO_SECTION, CTA_SECTION],
  updatedAt: '2026-06-27T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/home-sections']}>
          <HomeSectionsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  localStorage.clear();
  setRole('owner');
});

// ── specs ──────────────────────────────────────────────────────────────────────

describe('HomeSectionsPage', () => {
  it('renders loaded sections from GET /admin/v1/storefront/home-sections', async () => {
    apiFetch.mockResolvedValue(GET_RESPONSE);
    renderPage();

    // Both section cards appear
    expect(await screen.findByDisplayValue('Welcome')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Big Sale')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/admin/v1/storefront/home-sections');
  });

  it('adds a new section when the merchant picks a type', async () => {
    apiFetch.mockResolvedValue({ sections: [], updatedAt: '2026-06-27T00:00:00.000Z' });
    renderPage();

    // Wait for the "Add section" button to appear (sections loaded, not loading any more)
    const addBtn = await screen.findByRole('button', { name: /add section/i });
    await userEvent.click(addBtn);

    const richTextOption = await screen.findByRole('option', { name: /rich.?text/i });
    await userEvent.click(richTextOption);

    // A rich-text field (markdown textarea) should appear
    expect(screen.getByLabelText(/markdown/i)).toBeInTheDocument();
  });

  it('reorders sections with up/down buttons', async () => {
    apiFetch.mockResolvedValue(GET_RESPONSE);
    renderPage();

    // Wait for both sections to load
    await screen.findByDisplayValue('Welcome');

    // The second section ("Big Sale") should have an enabled "up" button; clicking it moves it first.
    // First section's move-up is disabled; second section's is enabled.
    const allUpButtons = screen.getAllByRole('button', { name: /move up/i });
    // Find the first enabled move-up button
    const enabledUp = allUpButtons.find((b) => !(b as HTMLButtonElement).disabled);
    expect(enabledUp).toBeDefined();
    await userEvent.click(enabledUp!);

    // After move up, "Big Sale" headline field should now come first in the DOM.
    // headline inputs are the first text inputs in each section card.
    const headlineInputs = screen.getAllByRole('textbox');
    const headlines = headlineInputs.filter((el) =>
      ['Welcome', 'Big Sale'].includes((el as HTMLInputElement).value),
    );
    // "Big Sale" should be before "Welcome"
    expect((headlines[0] as HTMLInputElement).value).toBe('Big Sale');
    expect((headlines[1] as HTMLInputElement).value).toBe('Welcome');
  });

  it('removes a section via the remove button', async () => {
    apiFetch.mockResolvedValue(GET_RESPONSE);
    renderPage();

    await screen.findByDisplayValue('Welcome');

    // Remove the first section
    const removeButtons = screen.getAllByRole('button', { name: /remove section/i });
    await userEvent.click(removeButtons[0]!);

    // "Welcome" hero headline should be gone
    expect(screen.queryByDisplayValue('Welcome')).not.toBeInTheDocument();
    // CTA section stays
    expect(screen.getByDisplayValue('Big Sale')).toBeInTheDocument();
  });

  it('sends the correct {type,settings}[] payload on Save', async () => {
    apiFetch.mockResolvedValue(GET_RESPONSE);
    const savedPayload: unknown[] = [];
    apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        savedPayload.push(JSON.parse(init.body as string));
        return GET_RESPONSE;
      }
      return GET_RESPONSE;
    });
    renderPage();

    await screen.findByDisplayValue('Welcome');

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/v1/storefront/home-sections',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    // The body is {sections: [{type,settings},...]}, sections must match the loaded data
    const body = savedPayload[0] as { sections: { type: string }[] };
    expect(body.sections[0]?.type).toBe('hero-banner');
    expect(body.sections[1]?.type).toBe('cta-banner');
  });

  it('surfaces a 422 validation error from the API as an error message', async () => {
    // GET succeeds; PUT returns 422
    apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        // Simulate ApiError 422
        const { ApiError } = await import('@/lib/api');
        throw new ApiError('Validation failed', 422, { message: 'Validation failed' });
      }
      return GET_RESPONSE;
    });
    renderPage();

    await screen.findByDisplayValue('Welcome');

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await userEvent.click(saveBtn);

    // An error alert should be visible — not a silent no-op
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('sets an image field from the upload response URL', async () => {
    apiFetch.mockImplementation(async (path: string, _init?: RequestInit) => {
      if (path === '/admin/v1/images') {
        return { variants: { original: 'https://example.com/img.jpg' } };
      }
      return GET_RESPONSE;
    });
    renderPage();

    await screen.findByDisplayValue('Welcome');

    // Find the hero image upload input (file input)
    const fileInputs = document.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThan(0);

    const file = new File(['img'], 'test.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInputs[0]!, { target: { files: [file] } });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/admin/v1/images',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // After upload, the imageUrl field should contain the returned URL
    await waitFor(() => {
      const imgInput = screen.queryByDisplayValue('https://example.com/img.jpg');
      expect(imgInput).toBeInTheDocument();
    });
  });

  it('nav item (themes:write) is visible for owner but hidden for staff', async () => {
    // The nav item visibility is enforced via `can(role, "themes:write")` in sidebar.tsx.
    // Here we test that the permission resolves correctly.
    const { can } = await import('@/lib/permissions');
    expect(can('owner', 'themes:write')).toBe(true);
    expect(can('admin', 'themes:write')).toBe(true);
    expect(can('staff', 'themes:write')).toBe(false);
  });
});
