/**
 * Admin Content Page create/edit form.
 *
 * react-hook-form + zodResolver over `/admin/v1/pages`. Fields:
 * slug, title, body (Markdown textarea — rendered as sanitized Markdown on the
 * storefront), locale (fr|en), status (draft|published), seoTitle,
 * seoDescription. POST on create / PATCH on edit. A 409 (duplicate slug+locale
 * unique collision) surfaces a clear slug-field error. Uses the reactive `useT()`.
 */
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiFetch, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n-context';
import { queryClient } from '@/lib/query-client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';

interface PageRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  locale: 'fr' | 'en';
  status: 'draft' | 'published';
  seoTitle: string | null;
  seoDescription: string | null;
}

const pageSchema = z.object({
  slug: z.string().trim().min(1).max(512),
  title: z.string().min(1).max(512),
  body: z.string().min(1),
  locale: z.enum(['fr', 'en']),
  status: z.enum(['draft', 'published']),
  seoTitle: z.string().max(512).optional(),
  seoDescription: z.string().max(1024).optional(),
});

type PageFormData = z.infer<typeof pageSchema>;

export default function PageFormPage() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;
  const [error, setError] = React.useState<string | null>(null);

  // Validation messages localize, so the resolved schema is rebuilt when the
  // locale's `t()` changes (overriding the required-field messages). Mirrors the
  // API DTO closed enums (locale fr|en, status draft|published).
  const schema = React.useMemo(
    () =>
      pageSchema.extend({
        slug: z.string().trim().min(1, t('common', 'required')).max(512),
        title: z.string().min(1, t('common', 'required')).max(512),
        body: z.string().min(1, t('common', 'required')),
      }),
    [t],
  );

  const { data: page } = useQuery<PageRow>({
    queryKey: ['page', id],
    queryFn: () => apiFetch(`/admin/v1/pages/${id}`),
    enabled: isEdit,
  });

  const form = useForm<PageFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      slug: '',
      title: '',
      body: '',
      locale: 'en',
      status: 'draft',
      seoTitle: '',
      seoDescription: '',
    },
  });

  React.useEffect(() => {
    if (page) {
      form.reset({
        slug: page.slug,
        title: page.title,
        body: page.body,
        locale: page.locale,
        status: page.status,
        seoTitle: page.seoTitle ?? '',
        seoDescription: page.seoDescription ?? '',
      });
    }
  }, [page, form]);

  const saveMutation = useMutation({
    mutationFn: async (data: PageFormData) => {
      // Empty SEO fields are sent as null (DTO accepts nullable), not "".
      const payload = {
        slug: data.slug.trim(),
        title: data.title,
        body: data.body,
        locale: data.locale,
        status: data.status,
        seoTitle: data.seoTitle ? data.seoTitle : null,
        seoDescription: data.seoDescription ? data.seoDescription : null,
      };
      if (isEdit) {
        await apiFetch(`/admin/v1/pages/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/admin/v1/pages', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      navigate('/pages');
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Duplicate (tenant, slug, locale) — point the merchant at the slug field.
        form.setError('slug', { type: 'manual', message: t('pages', 'duplicateSlug') });
        setError(t('pages', 'duplicateSlug'));
      } else {
        setError(t('common', 'genericError'));
      }
    },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'pages'), to: '/pages' },
          { label: isEdit ? t('pages', 'editPage') : t('pages', 'createPage') },
        ]}
      />

      <h1 className="text-2xl font-semibold">
        {isEdit ? t('pages', 'editPage') : t('pages', 'createPage')}
      </h1>

      {error && <Alert variant="destructive">{error}</Alert>}

      <form onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('pages', 'title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title" required>
                {t('pages', 'fieldTitle')}
              </Label>
              <Input id="title" {...form.register('title')} />
              {form.formState.errors.title && (
                <p className="text-sm text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug" required>
                {t('pages', 'fieldSlug')}
              </Label>
              <Input id="slug" {...form.register('slug')} />
              {form.formState.errors.slug && (
                <p className="text-sm text-destructive">{form.formState.errors.slug.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="locale">{t('pages', 'fieldLocale')}</Label>
                <Select id="locale" {...form.register('locale')}>
                  <option value="en">{t('pages', 'localeEn')}</option>
                  <option value="fr">{t('pages', 'localeFr')}</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">{t('pages', 'fieldStatus')}</Label>
                <Select id="status" {...form.register('status')}>
                  <option value="draft">{t('pages', 'statusDraft')}</option>
                  <option value="published">{t('pages', 'statusPublished')}</option>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="body" required>
                {t('pages', 'fieldBody')}
              </Label>
              <Textarea id="body" {...form.register('body')} rows={14} className="font-mono" />
              <p className="text-xs text-muted-foreground">{t('pages', 'fieldBodyHint')}</p>
              {form.formState.errors.body && (
                <p className="text-sm text-destructive">{form.formState.errors.body.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">SEO</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="seoTitle">{t('pages', 'fieldSeoTitle')}</Label>
              <Input id="seoTitle" {...form.register('seoTitle')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seoDescription">{t('pages', 'fieldSeoDescription')}</Label>
              <Textarea id="seoDescription" {...form.register('seoDescription')} rows={3} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" isLoading={saveMutation.isPending}>
            {isEdit ? t('pages', 'saveEdit') : t('pages', 'saveCreate')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/pages')}>
            {t('common', 'cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
