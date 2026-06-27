/**
 * Per-type settings forms for the home-sections editor (WS-3c).
 * Extracted to keep home-sections.tsx under the 500-line limit.
 *
 * Exports: ImageField, HeroBannerForm, CtaBannerForm, PromoTilesForm, RichTextForm,
 *          SectionCard, TypePicker.
 */
import React from 'react';
import {
  MARKETING_SECTION_TYPES,
  type MarketingSectionDescriptor,
  type HeroBannerSettings,
  type CtaBannerSettings,
  type PromoTilesSettings,
  type RichTextSettings,
} from '@sovecom/theme-sdk';
import { apiFetch } from '@/lib/api';
import { useT } from '@/lib/i18n-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronUp, ChevronDown, X, ImageIcon } from 'lucide-react';
import type { SectionState } from './home-sections-types';

// ── image upload hook ──────────────────────────────────────────────────────────

function useImageUpload(onUrl: (url: string) => void) {
  const [uploading, setUploading] = React.useState(false);
  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch<{ variants: { original: string } }>('/admin/v1/images', {
        method: 'POST',
        body: fd,
      });
      onUrl(res.variants.original);
    } finally {
      setUploading(false);
    }
  };
  return { uploading, handleFile };
}

// ── image field ────────────────────────────────────────────────────────────────

interface ImageFieldProps {
  id: string;
  label: string;
  value: string | undefined;
  onChange: (url: string | undefined) => void;
}

export function ImageField({ id, label, value, onChange }: ImageFieldProps) {
  const { uploading, handleFile } = useImageUpload((url) => onChange(url));
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-3">
        {value ? (
          <div className="flex items-center gap-2">
            <img
              src={value}
              alt=""
              className="h-12 w-20 object-cover rounded border border-border"
            />
            <Input
              id={id}
              value={value}
              readOnly
              className="font-mono text-xs flex-1"
              aria-label={label}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(undefined)}
              aria-label="Clear image"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">No image</span>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
          disabled={uploading}
        />
        <Button type="button" variant="secondary" size="sm" isLoading={uploading}>
          {value ? 'Replace image' : 'Upload image'}
        </Button>
      </label>
    </div>
  );
}

// ── hero-banner form ───────────────────────────────────────────────────────────

interface HeroBannerFormProps {
  sectionKey: string;
  settings: HeroBannerSettings;
  onChange: (s: HeroBannerSettings) => void;
}
export function HeroBannerForm({ sectionKey, settings, onChange }: HeroBannerFormProps) {
  const { t } = useT();
  const upd = (patch: Partial<HeroBannerSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-headline`} required>
          {t('homeSections', 'fieldHeadline')}
        </Label>
        <Input
          id={`${sectionKey}-headline`}
          value={settings.headline}
          onChange={(e) => upd({ headline: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-subheadline`}>{t('homeSections', 'fieldSubheadline')}</Label>
        <Input
          id={`${sectionKey}-subheadline`}
          value={settings.subheadline ?? ''}
          onChange={(e) => upd({ subheadline: e.target.value || undefined })}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${sectionKey}-ctaLabel`}>{t('homeSections', 'fieldCtaLabel')}</Label>
          <Input
            id={`${sectionKey}-ctaLabel`}
            value={settings.ctaLabel ?? ''}
            onChange={(e) => upd({ ctaLabel: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${sectionKey}-ctaHref`}>{t('homeSections', 'fieldCtaHref')}</Label>
          <Input
            id={`${sectionKey}-ctaHref`}
            value={settings.ctaHref ?? ''}
            onChange={(e) => upd({ ctaHref: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${sectionKey}-align`}>{t('homeSections', 'fieldAlign')}</Label>
          <Select
            id={`${sectionKey}-align`}
            value={settings.align ?? 'center'}
            onChange={(e) =>
              upd({ align: (e.target.value as HeroBannerSettings['align']) || undefined })
            }
          >
            <option value="left">{t('homeSections', 'alignLeft')}</option>
            <option value="center">{t('homeSections', 'alignCenter')}</option>
            <option value="right">{t('homeSections', 'alignRight')}</option>
          </Select>
        </div>
        <div className="space-y-2 flex items-center gap-3 pt-7">
          <input
            type="checkbox"
            id={`${sectionKey}-overlay`}
            checked={settings.overlay ?? false}
            onChange={(e) => upd({ overlay: e.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          <Label htmlFor={`${sectionKey}-overlay`}>{t('homeSections', 'fieldOverlay')}</Label>
        </div>
      </div>
      <ImageField
        id={`${sectionKey}-imageUrl`}
        label={t('homeSections', 'fieldImageUrl')}
        value={settings.imageUrl}
        onChange={(url) => upd({ imageUrl: url })}
      />
    </div>
  );
}

// ── cta-banner form ────────────────────────────────────────────────────────────

interface CtaBannerFormProps {
  sectionKey: string;
  settings: CtaBannerSettings;
  onChange: (s: CtaBannerSettings) => void;
}
export function CtaBannerForm({ sectionKey, settings, onChange }: CtaBannerFormProps) {
  const { t } = useT();
  const upd = (patch: Partial<CtaBannerSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-headline`} required>
          {t('homeSections', 'fieldHeadline')}
        </Label>
        <Input
          id={`${sectionKey}-headline`}
          value={settings.headline}
          onChange={(e) => upd({ headline: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-body`}>{t('homeSections', 'fieldBody')}</Label>
        <Textarea
          id={`${sectionKey}-body`}
          value={settings.body ?? ''}
          onChange={(e) => upd({ body: e.target.value || undefined })}
          rows={3}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${sectionKey}-ctaLabel`} required>
            {t('homeSections', 'fieldCtaLabel')}
          </Label>
          <Input
            id={`${sectionKey}-ctaLabel`}
            value={settings.ctaLabel}
            onChange={(e) => upd({ ctaLabel: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${sectionKey}-ctaHref`} required>
            {t('homeSections', 'fieldCtaHref')}
          </Label>
          <Input
            id={`${sectionKey}-ctaHref`}
            value={settings.ctaHref}
            onChange={(e) => upd({ ctaHref: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-variant`}>{t('homeSections', 'fieldVariant')}</Label>
        <Select
          id={`${sectionKey}-variant`}
          value={settings.variant ?? 'primary'}
          onChange={(e) =>
            upd({ variant: (e.target.value as CtaBannerSettings['variant']) || undefined })
          }
        >
          <option value="primary">{t('homeSections', 'variantPrimary')}</option>
          <option value="secondary">{t('homeSections', 'variantSecondary')}</option>
        </Select>
      </div>
    </div>
  );
}

// ── promo-tiles form ───────────────────────────────────────────────────────────

interface PromoTilesFormProps {
  sectionKey: string;
  settings: PromoTilesSettings;
  onChange: (s: PromoTilesSettings) => void;
}
export function PromoTilesForm({ sectionKey, settings, onChange }: PromoTilesFormProps) {
  const { t } = useT();
  const MAX_TILES = 12;
  const updTile = (idx: number, patch: Partial<PromoTilesSettings['tiles'][number]>) => {
    const tiles = settings.tiles.map((tile, i) => (i === idx ? { ...tile, ...patch } : tile));
    onChange({ ...settings, tiles });
  };
  const addTile = () => {
    if (settings.tiles.length >= MAX_TILES) return;
    onChange({ ...settings, tiles: [...settings.tiles, { label: '', href: '/' }] });
  };
  const removeTile = (idx: number) =>
    onChange({ ...settings, tiles: settings.tiles.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${sectionKey}-columns`}>{t('homeSections', 'fieldColumns')}</Label>
        <Select
          id={`${sectionKey}-columns`}
          value={String(settings.columns ?? 3)}
          onChange={(e) =>
            onChange({
              ...settings,
              columns: Number(e.target.value) as PromoTilesSettings['columns'],
            })
          }
        >
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </Select>
      </div>
      <div className="space-y-3">
        <p className="text-sm font-medium">
          {t('homeSections', 'tiles')} ({settings.tiles.length}/{MAX_TILES})
        </p>
        {settings.tiles.map((tile, idx) => (
          <div key={idx} className="border border-border rounded-md p-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                {t('homeSections', 'tile')} {idx + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeTile(idx)}
                aria-label={t('homeSections', 'removeTile')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor={`${sectionKey}-tile-${idx}-label`} required>
                  {t('homeSections', 'tileLabel')}
                </Label>
                <Input
                  id={`${sectionKey}-tile-${idx}-label`}
                  value={tile.label}
                  onChange={(e) => updTile(idx, { label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${sectionKey}-tile-${idx}-href`} required>
                  {t('homeSections', 'tileHref')}
                </Label>
                <Input
                  id={`${sectionKey}-tile-${idx}-href`}
                  value={tile.href}
                  onChange={(e) => updTile(idx, { href: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${sectionKey}-tile-${idx}-caption`}>
                {t('homeSections', 'tileCaption')}
              </Label>
              <Input
                id={`${sectionKey}-tile-${idx}-caption`}
                value={tile.caption ?? ''}
                onChange={(e) => updTile(idx, { caption: e.target.value || undefined })}
              />
            </div>
            <ImageField
              id={`${sectionKey}-tile-${idx}-imageUrl`}
              label={t('homeSections', 'tileImageUrl')}
              value={tile.imageUrl}
              onChange={(url) => updTile(idx, { imageUrl: url })}
            />
          </div>
        ))}
        {settings.tiles.length < MAX_TILES && (
          <Button type="button" variant="secondary" size="sm" onClick={addTile}>
            {t('homeSections', 'addTile')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── rich-text form ─────────────────────────────────────────────────────────────

interface RichTextFormProps {
  sectionKey: string;
  settings: RichTextSettings;
  onChange: (s: RichTextSettings) => void;
}
export function RichTextForm({ sectionKey, settings, onChange }: RichTextFormProps) {
  const { t } = useT();
  return (
    <div className="space-y-2">
      <Label htmlFor={`${sectionKey}-markdown`} required>
        {t('homeSections', 'fieldMarkdown')}
      </Label>
      <Textarea
        id={`${sectionKey}-markdown`}
        value={settings.markdown}
        onChange={(e) => onChange({ markdown: e.target.value })}
        rows={10}
        className="font-mono"
      />
      <p className="text-xs text-muted-foreground">{t('homeSections', 'fieldMarkdownHint')}</p>
    </div>
  );
}

// ── section card ───────────────────────────────────────────────────────────────

interface SectionCardProps {
  section: SectionState;
  index: number;
  total: number;
  onChange: (s: SectionState) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

export function SectionCard({
  section,
  index,
  total,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: SectionCardProps) {
  const { t } = useT();
  const sectionTypeName: Record<string, string> = {
    'hero-banner': t('homeSections', 'typeHeroBanner'),
    'cta-banner': t('homeSections', 'typeCtaBanner'),
    'promo-tiles': t('homeSections', 'typePromoTiles'),
    'rich-text': t('homeSections', 'typeRichText'),
  };
  const updateSettings = (
    ns: HeroBannerSettings | CtaBannerSettings | PromoTilesSettings | RichTextSettings,
  ) => onChange({ ...section, settings: ns });
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {sectionTypeName[section.type] ?? section.type}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label={t('homeSections', 'moveUp')}
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label={t('homeSections', 'moveDown')}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              aria-label={t('homeSections', 'removeSection')}
            >
              <X className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {section.type === 'hero-banner' && (
          <HeroBannerForm
            sectionKey={section.key}
            settings={section.settings as HeroBannerSettings}
            onChange={updateSettings}
          />
        )}
        {section.type === 'cta-banner' && (
          <CtaBannerForm
            sectionKey={section.key}
            settings={section.settings as CtaBannerSettings}
            onChange={updateSettings}
          />
        )}
        {section.type === 'promo-tiles' && (
          <PromoTilesForm
            sectionKey={section.key}
            settings={section.settings as PromoTilesSettings}
            onChange={updateSettings}
          />
        )}
        {section.type === 'rich-text' && (
          <RichTextForm
            sectionKey={section.key}
            settings={section.settings as RichTextSettings}
            onChange={updateSettings}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── type picker ────────────────────────────────────────────────────────────────

interface TypePickerProps {
  onPick: (type: MarketingSectionDescriptor['type']) => void;
  onClose: () => void;
}

export function TypePicker({ onPick, onClose }: TypePickerProps) {
  const { t } = useT();
  const typeNames: Record<string, string> = {
    'hero-banner': t('homeSections', 'typeHeroBanner'),
    'cta-banner': t('homeSections', 'typeCtaBanner'),
    'promo-tiles': t('homeSections', 'typePromoTiles'),
    'rich-text': t('homeSections', 'typeRichText'),
  };
  return (
    <div className="border border-border rounded-lg bg-card p-4 space-y-2 shadow-sm">
      <p className="text-sm font-medium">{t('homeSections', 'pickType')}</p>
      <ul role="listbox" className="space-y-1">
        {MARKETING_SECTION_TYPES.map((type) => (
          <li key={type}>
            <button
              type="button"
              role="option"
              aria-selected="false"
              className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-muted transition-colors"
              onClick={() => {
                onPick(type);
                onClose();
              }}
            >
              {typeNames[type] ?? type}
            </button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        {t('common', 'cancel')}
      </Button>
    </div>
  );
}
