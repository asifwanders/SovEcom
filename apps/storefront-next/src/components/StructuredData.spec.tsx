/**
 * StructuredData component tests.
 *
 * Renders a typed JSON-LD object into a `<script type="application/ld+json">`. The key safety
 * property: the serialized JSON must NOT be able to break out of the `<script>` element — any `<`
 * (and therefore `</script>`) is escaped — even though the data is first-party catalog data.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { WithContext, Product } from 'schema-dts';
import { StructuredData } from './StructuredData';

function scriptEl(container: HTMLElement): HTMLScriptElement | null {
  return container.querySelector('script[type="application/ld+json"]');
}

describe('StructuredData', () => {
  it('renders a <script type="application/ld+json"> with the object serialized', () => {
    const data: WithContext<Product> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Cotton Tee',
    };
    const { container } = render(<StructuredData data={data} />);
    const script = scriptEl(container);
    expect(script).not.toBeNull();
    const parsed = JSON.parse(script!.textContent ?? '{}');
    expect(parsed).toEqual(data);
  });

  it('escapes "<" so a "</script>" in the data cannot break out of the script element', () => {
    const data: WithContext<Product> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      // A malicious-looking name with a closing script tag + a "<" character.
      name: 'Evil </script><img src=x onerror=alert(1)> Tee',
    };
    const { container } = render(<StructuredData data={data} />);
    const script = scriptEl(container);
    const raw = script!.innerHTML;
    // No literal "</script>" or "<" survives in the serialized payload.
    expect(raw).not.toContain('</script>');
    expect(raw).not.toContain('<');
    expect(raw).toContain('\\u003c');
    // ...and it still round-trips back to the original object.
    expect(JSON.parse(script!.textContent ?? '{}')).toEqual(data);
  });

  it('renders nothing when data is null/undefined', () => {
    const { container } = render(<StructuredData data={null} />);
    expect(scriptEl(container)).toBeNull();
    const { container: c2 } = render(<StructuredData data={undefined} />);
    expect(scriptEl(c2)).toBeNull();
  });
});
