/**
 * Admin Home-sections editor (WS-3c).
 *
 * Loads GET /admin/v1/storefront/home-sections (themes:read), lets the merchant
 * add / reorder / remove / edit each marketing section, and saves via PUT.
 *
 * Image fields upload to POST /admin/v1/images (products:write). Owners/admins
 * have both permissions; staff cannot access this editor at all (themes:write is
 * admin-only), so the products:write gap is not exposed in practice.
 *
 * 422 validation errors from the API surface as an Alert — no silent failures.
 * The PUT payload is always {sections: {type, settings}[]}, typed by @sovecom/theme-sdk.
 *
 * Per-type forms and the SectionCard are in home-sections-forms.tsx (to stay under 500 lines).
 */
import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n-context';
import { queryClient } from '@/lib/query-client';
import { type MarketingSectionDescriptor } from '@sovecom/theme-sdk';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { LayoutTemplate } from 'lucide-react';
import { SectionCard, TypePicker } from './home-sections-forms';
import type { SectionState, GetResponse } from './home-sections-types';
import {
  type HeroBannerSettings,
  type CtaBannerSettings,
  type PromoTilesSettings,
  type RichTextSettings,
} from '@sovecom/theme-sdk';

// ── helpers ───────────────────────────────────────────────────────────────────

let _keyCounter = 0;
function nextKey() {
  return `sec-${++_keyCounter}`;
}

function defaultSettings(
  type: MarketingSectionDescriptor['type'],
): HeroBannerSettings | CtaBannerSettings | PromoTilesSettings | RichTextSettings {
  switch (type) {
    case 'hero-banner':
      return { headline: '' };
    case 'cta-banner':
      return { headline: '', ctaLabel: '', ctaHref: '/' };
    case 'promo-tiles':
      return { tiles: [{ label: '', href: '/' }] };
    case 'rich-text':
      return { markdown: '' };
  }
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function HomeSectionsPage() {
  const { t } = useT();
  const [sections, setSections] = React.useState<SectionState[]>([]);
  const [showPicker, setShowPicker] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const { isLoading, data: queryData } = useQuery<GetResponse>({
    queryKey: ['home-sections'],
    queryFn: () => apiFetch('/admin/v1/storefront/home-sections'),
  });

  // Sync fetched data into local state once — mirroring the page-form.tsx pattern.
  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (queryData && !initializedRef.current) {
      initializedRef.current = true;
      setSections(
        queryData.sections.map((s) => ({
          key: nextKey(),
          type: s.type,
          settings: s.settings,
        })),
      );
    }
  }, [queryData]);

  const saveMutation = useMutation({
    mutationFn: async (payload: { sections: { type: string; settings: unknown }[] }) =>
      apiFetch('/admin/v1/storefront/home-sections', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['home-sections'] });
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        const body = err.body as Record<string, unknown> | null;
        const msg =
          (typeof body?.message === 'string' ? body.message : null) ?? t('common', 'genericError');
        setError(msg);
      } else {
        setError(t('common', 'genericError'));
      }
    },
  });

  const moveSection = (fromIdx: number, toIdx: number) => {
    setSections((prev) => {
      const next = [...prev];
      const [removed] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, removed!);
      return next;
    });
  };

  const removeSection = (idx: number) => setSections((prev) => prev.filter((_, i) => i !== idx));

  const addSection = (type: MarketingSectionDescriptor['type']) =>
    setSections((prev) => [...prev, { key: nextKey(), type, settings: defaultSettings(type) }]);

  const handleSave = () => {
    setError(null);
    saveMutation.mutate({ sections: sections.map(({ type, settings }) => ({ type, settings })) });
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'homeSections') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <LayoutTemplate className="h-6 w-6" aria-hidden="true" />
          {t('homeSections', 'title')}
        </h1>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}

      {saved && <Alert variant="default">{t('homeSections', 'savedToast')}</Alert>}

      {isLoading ? (
        <p className="text-muted-foreground">{t('common', 'loading')}</p>
      ) : (
        <div className="space-y-4">
          {sections.map((section, idx) => (
            <SectionCard
              key={section.key}
              section={section}
              index={idx}
              total={sections.length}
              onChange={(updated) =>
                setSections((prev) => prev.map((s) => (s.key === updated.key ? updated : s)))
              }
              onMoveUp={() => moveSection(idx, idx - 1)}
              onMoveDown={() => moveSection(idx, idx + 1)}
              onRemove={() => removeSection(idx)}
            />
          ))}

          {showPicker ? (
            <TypePicker onPick={addSection} onClose={() => setShowPicker(false)} />
          ) : (
            <Button type="button" variant="secondary" onClick={() => setShowPicker(true)}>
              {t('homeSections', 'addSection')}
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleSave} isLoading={saveMutation.isPending}>
          {t('common', 'save')}
        </Button>
      </div>
    </div>
  );
}
