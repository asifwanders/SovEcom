/**
 * admin Content Page form specs.
 *
 * Covers: create submits a POST with the right body; edit prefills + submits a
 * PATCH; a 409 surfaces a duplicate-slug error; validation (empty title/slug)
 * blocks submit (no API call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const apiFetch = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      msg: string,
      public status: number,
      public body: unknown,
    ) {
      super(msg);
    }
  }
  return {
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    ApiError,
  };
});

import { ApiError } from '@/lib/api';
import { LocaleProvider } from '@/lib/i18n-context';
import PageFormPage from '../page-form';

function renderForm(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/pages/new" element={<PageFormPage />} />
            <Route path="/pages/:id" element={<PageFormPage />} />
            <Route path="/pages" element={<div>pages-list</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  localStorage.clear();
});

describe('PageFormPage (create)', () => {
  it('submits a POST with the right body', async () => {
    apiFetch.mockResolvedValue({ id: 'new-id' });
    renderForm('/pages/new');

    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'About Us');
    await userEvent.type(screen.getByRole('textbox', { name: 'Slug' }), 'about');
    await userEvent.type(screen.getByRole('textbox', { name: 'Body' }), '# Hello');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'published');

    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages', {
        method: 'POST',
        body: JSON.stringify({
          slug: 'about',
          title: 'About Us',
          body: '# Hello',
          locale: 'en',
          status: 'published',
          seoTitle: null,
          seoDescription: null,
        }),
      });
    });
    // Navigates to the list on success.
    expect(await screen.findByText('pages-list')).toBeInTheDocument();
  });

  it('blocks submit and shows a required error when title/slug are empty', async () => {
    renderForm('/pages/new');

    // Body present so only title+slug are missing.
    await userEvent.type(screen.getByRole('textbox', { name: 'Body' }), 'content');
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));

    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate-slug error on 409', async () => {
    apiFetch.mockRejectedValue(new ApiError('conflict', 409, null));
    renderForm('/pages/new');

    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Terms');
    await userEvent.type(screen.getByRole('textbox', { name: 'Slug' }), 'terms');
    await userEvent.type(screen.getByRole('textbox', { name: 'Body' }), 'body');
    await userEvent.click(screen.getByRole('button', { name: 'Create page' }));

    expect(
      await screen.findAllByText('A page with this slug already exists for this locale.'),
    ).not.toHaveLength(0);
  });
});

describe('PageFormPage (edit)', () => {
  const EXISTING = {
    id: 'p1',
    slug: 'terms',
    title: 'Terms of Service',
    body: '# Terms',
    locale: 'en',
    status: 'published',
    seoTitle: 'Terms SEO',
    seoDescription: null,
  };

  it('prefills from the fetched page and submits a PATCH', async () => {
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/admin/v1/pages/p1' && (!init || init.method === undefined)) {
        return Promise.resolve(EXISTING);
      }
      return Promise.resolve(undefined);
    });
    renderForm('/pages/p1');

    // Prefilled.
    expect(await screen.findByDisplayValue('Terms of Service')).toBeInTheDocument();
    expect(screen.getByDisplayValue('terms')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Terms SEO')).toBeInTheDocument();

    // Edit the title and save.
    const titleInput = screen.getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Updated Terms');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/admin/v1/pages/p1', {
        method: 'PATCH',
        body: JSON.stringify({
          slug: 'terms',
          title: 'Updated Terms',
          body: '# Terms',
          locale: 'en',
          status: 'published',
          seoTitle: 'Terms SEO',
          seoDescription: null,
        }),
      });
    });
  });
});
