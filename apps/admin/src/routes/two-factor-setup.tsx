import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/lib/auth';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';

const confirmSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, t('auth', 'twoFactorError')),
});

const disableSchema = z.object({
  password: z.string().min(1, t('common', 'required')),
  totpCode: z.string().regex(/^\d{6}$/, t('auth', 'twoFactorError')),
});

type ConfirmData = z.infer<typeof confirmSchema>;
type DisableData = z.infer<typeof disableSchema>;

export default function TwoFactorSetupPage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [enrollment, setEnrollment] = React.useState<{
    secret: string;
    otpauthUrl: string;
    qrDataUrl: string;
  } | null>(null);
  const [confirmSuccess, setConfirmSuccess] = React.useState(false);
  const [disableSuccess, setDisableSuccess] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const confirmForm = useForm<ConfirmData>({
    resolver: zodResolver(confirmSchema),
    defaultValues: { totpCode: '' },
  });

  const disableForm = useForm<DisableData>({
    resolver: zodResolver(disableSchema),
    defaultValues: { password: '', totpCode: '' },
  });

  async function startEnrollment() {
    setError(null);
    setIsLoading(true);
    try {
      const data = await apiFetch<{ secret: string; otpauthUrl: string; qrDataUrl: string }>(
        '/admin/v1/auth/2fa/enroll',
        { method: 'POST' },
      );
      setEnrollment(data);
    } catch {
      setError(t('common', 'genericError'));
    } finally {
      setIsLoading(false);
    }
  }

  async function onConfirm(data: ConfirmData) {
    setError(null);
    setIsLoading(true);
    try {
      await apiFetch('/admin/v1/auth/2fa/confirm', {
        method: 'POST',
        body: JSON.stringify({ totpCode: data.totpCode }),
      });
      setConfirmSuccess(true);
      setEnrollment(null);
      // Update local user state so "Disable 2FA" card appears without a reload
      if (user) {
        setUser({ ...user, totpEnabled: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(t('auth', 'twoFactorError'));
      } else {
        setError(t('common', 'genericError'));
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function onDisable(data: DisableData) {
    setError(null);
    setIsLoading(true);
    try {
      await apiFetch('/admin/v1/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setDisableSuccess(true);
      if (user) setUser({ ...user, totpEnabled: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(t('auth', 'loginError'));
      } else {
        setError(t('common', 'genericError'));
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{t('auth', 'twoFactorSetupTitle')}</h1>

      {error && (
        <Alert variant="destructive" className="mb-4">
          {error}
        </Alert>
      )}
      {confirmSuccess && (
        <Alert variant="success" className="mb-4">
          2FA enabled successfully.
        </Alert>
      )}
      {disableSuccess && (
        <Alert variant="success" className="mb-4">
          2FA disabled successfully.
        </Alert>
      )}

      {!user?.totpEnabled && !enrollment && !confirmSuccess && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('auth', 'twoFactorSetupTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">{t('auth', 'twoFactorSetupDescription')}</p>
            <Button onClick={startEnrollment} isLoading={isLoading}>
              Set up 2FA
            </Button>
          </CardContent>
        </Card>
      )}

      {enrollment && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Scan QR Code</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-center">
              <img
                src={enrollment.qrDataUrl}
                alt="QR code for 2FA setup"
                className="rounded-md border border-border"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('auth', 'twoFactorSecretLabel')}</Label>
              <code className="block p-2 rounded-md bg-muted text-sm font-mono break-all">
                {enrollment.secret}
              </code>
            </div>
            <form onSubmit={confirmForm.handleSubmit(onConfirm)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="confirmTotp" required>
                  {t('auth', 'twoFactorLabel')}
                </Label>
                <Input
                  id="confirmTotp"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('auth', 'twoFactorPlaceholder')}
                  {...confirmForm.register('totpCode')}
                />
                {confirmForm.formState.errors.totpCode && (
                  <p className="text-sm text-destructive" role="alert">
                    {confirmForm.formState.errors.totpCode.message}
                  </p>
                )}
              </div>
              <Button type="submit" isLoading={isLoading}>
                {t('auth', 'twoFactorConfirm')}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {user?.totpEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('auth', 'twoFactorDisableTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">{t('auth', 'twoFactorDisableDescription')}</p>
            <form onSubmit={disableForm.handleSubmit(onDisable)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="disablePassword" required>
                  {t('auth', 'passwordLabel')}
                </Label>
                <Input id="disablePassword" type="password" {...disableForm.register('password')} />
                {disableForm.formState.errors.password && (
                  <p className="text-sm text-destructive" role="alert">
                    {disableForm.formState.errors.password.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="disableTotp" required>
                  {t('auth', 'twoFactorLabel')}
                </Label>
                <Input
                  id="disableTotp"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('auth', 'twoFactorPlaceholder')}
                  {...disableForm.register('totpCode')}
                />
                {disableForm.formState.errors.totpCode && (
                  <p className="text-sm text-destructive" role="alert">
                    {disableForm.formState.errors.totpCode.message}
                  </p>
                )}
              </div>
              <Button type="submit" variant="destructive" isLoading={isLoading}>
                {t('auth', 'twoFactorDisableButton')}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
