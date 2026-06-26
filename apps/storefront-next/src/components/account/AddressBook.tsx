'use client';

/**
 * customer address book (list + create + edit + delete).
 *
 * Authentication:
 *   - fetches the authoritative list via GET /store/v1/customers/me/addresses (already on fetchAddresses
 *     in auth-context, but here we need mutation access too so we build our own client via createBrowserClient).
 *   - every call (list + mutations) follows the 401→refresh()-once-in-its-own-try/catch→retry pattern
 *     (mirroring OrderDetail.tsx:103-134 exactly). If refresh() throws or the retry is still 401, we
 *     land on the error state — never spinning forever.
 *
 * Post-mutation: always REFETCH the authoritative list (the server reassigns default-of-type, so
 * optimistic mutation would get out of sync). No optimistic updates.
 *
 * UX:
 *   - list grouped by type (Shipping / Billing), with a "Default" badge.
 *   - "Add address" opens the create form; Edit opens with prefill.
 *   - Delete: inline confirm step ("Delete this address? [Confirm delete] [Cancel]").
 *   - States: loading, empty, error banner, per-action pending.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { createBrowserClient } from '@/lib/browser-client';
import { createAddress, updateAddress, deleteAddress } from '@/lib/addresses';
import { toAddressInput } from '@/lib/checkout-form';
import type { SavedAddress } from '@/lib/auth-context';
import type { AddressFormSubmitPayload } from './AddressForm';
import { AddressForm } from './AddressForm';

type ViewState = 'loading' | 'list' | 'error';
type FormMode = { mode: 'create' } | { mode: 'edit'; address: SavedAddress } | null;

export function AddressBook(): React.ReactElement {
  const t = useTranslations('account.addresses');
  const { getAccessToken, refresh } = useAuth();

  const clientRef = useRef(createBrowserClient({ getAccessToken }));

  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // id of the address currently showing the delete confirm step
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // --- 401-aware fetch helper (mirrors OrderDetail.tsx:103-134) ---
  async function fetchList(isRetry = false): Promise<void> {
    try {
      const result = await clientRef.current.request<
        '/store/v1/customers/me/addresses',
        'get',
        SavedAddress[]
      >('get', '/store/v1/customers/me/addresses');
      setAddresses(result);
      setViewState('list');
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401 && !isRetry) {
        try {
          await refresh();
          return await fetchList(true);
        } catch {
          setViewState('error');
          return;
        }
      }
      setViewState('error');
    }
  }

  // 401-aware mutation wrapper: wraps any async mutation with the same refresh-once pattern.
  async function withRefresh<T>(fn: () => Promise<T>, isRetry = false): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401 && !isRetry) {
        try {
          await refresh();
          return await withRefresh(fn, true);
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  useEffect(() => {
    void fetchList();
    // Mount-only: fetchList is defined in the component body and captures stable refs via closure.
    // Adding it as a dep would cause an infinite loop (it updates state that re-renders the component).
  }, []); // eslint-disable-line -- mount-only effect, fetchList is stable via ref

  // --- Mutations ---
  async function handleFormSubmit(payload: AddressFormSubmitPayload): Promise<void> {
    setFormPending(true);
    setFormError(null);

    // Convert form values to API input (handles optional field trimming, country uppercasing).
    const addressFields = toAddressInput(payload.fields);
    // Strip optional empty/null values so the API's .min(1) constraints are not triggered.
    const opt = (v: string | null | undefined): string | undefined => {
      if (v == null) return undefined;
      return v.trim() === '' ? undefined : v;
    };

    try {
      if (formMode?.mode === 'edit') {
        await withRefresh(() =>
          updateAddress(clientRef.current, formMode.address.id, {
            type: payload.type,
            isDefault: payload.isDefault,
            name: addressFields.name,
            line1: addressFields.line1,
            city: addressFields.city,
            postalCode: addressFields.postalCode,
            country: addressFields.country,
            company: opt(addressFields.company),
            line2: opt(addressFields.line2),
            region: opt(addressFields.region),
            phone: opt(addressFields.phone),
          }),
        );
      } else {
        await withRefresh(() =>
          createAddress(clientRef.current, {
            type: payload.type,
            isDefault: payload.isDefault,
            name: addressFields.name,
            line1: addressFields.line1,
            city: addressFields.city,
            postalCode: addressFields.postalCode,
            country: addressFields.country,
            company: opt(addressFields.company),
            line2: opt(addressFields.line2),
            region: opt(addressFields.region),
            phone: opt(addressFields.phone),
          }),
        );
      }
      // Always refetch the authoritative list — server may have reassigned the default of this type.
      await fetchList();
      setFormMode(null);
    } catch {
      setFormError(t('saveError'));
    } finally {
      setFormPending(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setDeletePending(true);
    try {
      await withRefresh(() => deleteAddress(clientRef.current, id));
      setPendingDeleteId(null);
      await fetchList();
    } catch {
      // On delete failure show a general error banner. Keep the list visible. Use the DELETE-specific
      // wording — "could not save" would be wrong for a deletion.
      setFormError(t('deleteError'));
      setPendingDeleteId(null);
    } finally {
      setDeletePending(false);
    }
  }

  // --- Render helpers ---
  function AddressCard({ address }: { address: SavedAddress }): React.ReactElement {
    const isConfirming = pendingDeleteId === address.id;
    return (
      <div
        className="flex flex-col gap-2 rounded-md border border-border p-4"
        data-testid="address-card"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            {address.isDefault ? (
              <span
                data-testid="default-badge"
                className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
              >
                {t('defaultBadge')}
              </span>
            ) : null}
            <address className="text-sm text-foreground not-italic leading-relaxed">
              <span className="block font-medium">{address.name}</span>
              {address.company ? <span className="block">{address.company}</span> : null}
              <span className="block">{address.line1}</span>
              {address.line2 ? <span className="block">{address.line2}</span> : null}
              <span className="block">
                {[address.postalCode, address.city].filter(Boolean).join(' ')}
              </span>
              {address.region ? <span className="block">{address.region}</span> : null}
              <span className="block">{address.country}</span>
              {address.phone ? <span className="block">{address.phone}</span> : null}
            </address>
          </div>
        </div>

        {!isConfirming ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setFormMode({ mode: 'edit', address });
                setFormError(null);
              }}
              className="text-sm font-medium text-primary underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('editButton')}
            </button>
            <button
              type="button"
              onClick={() => setPendingDeleteId(address.id)}
              className="text-sm font-medium text-destructive underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('deleteButton')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="delete-confirm">
            <p className="text-sm text-foreground">{t('confirmDeletePrompt')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={deletePending}
                aria-busy={deletePending || undefined}
                onClick={() => void handleDelete(address.id)}
                className="text-sm font-medium text-destructive underline hover:no-underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('confirmDelete')}
              </button>
              <button
                type="button"
                disabled={deletePending}
                onClick={() => setPendingDeleteId(null)}
                className="text-sm font-medium text-foreground underline hover:no-underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function AddressGroup({
    label,
    addrs,
  }: {
    label: string;
    addrs: SavedAddress[];
  }): React.ReactElement | null {
    if (addrs.length === 0) return null;
    return (
      <section aria-label={label}>
        <h2 className="mb-3 text-xs font-semibold uppercase text-muted-foreground">{label}</h2>
        <div className="flex flex-col gap-3">
          {addrs.map((a) => (
            <AddressCard key={a.id} address={a} />
          ))}
        </div>
      </section>
    );
  }

  // --- Loading state ---
  if (viewState === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="addresses-loading">
        {t('loading')}
      </p>
    );
  }

  // --- Error state (initial load failed) ---
  if (viewState === 'error') {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        data-testid="addresses-error"
      >
        {t('loadError')}
      </p>
    );
  }

  const shipping = addresses.filter((a) => a.type === 'shipping');
  const billing = addresses.filter((a) => a.type === 'billing');

  return (
    <div className="flex flex-col gap-8" data-testid="address-book">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
        {formMode === null ? (
          <button
            type="button"
            onClick={() => {
              setFormMode({ mode: 'create' });
              setFormError(null);
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('addButton')}
          </button>
        ) : null}
      </div>

      {/* Mutation-level error banner (not a load error) */}
      {formError && formMode === null ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </div>
      ) : null}

      {/* Create / Edit form */}
      {formMode !== null ? (
        <section aria-label={formMode.mode === 'edit' ? t('editButton') : t('addButton')}>
          <AddressForm
            initial={formMode.mode === 'edit' ? formMode.address : undefined}
            pending={formPending}
            error={formError}
            onSubmit={handleFormSubmit}
            onCancel={() => {
              setFormMode(null);
              setFormError(null);
            }}
          />
        </section>
      ) : null}

      {/* Empty state */}
      {formMode === null && addresses.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="addresses-empty">
          {t('empty')}
        </p>
      ) : null}

      {/* Address groups */}
      {formMode === null ? (
        <>
          <AddressGroup label={t('shippingType')} addrs={shipping} />
          <AddressGroup label={t('billingType')} addrs={billing} />
        </>
      ) : null}
    </div>
  );
}
