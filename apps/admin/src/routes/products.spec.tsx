import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProductsPage from './products';

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const PRODUCT_LIST = {
  data: [
    {
      id: 'p1',
      title: 'Test Shirt',
      slug: 'test-shirt',
      status: 'published' as const,
      createdAt: '2026-06-01T00:00:00Z',
      variants: [
        {
          id: 'v1',
          sku: 'S1',
          title: null,
          priceAmount: 1999,
          currency: 'EUR',
          stockQuantity: 10,
          position: 1,
        },
      ],
      images: [],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

describe('ProductsPage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('Q4: surfaces a delete error to the user instead of swallowing it', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(PRODUCT_LIST) // initial list fetch
      .mockRejectedValueOnce(new Error('Server error')); // delete call fails

    const user = userEvent.setup();
    render(<ProductsPage />, { wrapper: wrapper() });

    await waitFor(() => expect(screen.getByText('Test Shirt')).toBeInTheDocument());

    // Open delete confirmation dialog via the Trash icon button (aria-label="Delete")
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Confirm the delete — click the destructive "Delete" button inside the dialog
    const confirmBtn = screen.getAllByRole('button', { name: /delete/i }).at(-1)!;
    await user.click(confirmBtn);

    // Error must be surfaced to the user (not silently swallowed)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
