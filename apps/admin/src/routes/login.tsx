import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '@/lib/auth';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { SovEcomLogo } from '@/components/icons';

const loginSchema = z.object({
  email: z
    .string()
    .min(1, t('common', 'required'))
    .email(t('common', 'invalidEmail'))
    .transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1, t('common', 'required')),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(data: LoginFormData) {
    setError(null);
    setIsLoading(true);
    try {
      const result = await apiFetch<
        { requires2FA: true; challengeId: string } | { accessToken: string }
      >('/admin/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      if ('requires2FA' in result && result.requires2FA) {
        // Pass challengeId via router state, not query string, to avoid browser-history persistence
        navigate('/2fa', { state: { challengeId: result.challengeId } });
        return;
      }
      if ('accessToken' in result) {
        setAccessToken(result.accessToken);
        navigate('/dashboard');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError(t('auth', 'loginError'));
      } else if (err instanceof ApiError && (err.status === 423 || err.status === 429)) {
        setError(t('auth', 'lockoutError'));
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
          <CardTitle>{t('auth', 'loginTitle')}</CardTitle>
          <CardDescription>SovEcom Admin</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {error && <Alert variant="destructive">{error}</Alert>}
            <div className="space-y-2">
              <Label htmlFor="email" required>
                {t('auth', 'emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder={t('auth', 'emailPlaceholder')}
                aria-invalid={!!errors.email}
                {...register('email')}
              />
              {errors.email && (
                <p className="text-sm text-destructive" role="alert">
                  {errors.email.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" required>
                {t('auth', 'passwordLabel')}
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder={t('auth', 'passwordPlaceholder')}
                aria-invalid={!!errors.password}
                {...register('password')}
              />
              {errors.password && (
                <p className="text-sm text-destructive" role="alert">
                  {errors.password.message}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" isLoading={isLoading}>
              {t('auth', 'loginButton')}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm">
            <Link
              to="/forgot-password"
              className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              {t('auth', 'forgotPassword')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
