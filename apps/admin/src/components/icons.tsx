import React from 'react';

/**
 * SovEcom "Headless Node" brand mark (concept 02, brand/logos/icon). Uses
 * `currentColor` so it tints with `text-primary` (brand teal #00b9a0) and adapts
 * to light/dark — the canonical mark, not a generic placeholder.
 */
export function SovEcomLogo({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="SovEcom"
      className={className}
      {...props}
    >
      <g stroke="currentColor" strokeWidth="6" strokeLinecap="round">
        <path d="M100 28 L64 64" />
        <path d="M64 64 L28 100" />
        <path d="M28 28 L64 64" strokeOpacity="0.55" />
        <path d="M100 100 L64 64" strokeOpacity="0.55" />
      </g>
      <circle cx="100" cy="28" r="10" fill="currentColor" />
      <circle cx="28" cy="100" r="10" fill="currentColor" />
      <circle cx="28" cy="28" r="7.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="100" cy="100" r="7.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="64" cy="64" r="15" fill="currentColor" />
    </svg>
  );
}
