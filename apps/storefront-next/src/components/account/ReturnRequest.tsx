'use client';

/**
 * customer return / 14-day right-of-withdrawal request UI.
 *
 * REFUND-PATH-ADJACENT: the request this component submits feeds the admin approve→refund flow. The
 * component therefore does NO money math and computes NO refund — it relays a request and reads back
 * the server's authoritative response (`status`, `withinWithdrawalWindow`). Unit prices are display-
 * only via `formatPrice`.
 *
 * Authority lives on the server:
 *   - Returnable status is enforced server-side (422 on a non-returnable order). This component
 *     mirrors that gate via `orderIsReturnable` for a friendly not-eligible state when a user
 *     navigates directly to a non-returnable order's returns page — it is NOT the source of truth.
 *   - The order-item response does NOT expose `refundedQuantity`, so the qty input caps at the
 *     ORDERED quantity and we rely on the server's 422 ("quantity exceeds remaining") — whose message
 *     we surface verbatim — for the remaining-quantity guard.
 *
 * 401 handling mirrors OrderDetail/AddressBook: a single silent refresh()-in-its-own-try/catch then
 * retry; a refresh failure lands on the error state (never spins).
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { formatPrice } from '@/lib/api';
import { orderIsReturnable } from '@/lib/order-status';
import { createReturn, listReturns, apiErrorMessage } from '@/lib/returns';
import type { OrderView, ReturnView, ReturnStatus } from '@/lib/payment-types';

type LoadState = 'loading' | 'loaded' | 'error';
type ReturnType = 'return' | 'withdrawal';

interface ItemSelection {
  included: boolean;
  quantity: number;
}

const RETURN_STATUS_KEYS: ReturnStatus[] = ['requested', 'approved', 'rejected', 'refunded'];

export interface ReturnRequestProps {
  orderId: string;
}

export function ReturnRequest({ orderId }: ReturnRequestProps): React.ReactElement {
  const t = useTranslations('account.returns');
  const locale = useLocale();
  const { getAccessToken, refresh } = useAuth();
  const clientRef = useRef(createBrowserClient({ getAccessToken }));
  const fetchedIdRef = useRef<string | null>(null);

  const [state, setState] = useState<LoadState>('loading');
  const [order, setOrder] = useState<OrderView | null>(null);
  const [existingReturns, setExistingReturns] = useState<ReturnView[]>([]);

  // Form state
  const [type, setType] = useState<ReturnType>('return');
  const [selections, setSelections] = useState<Record<string, ItemSelection>>({});
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ReturnView | null>(null);
  const [validationError, setValidationError] = useState(false);

  const baseId = useId();
  const errorRef = useRef<HTMLDivElement>(null);
  // Synchronous in-flight guard (refund-path insurance): React state updates are async, so a fast
  // double-click could fire two POSTs before `submitting` flips. The ref flips synchronously so the
  // second handler returns immediately — exactly one return request is created (the server's CAS
  // backstops a double refund, but we avoid the duplicate `requested` row in the first place).
  const submittingRef = useRef(false);

  // --- 401-aware fetch helper (mirrors OrderDetail.tsx) ---
  useEffect(() => {
    if (fetchedIdRef.current === orderId) return;
    fetchedIdRef.current = orderId;
    setState('loading');
    setOrder(null);
    setExistingReturns([]);

    const load = async (isRetry = false): Promise<void> => {
      try {
        const [orderResult, returnsResult] = await Promise.all([
          clientRef.current.request<'/store/v1/orders/{id}', 'get', OrderView>(
            'get',
            '/store/v1/orders/{id}',
            { path: { id: orderId } },
          ),
          listReturns(clientRef.current, orderId),
        ]);
        setOrder(orderResult);
        setExistingReturns(returnsResult);
        // Default every line item to UNchecked (the customer opts items in), with the quantity
        // pre-seeded to the full ordered amount for when they do include it.
        const initial: Record<string, ItemSelection> = {};
        for (const item of orderResult.items ?? []) {
          initial[item.id] = { included: false, quantity: item.quantity };
        }
        setSelections(initial);
        setState('loaded');
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          try {
            await refresh();
            return await load(true);
          } catch {
            setState('error');
            return;
          }
        }
        setState('error');
      }
    };

    void load();
  }, [orderId, getAccessToken, refresh]);

  // Focus the submit error / validation banner when it appears.
  useEffect(() => {
    if (submitError || validationError) errorRef.current?.focus();
  }, [submitError, validationError]);

  async function refreshReturns(): Promise<void> {
    const run = async (isRetry = false): Promise<void> => {
      try {
        const result = await listReturns(clientRef.current, orderId);
        setExistingReturns(result);
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          try {
            await refresh();
            return await run(true);
          } catch {
            /* keep the prior list; non-fatal */
          }
        }
        /* non-fatal: the submit already succeeded */
      }
    };
    await run();
  }

  function toggleItem(id: string, included: boolean): void {
    setSelections((prev) => ({ ...prev, [id]: { ...prev[id]!, included } }));
  }

  function setItemQuantity(id: string, value: number, max: number): void {
    const clamped = Math.max(1, Math.min(Number.isFinite(value) ? value : 1, max));
    setSelections((prev) => ({ ...prev, [id]: { ...prev[id]!, quantity: clamped } }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting || !order) return;
    setSubmitError(null);
    setValidationError(false);
    // Clear any prior success banner so a subsequent 422 doesn't briefly show both the old success
    // and the new error.
    setSuccess(null);

    const items = (order.items ?? [])
      .filter((item) => selections[item.id]?.included)
      .map((item) => ({ orderItemId: item.id, quantity: selections[item.id]!.quantity }));

    if (items.length === 0) {
      setValidationError(true);
      return;
    }

    // Synchronous in-flight guard (after the items check so a no-op submit doesn't latch the ref).
    if (submittingRef.current) return;
    submittingRef.current = true;

    setSubmitting(true);
    const trimmedReason = reason.trim();

    const run = async (isRetry = false): Promise<ReturnView> => {
      try {
        return await createReturn(clientRef.current, orderId, {
          type,
          items,
          ...(trimmedReason !== '' ? { reason: trimmedReason } : {}),
        });
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 401 && !isRetry) {
          await refresh(); // a refresh failure rejects → caught below as a generic error
          return await run(true);
        }
        throw err;
      }
    };

    try {
      const created = await run();
      setSuccess(created);
      // Reset the form selections/reason so a re-submit is intentional.
      setReason('');
      setSelections((prev) => {
        const next: Record<string, ItemSelection> = {};
        for (const [id, sel] of Object.entries(prev)) next[id] = { ...sel, included: false };
        return next;
      });
      await refreshReturns();
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      // 422 = not returnable / quantity exceeds remaining → surface the server message verbatim.
      const serverMessage = status === 422 ? apiErrorMessage(err) : null;
      setSubmitError(serverMessage ?? (status === 422 ? t('errorOverQuantity') : t('saveError')));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const formatDate = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const returnStatusLabel = (status: ReturnStatus): string =>
    RETURN_STATUS_KEYS.includes(status) ? t(`status_${status}` as Parameters<typeof t>[0]) : status;

  if (state === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="return-loading">
        {t('loading')}
      </p>
    );
  }

  if (state === 'error' || !order) {
    return (
      <div className="flex flex-col gap-3" data-testid="return-error">
        <p className="text-sm text-muted-foreground">{t('loadError')}</p>
        <Link
          href={`/account/orders/${orderId}`}
          className="text-sm font-medium text-primary underline"
        >
          {t('backToOrder')}
        </Link>
      </div>
    );
  }

  const eligible = orderIsReturnable(order.status);

  return (
    <div className="flex flex-col gap-8" data-testid="return-request">
      <header className="flex flex-col gap-1">
        <nav className="text-sm">
          <Link
            href={`/account/orders/${order.id}`}
            className="text-primary underline"
            data-testid="return-back-link"
          >
            {t('backToOrder')}
          </Link>
        </nav>
        <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{order.orderNumber}</p>
      </header>

      {!eligible ? (
        <p
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
          data-testid="return-not-eligible"
        >
          {t('notEligible')}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>

          {/* Withdrawal legal info — links to the store-provided CMS legal page (best-practice EU
              default, pending legal review). No bespoke legal copy is embedded here. */}
          <div
            className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground"
            data-testid="withdrawal-info"
          >
            <p>{t('withdrawalInfo')}</p>
            <p className="mt-1">
              <Link href="/withdrawal" className="font-medium text-primary underline">
                {t('learnMore')}
              </Link>
            </p>
          </div>

          {success ? (
            <div
              role="status"
              data-testid="return-success"
              className="rounded-md border border-border bg-primary/5 px-3 py-3 text-sm text-foreground"
            >
              <p className="font-semibold">{t('successHeading')}</p>
              <p className="mt-1">
                {t('statusLabel')}: {returnStatusLabel(success.status)}
              </p>
              <p className="mt-1">
                {success.withinWithdrawalWindow ? t('withinWindowYes') : t('withinWindowNo')}
              </p>
            </div>
          ) : null}

          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-6"
            aria-busy={submitting || undefined}
            noValidate
            data-testid="return-form"
          >
            {submitError || validationError ? (
              <div
                ref={errorRef}
                tabIndex={-1}
                role="alert"
                data-testid={submitError ? 'return-submit-error' : 'return-validation-error'}
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {submitError ?? t('selectAtLeastOne')}
              </div>
            ) : null}

            {/* Type selector */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-semibold text-foreground">{t('typeLabel')}</legend>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="return-type"
                  value="return"
                  data-testid="type-return"
                  checked={type === 'return'}
                  disabled={submitting}
                  onChange={() => setType('return')}
                  className="h-4 w-4 border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {t('typeReturn')}
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="return-type"
                  value="withdrawal"
                  data-testid="type-withdrawal"
                  checked={type === 'withdrawal'}
                  disabled={submitting}
                  onChange={() => setType('withdrawal')}
                  className="h-4 w-4 border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {t('typeWithdrawal')}
              </label>
            </fieldset>

            {/* Item picker */}
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-semibold text-foreground">
                {t('selectItemsLegend')}
              </legend>
              <ul className="flex flex-col gap-3">
                {(order.items ?? []).map((item) => {
                  const sel = selections[item.id] ?? { included: false, quantity: item.quantity };
                  const qtyId = `${baseId}-qty-${item.id}`;
                  return (
                    <li
                      key={item.id}
                      className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <label className="flex items-start gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          data-testid={`include-${item.id}`}
                          checked={sel.included}
                          disabled={submitting}
                          onChange={(e) => toggleItem(item.id, e.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <span className="flex flex-col">
                          <span className="font-medium">{item.productTitle}</span>
                          {item.variantTitle ? (
                            <span className="text-xs text-muted-foreground">
                              {item.variantTitle}
                            </span>
                          ) : null}
                          <span className="text-xs text-muted-foreground">{item.sku}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatPrice(item.unitPriceAmount, order.currency, locale)}
                          </span>
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <label htmlFor={qtyId} className="text-xs text-muted-foreground">
                          {t('quantityLabel')}
                        </label>
                        <input
                          id={qtyId}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={item.quantity}
                          step={1}
                          data-testid={`qty-${item.id}`}
                          value={sel.quantity}
                          disabled={submitting || !sel.included}
                          onChange={(e) =>
                            setItemQuantity(item.id, parseInt(e.target.value, 10), item.quantity)
                          }
                          className="h-9 w-16 rounded-md border border-input bg-transparent px-2 py-1 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            {/* Reason */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${baseId}-reason`} className="text-sm font-medium text-foreground">
                {t('reasonLabel')}
              </label>
              <textarea
                id={`${baseId}-reason`}
                data-testid="return-reason"
                value={reason}
                maxLength={1000}
                rows={3}
                disabled={submitting}
                onChange={(e) => setReason(e.target.value)}
                className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            <div>
              <button
                type="submit"
                data-testid="return-submit"
                disabled={submitting}
                aria-disabled={submitting}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {submitting ? t('submitting') : t('submit')}
              </button>
            </div>
          </form>
        </>
      )}

      {/* Existing returns for this order */}
      {existingReturns.length > 0 ? (
        <section aria-label={t('existingReturnsHeading')} data-testid="existing-returns">
          <h2 className="mb-3 text-sm font-semibold uppercase text-muted-foreground">
            {t('existingReturnsHeading')}
          </h2>
          <ul className="flex flex-col gap-2">
            {existingReturns.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-0.5 rounded-md border border-border p-3 text-sm"
              >
                <span className="font-medium text-foreground">
                  {r.type === 'withdrawal' ? t('typeWithdrawal') : t('typeReturn')} —{' '}
                  {returnStatusLabel(r.status)}
                </span>
                <span className="text-xs text-muted-foreground">{formatDate(r.requestedAt)}</span>
                <span className="text-xs text-muted-foreground">
                  {t('itemsCount', { count: r.items.length })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
