import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/lib/auth';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';

const schema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, t('auth', 'twoFactorError')),
});

type FormData = z.infer<typeof schema>;

export default function TwoFactorPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // challengeId is passed via router state (not query string) to avoid history persistence
  const challengeId = (location.state as { challengeId?: string } | null)?.challengeId ?? null;
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { totpCode: '' },
  });

  React.useEffect(() => {
    if (!challengeId) {
      navigate('/login');
    }
  }, [challengeId, navigate]);

  async function onSubmit(data: FormData) {
    if (!challengeId) return;
    setError(null);
    setIsLoading(true);
    try {
      const result = await apiFetch<{ accessToken: string }>('/admin/v1/auth/2fa', {
        method: 'POST',
        body: JSON.stringify({ challengeId, totpCode: data.totpCode }),
      });
      setAccessToken(result.accessToken);
      navigate('/dashboard');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('auth', 'twoFactorError'));
      } else {
        setError(t('common', 'genericError'));
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{t('auth', 'twoFactorTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && <Alert variant="destructive">{error}</Alert>}
            <div className="space-y-2">
              <Label htmlFor="totpCode" required>
                {t('auth', 'twoFactorLabel')}
              </Label>
              <Input
                id="totpCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={t('auth', 'twoFactorPlaceholder')}
                aria-invalid={!!errors.totpCode}
                {...register('totpCode')}
              />
              {errors.totpCode && (
                <p className="text-sm text-destructive" role="alert">
                  {errors.totpCode.message}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" isLoading={isLoading}>
              {t('auth', 'twoFactorSubmit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
