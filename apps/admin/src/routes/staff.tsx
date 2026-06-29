import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { UserCog, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { UserView, UserListResponse } from './staff-types';
import { CreateDialog, ChangeRoleDialog, ConfirmDialog, extractApiError } from './staff-dialogs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roleBadgeVariant(role: UserView['role']): 'primary' | 'warning' | 'secondary' {
  if (role === 'owner') return 'primary';
  if (role === 'admin') return 'warning';
  return 'secondary';
}

function roleLabel(role: UserView['role']): string {
  if (role === 'owner') return t('staff', 'markerOwner');
  if (role === 'admin') return t('staff', 'roleAdmin');
  return t('staff', 'roleStaff');
}

function formatLastLogin(lastLoginAt: string | null): string {
  if (!lastLoginAt) return t('staff', 'neverLoggedIn');
  return new Date(lastLoginAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StaffPage() {
  const queryClient = useQueryClient();
  // UX-only gating — server enforces real authorization.
  const currentUser = useAuthStore((s) => s.user);
  const role = currentUser?.role ?? null;
  const canWrite = can(role, 'users:write');

  const [page, setPage] = React.useState(1);

  // Dialog state
  const [createOpen, setCreateOpen] = React.useState(false);
  const [changeRoleUser, setChangeRoleUser] = React.useState<UserView | null>(null);
  const [deactivateUser, setDeactivateUser] = React.useState<UserView | null>(null);
  const [reactivateUser, setReactivateUser] = React.useState<UserView | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const { data, isLoading } = useQuery<UserListResponse>({
    queryKey: ['staff', page],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      return apiFetch(`/admin/v1/users?${params.toString()}`);
    },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['staff'] });
  }

  const deactivateMutation = useMutation({
    mutationFn: () =>
      apiFetch<UserView>(`/admin/v1/users/${deactivateUser!.id}/deactivate`, { method: 'PATCH' }),
    onSuccess: () => {
      setDeactivateUser(null);
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(extractApiError(err)),
  });

  const reactivateMutation = useMutation({
    mutationFn: () =>
      apiFetch<UserView>(`/admin/v1/users/${reactivateUser!.id}/reactivate`, { method: 'PATCH' }),
    onSuccess: () => {
      setReactivateUser(null);
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(extractApiError(err)),
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'staff') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <UserCog className="h-6 w-6" aria-hidden="true" />
          {t('staff', 'title')}
        </h1>
        {canWrite && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            {t('staff', 'createStaff')}
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{t('staff', 'colEmail')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('staff', 'colName')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('staff', 'colRole')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('staff', 'colStatus')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('staff', 'colLastLogin')}</th>
              {canWrite && (
                <th className="px-4 py-3 text-right font-medium">{t('staff', 'colActions')}</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td
                  colSpan={canWrite ? 6 : 5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td
                  colSpan={canWrite ? 6 : 5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  {t('staff', 'empty')}
                </td>
              </tr>
            ) : (
              data?.data.map((member) => {
                const isMe = member.id === currentUser?.id;
                const isOwner = member.role === 'owner';
                const isDisabled = member.disabledAt !== null;
                // Per spec: hide destructive/role actions for owner row and for your own row
                const showActions = canWrite && !isOwner && !isMe;

                return (
                  <tr
                    key={member.id}
                    className={`hover:bg-muted/50 ${isDisabled ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{member.email}</div>
                      {isMe && (
                        <span className="text-xs text-muted-foreground">
                          ({t('staff', 'markerYou')})
                        </span>
                      )}
                      {isOwner && !isMe && (
                        <span className="text-xs text-muted-foreground">
                          ({t('staff', 'markerOwner')})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{member.name || '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={roleBadgeVariant(member.role)}>
                        {roleLabel(member.role)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={isDisabled ? 'destructive' : 'success'}>
                        {isDisabled ? t('staff', 'statusDisabled') : t('staff', 'statusActive')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatLastLogin(member.lastLoginAt)}
                    </td>
                    {canWrite && (
                      <td className="px-4 py-3 text-right">
                        {showActions ? (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setChangeRoleUser(member)}
                            >
                              {t('staff', 'actionChangeRole')}
                            </Button>
                            {isDisabled ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setActionError(null);
                                  setReactivateUser(member);
                                }}
                              >
                                {t('staff', 'actionReactivate')}
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setActionError(null);
                                  setDeactivateUser(member);
                                }}
                                className="text-destructive hover:text-destructive"
                              >
                                {t('staff', 'actionDeactivate')}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((data?.page ?? 1) - 1) * (data?.pageSize ?? 20) + 1}–
            {Math.min((data?.page ?? 1) * (data?.pageSize ?? 20), data?.total ?? 0)} of{' '}
            {data?.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create dialog */}
      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          invalidate();
        }}
      />

      {/* Change role dialog */}
      <ChangeRoleDialog
        user={changeRoleUser}
        onClose={() => setChangeRoleUser(null)}
        onDone={() => {
          setChangeRoleUser(null);
          invalidate();
        }}
      />

      {/* Deactivate confirm */}
      <ConfirmDialog
        open={!!deactivateUser}
        title={t('staff', 'deactivateTitle')}
        description={t('staff', 'deactivateDescription')}
        confirmLabel={t('staff', 'confirmDeactivate')}
        onClose={() => {
          setDeactivateUser(null);
          setActionError(null);
        }}
        onConfirm={() => deactivateMutation.mutate()}
        isPending={deactivateMutation.isPending}
        error={actionError}
      />

      {/* Reactivate confirm */}
      <ConfirmDialog
        open={!!reactivateUser}
        title={t('staff', 'reactivateTitle')}
        description={t('staff', 'reactivateDescription')}
        confirmLabel={t('staff', 'confirmReactivate')}
        onClose={() => {
          setReactivateUser(null);
          setActionError(null);
        }}
        onConfirm={() => reactivateMutation.mutate()}
        isPending={reactivateMutation.isPending}
        error={actionError}
      />
    </div>
  );
}
