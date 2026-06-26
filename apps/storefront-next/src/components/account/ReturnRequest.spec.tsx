/**
 * ReturnRequest component tests (REFUND-PATH-ADJACENT).
 *
 * The component never computes money or a refund — it relays a return/withdrawal REQUEST and reads
 * back the server's authoritative response. These tests assert: the item picker is built from the
 * fetched order; a non-returnable order shows the not-eligible message (no form); a submit posts the
 * EXACT body shape ({type, items:[{orderItemId,quantity}], reason}); submit is blocked with no item;
 * success surfaces the server `status` + `withinWithdrawalWindow`; a 422 surfaces the server message;
 * the 401→refresh()→retry loop works (and refresh-rejects → error); existing returns render; the FR
 * catalog renders; and the /withdrawal legal link is present.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { OrderView, ReturnView } from '@/lib/payment-types';

// --- Mock locale-aware Link ---
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// --- Auth mock ---
let getAccessToken: () => string | null = () => 'token-abc';
let refresh: () => Promise<string | null> = async () => 'token-abc';
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ getAccessToken, refresh }),
}));

// --- Browser client mock: routes by method+path so order vs returns are independently controllable.
let getOrder: (opts?: unknown) => Promise<unknown>;
let getReturns: (opts?: unknown) => Promise<unknown>;
let postReturn: (opts?: unknown) => Promise<unknown>;
vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({
    request: (method: string, path: string, opts?: unknown) => {
      if (path === '/store/v1/orders/{id}') return getOrder(opts);
      if (path === '/store/v1/customers/me/orders/{orderId}/returns') {
        return method === 'post' ? postReturn(opts) : getReturns(opts);
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  }),
  apiBaseUrl: () => 'http://api.test',
}));

import { ReturnRequest } from './ReturnRequest';

const ORDER: OrderView = {
  id: 'order-1',
  orderNumber: 'ORD-0001',
  status: 'delivered',
  currency: 'EUR',
  email: 'ada@example.com',
  subtotalAmount: 3998,
  discountAmount: 0,
  shippingAmount: 600,
  taxAmount: 720,
  totalAmount: 5318,
  shippingMethod: 'Standard',
  shippingAddress: null,
  billingAddress: null,
  placedAt: '2026-06-01T10:00:00.000Z',
  createdAt: '2026-06-01T10:00:00.000Z',
  items: [
    {
      id: 'item-1',
      productTitle: 'Blue T-Shirt',
      variantTitle: 'M / Blue',
      sku: 'SKU-001',
      quantity: 2,
      unitPriceAmount: 1999,
      lineTotalAmount: 3998,
    },
    {
      id: 'item-2',
      productTitle: 'Black Hoodie',
      variantTitle: null,
      sku: 'SKU-002',
      quantity: 1,
      unitPriceAmount: 4999,
      lineTotalAmount: 4999,
    },
  ],
};

const EXISTING_RETURN: ReturnView = {
  id: 'ret-1',
  orderId: 'order-1',
  type: 'return',
  status: 'requested',
  items: [{ orderItemId: 'item-1', quantity: 1 }],
  reason: 'Too small',
  withinWithdrawalWindow: true,
  requestedAt: '2026-06-05T10:00:00.000Z',
  refundId: null,
};

function apiError(status: number, body?: unknown): Error {
  return Object.assign(new Error(`SovEcom API ${status}`), { status, body });
}

beforeEach(() => {
  getAccessToken = () => 'token-abc';
  refresh = async () => 'token-abc';
  getOrder = async () => ORDER;
  getReturns = async () => [];
  postReturn = async () => ({
    ...EXISTING_RETURN,
    id: 'ret-new',
    items: [{ orderItemId: 'item-1', quantity: 1 }],
  });
});

describe('ReturnRequest', () => {
  it('renders the item picker built from the fetched order', async () => {
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-request')).toBeInTheDocument());
    expect(screen.getByText('Blue T-Shirt')).toBeInTheDocument();
    expect(screen.getByText('Black Hoodie')).toBeInTheDocument();
    // a type selector with both options
    expect(screen.getByTestId('return-form')).toBeInTheDocument();
  });

  it('shows the not-eligible message and NO form for a non-returnable order', async () => {
    getOrder = async () => ({ ...ORDER, status: 'cancelled' });
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-not-eligible')).toBeInTheDocument());
    expect(screen.queryByTestId('return-form')).not.toBeInTheDocument();
    // back-to-order link present
    expect(screen.getByRole('link', { name: /back to order/i })).toBeInTheDocument();
  });

  it('blocks submit when no item is selected', async () => {
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    const postSpy = vi.fn(async () => ({ ...EXISTING_RETURN }));
    postReturn = postSpy;
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('posts the correct body shape ({type, items, reason}) on submit', async () => {
    let captured: unknown = null;
    postReturn = async (opts) => {
      captured = (opts as { body?: unknown }).body;
      return { ...EXISTING_RETURN, id: 'ret-new' };
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());

    // Select item-1, set quantity to 2, choose withdrawal, add a reason.
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.change(screen.getByTestId('qty-item-1'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('type-withdrawal'));
    fireEvent.change(screen.getByTestId('return-reason'), { target: { value: 'Changed my mind' } });
    fireEvent.click(screen.getByTestId('return-submit'));

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({
      type: 'withdrawal',
      items: [{ orderItemId: 'item-1', quantity: 2 }],
      reason: 'Changed my mind',
    });
  });

  it('omits reason from the body when left blank', async () => {
    let captured: Record<string, unknown> | null = null;
    postReturn = async (opts) => {
      captured = (opts as { body?: Record<string, unknown> }).body ?? null;
      return { ...EXISTING_RETURN, id: 'ret-new' };
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.reason).toBeUndefined();
    expect(captured!.type).toBe('return');
  });

  it('shows a success confirmation with status and withinWithdrawalWindow=yes', async () => {
    postReturn = async () => ({
      ...EXISTING_RETURN,
      id: 'ret-new',
      status: 'requested',
      withinWithdrawalWindow: true,
    });
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-success')).toBeInTheDocument());
    const success = screen.getByTestId('return-success');
    expect(success.textContent).toMatch(/yes/i);
  });

  it('shows withinWithdrawalWindow=no when the server says so', async () => {
    postReturn = async () => ({
      ...EXISTING_RETURN,
      id: 'ret-new',
      status: 'requested',
      withinWithdrawalWindow: false,
    });
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-success')).toBeInTheDocument());
    expect(screen.getByTestId('return-success').textContent).toMatch(/no/i);
  });

  it('posts exactly once on two synchronous submit clicks (double-submit guard)', async () => {
    let calls = 0;
    // Hold the POST open so both clicks land while the first is still in-flight.
    let resolve!: (v: unknown) => void;
    postReturn = () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    const submit = screen.getByTestId('return-submit');
    fireEvent.click(submit);
    fireEvent.click(submit);
    // The synchronous ref guard must have blocked the second POST.
    expect(calls).toBe(1);
    resolve({ ...EXISTING_RETURN, id: 'ret-new' });
    await waitFor(() => expect(screen.getByTestId('return-success')).toBeInTheDocument());
  });

  it('surfaces a 422 whose body.message is a string ARRAY (joined)', async () => {
    postReturn = async () => {
      throw apiError(422, { message: ['Item A is not returnable', 'Item B quantity too high'] });
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-submit-error')).toBeInTheDocument());
    const text = screen.getByTestId('return-submit-error').textContent ?? '';
    expect(text).toContain('Item A is not returnable');
    expect(text).toContain('Item B quantity too high');
  });

  it('clamps a quantity typed above the ordered amount down to the ordered quantity', async () => {
    let captured: { items?: { quantity: number }[] } | null = null;
    postReturn = async (opts) => {
      captured = (opts as { body?: typeof captured }).body ?? null;
      return { ...EXISTING_RETURN, id: 'ret-new' };
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1')); // ordered quantity = 2
    fireEvent.change(screen.getByTestId('qty-item-1'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.items![0]!.quantity).toBe(2);
  });

  it('submits quantity 1 (not 0/NaN) when the quantity field is cleared', async () => {
    let captured: { items?: { quantity: number }[] } | null = null;
    postReturn = async (opts) => {
      captured = (opts as { body?: typeof captured }).body ?? null;
      return { ...EXISTING_RETURN, id: 'ret-new' };
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.change(screen.getByTestId('qty-item-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.items![0]!.quantity).toBe(1);
  });

  it('excludes an item from the POST body when checked then UNchecked', async () => {
    let captured: { items?: { orderItemId: string }[] } | null = null;
    postReturn = async (opts) => {
      captured = (opts as { body?: typeof captured }).body ?? null;
      return { ...EXISTING_RETURN, id: 'ret-new' };
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    // Include item-2, then include + UNinclude item-1 → only item-2 must be posted.
    fireEvent.click(screen.getByTestId('include-item-2'));
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(captured).not.toBeNull());
    const ids = captured!.items!.map((i) => i.orderItemId);
    expect(ids).toEqual(['item-2']);
  });

  it('surfaces the server 422 message inline (role=alert)', async () => {
    postReturn = async () => {
      throw apiError(422, {
        message: 'Quantity exceeds the remaining returnable amount',
        statusCode: 422,
      });
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-submit-error')).toBeInTheDocument());
    expect(screen.getByTestId('return-submit-error').textContent).toContain(
      'Quantity exceeds the remaining returnable amount',
    );
  });

  it('shows a generic error when a 422 carries no message', async () => {
    postReturn = async () => {
      throw apiError(422, {});
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-submit-error')).toBeInTheDocument());
    // localized fallback present (non-empty)
    expect(screen.getByTestId('return-submit-error').textContent?.length).toBeGreaterThan(0);
  });

  it('retries the initial load via refresh() on a 401', async () => {
    let orderCalls = 0;
    const refreshFn = vi.fn().mockResolvedValue('new-token');
    refresh = refreshFn;
    getOrder = async () => {
      orderCalls++;
      if (orderCalls === 1) throw apiError(401);
      return ORDER;
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it('shows the error state (not stuck loading) when refresh() rejects on a 401', async () => {
    refresh = vi.fn().mockRejectedValue(new Error('network down'));
    getOrder = async () => {
      throw apiError(401);
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-error')).toBeInTheDocument());
    expect(screen.queryByTestId('return-loading')).not.toBeInTheDocument();
  });

  it('renders the existing-returns list', async () => {
    getReturns = async () => [EXISTING_RETURN];
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('existing-returns')).toBeInTheDocument());
    expect(screen.getByTestId('existing-returns').textContent).toMatch(/requested/i);
  });

  it('refreshes the existing-returns list after a successful submit', async () => {
    let returnsCalls = 0;
    getReturns = async () => {
      returnsCalls++;
      return returnsCalls === 1 ? [] : [EXISTING_RETURN];
    };
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('include-item-1'));
    fireEvent.click(screen.getByTestId('return-submit'));
    await waitFor(() => expect(screen.getByTestId('return-success')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('existing-returns')).toBeInTheDocument());
  });

  it('renders a link to the /withdrawal legal page', async () => {
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'en');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/withdrawal');
    expect(link).toBeDefined();
  });

  it('renders the FR catalog', async () => {
    renderWithIntl(<ReturnRequest orderId="order-1" />, 'fr');
    await waitFor(() => expect(screen.getByTestId('return-form')).toBeInTheDocument());
    // FR submit label
    expect(screen.getByTestId('return-submit').textContent).toMatch(/Envoyer|Demander|demande/i);
  });
});
