/**
 * Staff management dialogs — extracted to keep staff.tsx under 500 lines.
 */
import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { UserView } from './staff-types';

// ---------------------------------------------------------------------------
// Error helper (shared)
// ---------------------------------------------------------------------------

export function extractApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return t('staff', 'errorDuplicateEmail');
    if (err.status === 400) {
      const msg =
        typeof err.body === 'object' && err.body !== null
          ? ((err.body as Record<string, unknown>).message as string | undefined)
          : undefined;
      if (msg?.toLowerCase().includes('breached')) return t('staff', 'errorBreachedPassword');
      if (msg?.toLowerCase().includes('owner')) return t('staff', 'errorOwnerRole');
      return t('staff', 'errorWeakPassword');
    }
  }
  return t('common', 'genericError');
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateDialog({ open, onClose, onCreated }: CreateDialogProps) {
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState<'admin' | 'staff'>('staff');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<UserView>('/admin/v1/users', {
        method: 'POST',
        body: JSON.stringify({ email, name, role, password }),
      }),
    onSuccess: () => {
      onCreated();
      setEmail('');
      setName('');
      setRole('staff');
      setPassword('');
      setError(null);
    },
    onError: (err) => setError(extractApiError(err)),
  });

  function handleClose() {
    setError(null);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('staff', 'createTitle')}
      description={t('staff', 'createDescription')}
    >
      <div className="space-y-4 mt-2">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="space-y-2">
          <Label required>{t('staff', 'fieldEmail')}</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label required>{t('staff', 'fieldName')}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label required>{t('staff', 'fieldRole')}</Label>
          <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'staff')}>
            <option value="admin">{t('staff', 'roleAdmin')}</option>
            <option value="staff">{t('staff', 'roleStaff')}</option>
          </Select>
        </div>
        <div className="space-y-2">
          <Label required>{t('staff', 'fieldPassword')}</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            autoComplete="new-password"
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={handleClose}>
            {t('common', 'cancel')}
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            isLoading={mutation.isPending}
            disabled={!email || !name || !password}
          >
            {t('common', 'create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Change-role dialog
// ---------------------------------------------------------------------------

interface ChangeRoleDialogProps {
  user: UserView | null;
  onClose: () => void;
  onDone: () => void;
}

export function ChangeRoleDialog({ user, onClose, onDone }: ChangeRoleDialogProps) {
  const [role, setRole] = React.useState<'admin' | 'staff'>('staff');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (user && user.role !== 'owner') {
      setRole(user.role as 'admin' | 'staff');
    }
  }, [user]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<UserView>(`/admin/v1/users/${user!.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (err) => setError(extractApiError(err)),
  });

  function handleClose() {
    setError(null);
    onClose();
  }

  return (
    <Dialog
      open={!!user}
      onClose={handleClose}
      title={t('staff', 'changeRoleTitle')}
      description={t('staff', 'changeRoleDescription')}
    >
      <div className="space-y-4 mt-2">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="space-y-2">
          <Label required>{t('staff', 'fieldRole')}</Label>
          <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'staff')}>
            <option value="admin">{t('staff', 'roleAdmin')}</option>
            <option value="staff">{t('staff', 'roleStaff')}</option>
          </Select>
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={handleClose}>
            {t('common', 'cancel')}
          </Button>
          <Button onClick={() => mutation.mutate()} isLoading={mutation.isPending}>
            {t('common', 'save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Generic confirm dialog (deactivate / reactivate)
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: string | null;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  isPending,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      <div className="space-y-4 mt-2">
        {error && <Alert variant="destructive">{error}</Alert>}
        <div className="flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('common', 'cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} isLoading={isPending}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
