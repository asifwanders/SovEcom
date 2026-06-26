import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { apiFetch, ApiError } from '@/lib/api';
import { t, tfn } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { SovEcomLogo } from '@/components/icons';

const schema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(12, tfn('common', 'minLength', 12)),
});

type FormData = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [submitted, setSubmitted] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { token: token ?? '', newPassword: '' },
  });

  React.useEffect(() => {
    if (!token) {
      navigate('/login');
    }
  }, [token, navigate]);

  async function onSubmit(data: FormData) {
    setError(null);
    setIsLoading(true);
    try {
      await apiFetch('/admin/v1/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      setSubmitted(true);
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
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex items-center justify-center h-12 w-12 rounded-full bg-primary/10">
            <SovEcomLogo className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <CardTitle>{t('auth', 'resetPasswordTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <Alert variant="success">{t('auth', 'resetPasswordSuccess')}</Alert>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              <input type="hidden" {...register('token')} />
              <div className="space-y-2">
                <Label htmlFor="newPassword" required>
                  {t('auth', 'passwordLabel')}
                </Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('auth', 'passwordPlaceholder')}
                  {...register('newPassword')}
                />
                <p className="text-xs text-muted-foreground">{t('auth', 'passwordPolicy')}</p>
                {errors.newPassword && (
                  <p className="text-sm text-destructive" role="alert">
                    {errors.newPassword.message}
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" isLoading={isLoading}>
                {t('auth', 'resetPasswordButton')}
              </Button>
            </form>
          )}
          <div className="mt-4 text-center text-sm">
            <Link
              to="/login"
              className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              Back to sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
