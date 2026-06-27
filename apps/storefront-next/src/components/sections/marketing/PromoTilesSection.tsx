/**
 * WS-3d — `promo-tiles` marketing section renderer.
 *
 * RSC (no "use client"). A responsive grid of linked image tiles. Security:
 *   - EVERY tile imageUrl MUST pass through `safeImageUrl()`. If it returns null/undefined,
 *     no <img> is rendered for that tile — defence against SSRF/PII-egress.
 *   - Tile href is SDK-validated at API time (marketingHrefSchema) — rendered as a plain <a>.
 *   - No dangerouslySetInnerHTML; all text is React children (auto-escaped).
 *
 * columns defaults to 3 when absent; unknown values fall back to 3.
 */
import type { SectionProps } from '@/lib/sections/registry';
import type { PromoTilesSettings } from '@sovecom/theme-sdk';
import { safeImageUrl } from '@/lib/widgets/safeUrl';

const COLS_CLASS: Record<number, string> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-4',
};

export async function PromoTilesSection({ settings }: SectionProps) {
  const s = settings as unknown as PromoTilesSettings;
  const columns = s.columns ?? 3;
  const colsClass = COLS_CLASS[columns] ?? COLS_CLASS[3];

  return (
    <section className="py-4">
      <ul className={`grid ${colsClass} gap-4 list-none p-0`} role="list">
        {s.tiles.map((tile, idx) => {
          // Security: pass every tile imageUrl through the allowlist guard.
          const imgSrc = tile.imageUrl ? safeImageUrl(tile.imageUrl) : undefined;
          return (
            <li key={idx} className="group rounded-xl overflow-hidden border border-border bg-card">
              <a href={tile.href} className="flex flex-col h-full hover:no-underline">
                {imgSrc && (
                  <div className="aspect-video overflow-hidden">
                    <img
                      src={imgSrc}
                      alt={tile.label}
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1 p-4">
                  <span className="font-semibold text-foreground">{tile.label}</span>
                  {tile.caption && (
                    <span className="text-sm text-muted-foreground">{tile.caption}</span>
                  )}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
