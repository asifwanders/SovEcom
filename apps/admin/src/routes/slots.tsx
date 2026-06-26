/**
 * Follow-up C4 — Admin slot-resolution UI over the existing /admin/v1/slots endpoints.
 *
 * Read-only for `themes:read`; the resolve action requires `themes:write` (mirrors themes.tsx).
 * Renders the slot registry's two halves from ONE `GET /admin/v1/slots` ({ resolved, conflicts }):
 *   - Resolved slots — a read-only table: slot → winning module + its component.
 *   - Conflicts — each contested slot lists its candidate modules with a "Use this module" action
 *     that PUTs the pick to /admin/v1/slots/:slot/resolution then refetches, moving the slot from
 *     Conflicts → Resolved.
 *
 * Stale-pick safety: the service 404s (module no longer enabled) / 422s (no longer targets the
 * slot) when a pick names a module that has stopped being a candidate. We surface a friendly
 * "no longer a candidate — the list has been refreshed" message and refetch, never a raw error.
 * (No new endpoint; backend RBAC + audit already enforce the real authorization.)
 */
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { LayoutGrid } from 'lucide-react';

interface ResolvedSlot {
  slot: string;
  module: string;
  component: string;
}

interface SlotConflict {
  slot: string;
  candidates: Array<{ module: string; component: string }>;
}

interface SlotRegistryView {
  resolved: ResolvedSlot[];
  conflicts: SlotConflict[];
}

export default function SlotsPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'themes:write');

  const slotsQ = useQuery<SlotRegistryView>({
    queryKey: ['slots'],
    queryFn: () => apiFetch('/admin/v1/slots'),
  });

  const [err, setErr] = React.useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['slots'] });

  const resolve = useMutation({
    mutationFn: (v: { slot: string; module: string }) =>
      apiFetch(`/admin/v1/slots/${encodeURIComponent(v.slot)}/resolution`, {
        method: 'PUT',
        body: JSON.stringify({ module: v.module }),
      }),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: (e: unknown) => {
      // A 404 (module no longer enabled) / 422 (module no longer targets the slot) means the pick
      // went stale between the GET and this PUT — show a clear message and refetch so the now-correct
      // candidate list is shown, never a raw error. Other errors fall back to the generic message.
      if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
        setErr(t('slots', 'staleResolution'));
      } else {
        setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));
      }
      invalidate();
    },
  });

  const view = slotsQ.data ?? { resolved: [], conflicts: [] };
  const { resolved, conflicts } = view;
  const hasSlots = resolved.length > 0 || conflicts.length > 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'slots') },
        ]}
      />
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <LayoutGrid className="h-6 w-6" aria-hidden="true" />
          {t('slots', 'title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t('slots', 'subtitle')}</p>
      </div>

      {err && <Alert variant="destructive">{err}</Alert>}

      {slotsQ.isLoading && <p className="text-muted-foreground">{t('common', 'loading')}</p>}

      {slotsQ.isError && !slotsQ.isLoading && (
        <Alert variant="destructive">{t('common', 'genericError')}</Alert>
      )}

      {!slotsQ.isLoading && !slotsQ.isError && !hasSlots && (
        <Card className="p-6 text-center text-muted-foreground">{t('slots', 'emptyNoSlots')}</Card>
      )}

      {!slotsQ.isLoading && !slotsQ.isError && hasSlots && (
        <>
          {/* Conflicts — the slots that need an admin decision (shown first; the actionable half). */}
          <section className="space-y-2">
            <h2 className="text-lg font-medium">{t('slots', 'conflictsHeading')}</h2>
            {conflicts.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">{t('slots', 'allResolved')}</Card>
            ) : (
              <Card className="p-4 space-y-4">
                {conflicts.map((c) => (
                  <div key={c.slot} className="space-y-2">
                    <div className="font-medium font-mono text-sm">{c.slot}</div>
                    <table className="w-full text-sm">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left font-medium py-1">{t('slots', 'colModule')}</th>
                          <th className="text-left font-medium py-1">
                            {t('slots', 'colComponent')}
                          </th>
                          {canWrite && <th className="py-1" />}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {c.candidates.map((cand) => (
                          <tr key={cand.module}>
                            <td className="py-2 font-medium">{cand.module}</td>
                            <td className="py-2 text-muted-foreground font-mono">
                              {cand.component}
                            </td>
                            {canWrite && (
                              <td className="py-2 text-right whitespace-nowrap">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={resolve.isPending}
                                  onClick={() =>
                                    resolve.mutate({ slot: c.slot, module: cand.module })
                                  }
                                >
                                  {t('slots', 'useModule')}
                                </Button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </Card>
            )}
          </section>

          {/* Resolved — read-only view of which module fills each cleanly-resolved slot. */}
          <section className="space-y-2">
            <h2 className="text-lg font-medium">{t('slots', 'resolvedHeading')}</h2>
            {resolved.length === 0 ? (
              <Card className="p-4 text-sm text-muted-foreground">
                {t('slots', 'noneResolved')}
              </Card>
            ) : (
              <Card className="p-4">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left font-medium py-1">{t('slots', 'colSlot')}</th>
                      <th className="text-left font-medium py-1">{t('slots', 'colModule')}</th>
                      <th className="text-left font-medium py-1">{t('slots', 'colComponent')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {resolved.map((r) => (
                      <tr key={r.slot}>
                        <td className="py-2 font-medium font-mono">{r.slot}</td>
                        <td className="py-2">{r.module}</td>
                        <td className="py-2 text-muted-foreground font-mono">{r.component}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
