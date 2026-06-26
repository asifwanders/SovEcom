'use client';

/**
 * customer order detail.
 *
 * MONEY-CRITICAL: All `*Amount` fields are integer MINOR UNITS straight from the server.
 * They are rendered ONLY via `formatPrice` — no client-side arithmetic, no /100, no summing.
 * Server values rendered verbatim: subtotalAmount, discountAmount, shippingAmount, taxAmount,
 * totalAmount, unitPriceAmount, lineTotalAmount.
 *
 * Addresses are JSONB snapshots typed `unknown` — narrowed defensively via `asAddress()`.
 *
 * 404: shown as a "not found" friendly state (forbidden/IDOR looks the same to the client).
 * 401: one refresh() retry, then error state.
 *
 * Invoice PDF download is delegated to <InvoiceDownloadButton>, which issues its own
 * raw credentialed fetch (the PDF blob can't ride client-js's JSON transport). This component does
 * NOT fetch or compute the invoice — it only passes the order id/number/status.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { formatPrice } from '@/lib/api';
import { useOrderStatusTranslator, orderIsReturnable } from '@/lib/order-status';
import { InvoiceDownloadButton } from './InvoiceDownloadButton';
import type { OrderView, OrderAddressView } from '@/lib/payment-types';

type LoadState = 'loading' | 'loaded' | 'notfound' | 'error';

/** Safely narrow an `unknown` JSONB address blob to `OrderAddressView`. */
function asAddress(raw: unknown): OrderAddressView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    name: typeof r.name === 'string' ? r.name : undefined,
    company: typeof r.company === 'string' ? r.company : null,
    line1: typeof r.line1 === 'string' ? r.line1 : undefined,
    line2: typeof r.line2 === 'string' ? r.line2 : null,
    city: typeof r.city === 'string' ? r.city : undefined,
    postalCode: typeof r.postalCode === 'string' ? r.postalCode : undefined,
    region: typeof r.region === 'string' ? r.region : null,
    country: typeof r.country === 'string' ? r.country : undefined,
    phone: typeof r.phone === 'string' ? r.phone : null,
  };
}

function AddressBlock({
  address,
  testId,
  label,
}: {
  address: OrderAddressView;
  testId: string;
  label: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{label}</h3>
      <address className="text-sm text-foreground not-italic leading-relaxed">
        {address.name ? <span className="block">{address.name}</span> : null}
        {address.company ? <span className="block">{address.company}</span> : null}
        {address.line1 ? <span className="block">{address.line1}</span> : null}
        {address.line2 ? <span className="block">{address.line2}</span> : null}
        {address.city || address.postalCode ? (
          <span className="block">
            {[address.postalCode, address.city].filter(Boolean).join(' ')}
          </span>
        ) : null}
        {address.region ? <span className="block">{address.region}</span> : null}
        {address.country ? <span className="block">{address.country}</span> : null}
        {address.phone ? <span className="block">{address.phone}</span> : null}
      </address>
    </div>
  );
}

export interface OrderDetailProps {
  orderId: string;
}

export function OrderDetail({ orderId }: OrderDetailProps): React.ReactElement {
  const t = useTranslations('account.orders');
  const locale = useLocale();
  const translatedStatus = useOrderStatusTranslator();
  const { getAccessToken, refresh } = useAuth();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const clientRef = useRef(createBrowserClient({ getAccessToken }));
  // Run-guard keyed on the orderId currently being fetched. This still suppresses the StrictMode
  // double-invoke for the SAME id, but a NEW id (order→order navigation without remount) re-runs
  // the fetch instead of showing the stale order.
  const fetchedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (fetchedIdRef.current === orderId) return;
    fetchedIdRef.current = orderId;
    // A new id: reset to the loading state so the stale order is not shown while the new one loads.
    setState('loading');
    setOrder(null);

    const fetchOrder = async (isRetry = false): Promise<void> => {
      try {
        const result = await clientRef.current.request<'/store/v1/orders/{id}', 'get', OrderView>(
          'get',
          '/store/v1/orders/{id}',
          { path: { id: orderId } },
        );
        setOrder(result);
        setState('loaded');
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          // One silent refresh + retry. `refresh()` re-throws network/5xx errors (auth-context), so
          // guard the retry: a refresh failure must land on the ERROR state, never spin forever.
          try {
            await refresh();
            return await fetchOrder(true);
          } catch {
            setState('error');
            return;
          }
        }
        if (status === 404 || status === 403) {
          setState('notfound');
          return;
        }
        setState('error');
      }
    };

    void fetchOrder();
  }, [orderId, getAccessToken, refresh]);

  const price = (minor: number): string =>
    order ? formatPrice(minor, order.currency, locale) : '';

  const formatDate = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  if (state === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="order-detail-loading">
        {t('loading')}
      </p>
    );
  }

  if (state === 'notfound') {
    return (
      <div className="flex flex-col gap-3" data-testid="order-not-found">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link href="/account/orders" className="text-sm font-medium text-primary underline">
          {t('backToOrders')}
        </Link>
      </div>
    );
  }

  if (state === 'error' || !order) {
    return (
      <div className="flex flex-col gap-3" data-testid="order-error">
        <p className="text-sm text-muted-foreground">{t('loadError')}</p>
        <Link href="/account/orders" className="text-sm font-medium text-primary underline">
          {t('backToOrders')}
        </Link>
      </div>
    );
  }

  const shippingAddr = asAddress(order.shippingAddress);
  const billingAddr = asAddress(order.billingAddress);
  const dateStr = formatDate(order.placedAt ?? order.createdAt);
  const hasTracking = !!order.trackingNumber;

  return (
    <div className="flex flex-col gap-8" data-testid="order-detail">
      {/* Header */}
      <header className="flex flex-col gap-1">
        <nav className="text-sm">
          <Link href="/account/orders" className="text-primary underline">
            {t('backToOrders')}
          </Link>
        </nav>
        <h1 className="text-xl font-bold text-foreground">{order.orderNumber}</h1>
        <p className="text-sm text-muted-foreground">{dateStr}</p>
        <p className="text-sm font-medium text-foreground">{translatedStatus(order.status)}</p>
      </header>

      {/* Line items */}
      <section aria-label={t('items')}>
        <h2 className="mb-3 text-sm font-semibold uppercase text-muted-foreground">{t('items')}</h2>
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase text-muted-foreground">
              <th scope="col" className="pb-2 pe-4 font-medium text-start">
                {t('product')}
              </th>
              <th scope="col" className="pb-2 pe-4 font-medium text-end">
                {t('quantity')}
              </th>
              <th scope="col" className="pb-2 pe-4 font-medium text-end">
                {t('unitPrice')}
              </th>
              <th scope="col" className="pb-2 font-medium text-end">
                {t('lineTotal')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(order.items ?? []).map((item) => (
              <tr key={item.id}>
                <td className="py-3 pe-4 text-foreground">
                  <span className="font-medium">{item.productTitle}</span>
                  {item.variantTitle ? (
                    <span className="block text-xs text-muted-foreground">{item.variantTitle}</span>
                  ) : null}
                </td>
                <td className="py-3 pe-4 tabular-nums text-end text-foreground">{item.quantity}</td>
                <td
                  className="py-3 pe-4 tabular-nums text-end text-foreground"
                  data-testid="unit-price"
                >
                  {price(item.unitPriceAmount)}
                </td>
                <td className="py-3 tabular-nums text-end text-foreground" data-testid="line-total">
                  {price(item.lineTotalAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Totals breakdown — server values only, no client arithmetic */}
      <section
        aria-label={t('grandTotal')}
        className="flex flex-col gap-2 border-t border-border pt-4"
      >
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('subtotal')}</span>
          <span className="tabular-nums text-foreground" data-testid="totals-subtotal">
            {price(order.subtotalAmount)}
          </span>
        </div>

        {/* Discount row — only shown when discountAmount > 0 */}
        {order.discountAmount > 0 ? (
          <div className="flex justify-between text-sm" data-testid="totals-discount">
            <span className="text-muted-foreground">
              {t('discount')}
              {order.discountCode ? (
                <span className="ms-1 rounded bg-muted px-1 py-0.5 text-xs font-mono">
                  {order.discountCode}
                </span>
              ) : null}
            </span>
            <span className="tabular-nums text-foreground">−{price(order.discountAmount)}</span>
          </div>
        ) : null}

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('shipping')}</span>
          <span className="tabular-nums text-foreground" data-testid="totals-shipping">
            {price(order.shippingAmount)}
          </span>
        </div>

        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('tax')}</span>
          <span className="tabular-nums text-foreground" data-testid="totals-tax">
            {price(order.taxAmount)}
          </span>
        </div>

        <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
          <span className="text-foreground">{t('grandTotal')}</span>
          <span className="tabular-nums text-foreground" data-testid="totals-grand">
            {price(order.totalAmount)}
          </span>
        </div>
      </section>

      {/* Tracking */}
      {hasTracking ? (
        <section className="flex flex-col gap-1" data-testid="tracking-info">
          <h2 className="text-xs font-semibold uppercase text-muted-foreground">{t('tracking')}</h2>
          <p className="text-sm text-foreground">{order.trackingNumber}</p>
          {order.carrier ? (
            <p className="text-sm text-muted-foreground">
              {t('carrier')}: {order.carrier}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Address blocks */}
      <div className="grid gap-6 sm:grid-cols-2">
        {shippingAddr ? (
          <AddressBlock
            address={shippingAddr}
            testId="shipping-address"
            label={t('shippingAddress')}
          />
        ) : null}
        {billingAddr ? (
          <AddressBlock
            address={billingAddr}
            testId="billing-address"
            label={t('billingAddress')}
          />
        ) : null}
      </div>

      {/* Invoice PDF download — self-contained; hides itself for pending_payment orders. */}
      <InvoiceDownloadButton
        orderId={order.id}
        orderNumber={order.orderNumber}
        status={order.status}
      />

      {/* Return / 14-day withdrawal request entry-point — shown ONLY when the order is in a
          returnable status. The destination page re-checks eligibility (a direct nav to a
          non-returnable order's returns page shows a not-eligible message instead of the form). */}
      {orderIsReturnable(order.status) ? (
        <Link
          href={`/account/orders/${order.id}/returns`}
          data-testid="request-return-link"
          className="text-sm font-medium text-primary underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('requestReturn')}
        </Link>
      ) : null}
    </div>
  );
}
