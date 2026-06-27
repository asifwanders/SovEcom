/**
 * Shared types for the home-sections editor (WS-3c).
 * Split out to avoid circular imports between home-sections.tsx and home-sections-forms.tsx.
 */
import type {
  MarketingSectionDescriptor,
  HeroBannerSettings,
  CtaBannerSettings,
  PromoTilesSettings,
  RichTextSettings,
} from '@sovecom/theme-sdk';

/** Flat state: sections with a stable local key for React reconciliation. */
export interface SectionState {
  key: string; // stable local id (not sent to API)
  type: MarketingSectionDescriptor['type'];
  settings: HeroBannerSettings | CtaBannerSettings | PromoTilesSettings | RichTextSettings;
}

export interface GetResponse {
  sections: MarketingSectionDescriptor[];
  updatedAt: string;
}
