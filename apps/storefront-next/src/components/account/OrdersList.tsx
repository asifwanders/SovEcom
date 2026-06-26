'use client';

/**
 * customer order history list.
 *
 * MONEY-CRITICAL: Every totalAmount is an integer in MINOR UNITS from the server. It is rendered
 * ONLY via `formatPrice(amount, currency, locale)` — never divided, summed, or transformed
 * client-side. The "1999 EUR → €19.99" test is the canonical guard for this invariant.
 *
 * Auth: `AccountGate` in the layout ensures only authenticated customers reach this island. On
 * a 401 we call `useAuth().refresh()` once and retry — on repeated failure we show an error state.
 *
 * StrictMode: the `ranRef` guard prevents double-fetch in React StrictMode (same pattern as
 * `CheckoutSuccess`).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { formatPrice } from '@/lib/api';
import { useOrderStatusTranslator } from '@/lib/order-status';
import type { OrderView } from '@/lib/payment-types';

type LoadState = 'loading' | 'loaded' | 'error';

/**
 * A single row in the order list table. Receives the already-bound translator + locale from the
 * parent so it does NOT re-call `useTranslations`/`useOrderStatusTranslator` per row (NIT #5).
 */
function OrderRow({
  order,
  viewDetailsLabel,
  translateStatus,
  locale,
}: {
  order: OrderView;
  viewDetailsLabel: string;
  translateStatus: (status: string) => string;
  locale: string;
}): React.ReactElement {
  const dateStr = (() => {
    const iso = order.placedAt ?? order.createdAt;
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
    } catch {
      return iso;
    }
  })();

  return (
    <tr>
      <td className="py-3 pe-4 text-sm font-medium text-foreground">{order.orderNumber}</td>
      <td className="py-3 pe-4 text-sm text-muted-foreground">{dateStr}</td>
      <td className="py-3 pe-4 text-sm text-foreground">{translateStatus(order.status)}</td>
      <td
        className="py-3 pe-4 text-end tabular-nums text-sm text-foreground"
        data-testid="order-total"
      >
        {formatPrice(order.totalAmount, order.currency, locale)}
      </td>
      <td className="py-3 text-end text-sm">
        <Link href={`/account/orders/${order.id}`} className="font-medium text-primary underline">
          {viewDetailsLabel}
        </Link>
      </td>
    </tr>
  );
}

export function OrdersList(): React.ReactElement {
  const t = useTranslations('account.orders');
  const locale = useLocale();
  const translateStatus = useOrderStatusTranslator();
  const { getAccessToken, refresh } = useAuth();
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const clientRef = useRef(createBrowserClient({ getAccessToken }));
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const fetchOrders = async (isRetry = false): Promise<void> => {
      try {
        const result = await clientRef.current.request<'/store/v1/orders', 'get', OrderView[]>(
          'get',
          '/store/v1/orders',
        );
        setOrders(result);
        setState('loaded');
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          // One silent refresh + retry. `refresh()` re-throws network/5xx errors (auth-context), so
          // guard the retry: a refresh failure must land on the error state, never spin forever (NIT #1).
          try {
            await refresh();
            return await fetchOrders(true);
          } catch {
            setState('error');
            return;
          }
        }
        setState('error');
      }
    };

    void fetchOrders();
  }, [getAccessToken, refresh]);

  if (state === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="orders-loading">
        {t('loading')}
      </p>
    );
  }

  if (state === 'error') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="orders-error">
        {t('loadError')}
      </p>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="orders-empty">
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
        <Link href="/products" className="text-sm font-medium text-primary underline">
          {t('shopLink')}
        </Link>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-start">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-muted-foreground">
              <th scope="col" className="pb-2 pe-4 font-medium text-start">
                {t('orderNumber')}
              </th>
              <th scope="col" className="pb-2 pe-4 font-medium text-start">
                {t('date')}
              </th>
              <th scope="col" className="pb-2 pe-4 font-medium text-start">
                {t('status')}
              </th>
              <th scope="col" className="pb-2 pe-4 font-medium text-end">
                {t('total')}
              </th>
              <th scope="col" className="pb-2 font-medium text-end">
                <span className="sr-only">{t('viewDetails')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                viewDetailsLabel={t('viewDetails')}
                translateStatus={translateStatus}
                locale={locale}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
