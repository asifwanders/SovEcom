import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { SovEcomLogo } from '@/components/icons';

const schema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, t('common', 'required'))
    .email(t('common', 'invalidEmail')),
});

type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  async function onSubmit(data: FormData) {
    setError(null);
    setIsLoading(true);
    try {
      await apiFetch('/admin/v1/auth/password/forgot', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    } catch {
      // Always swallow to prevent enumeration
    } finally {
      setSubmitted(true);
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
          <CardTitle>{t('auth', 'forgotPasswordTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <Alert variant="success">{t('auth', 'forgotPasswordSuccess')}</Alert>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {error && <Alert variant="destructive">{error}</Alert>}
              <p className="text-sm text-muted-foreground">
                {t('auth', 'forgotPasswordDescription')}
              </p>
              <div className="space-y-2">
                <Label htmlFor="email" required>
                  {t('auth', 'emailLabel')}
                </Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('auth', 'emailPlaceholder')}
                  {...register('email')}
                />
                {errors.email && (
                  <p className="text-sm text-destructive" role="alert">
                    {errors.email.message}
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" isLoading={isLoading}>
                {t('auth', 'forgotPasswordButton')}
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
