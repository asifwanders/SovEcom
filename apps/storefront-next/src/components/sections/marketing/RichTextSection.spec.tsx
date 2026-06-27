/**
 * WS-3d — RichTextSection tests.
 *
 * XSS / sanitization is the critical test here:
 *   - A <script> tag in the Markdown source MUST NOT render as an executable <script> element.
 *   - A javascript: href in a Markdown link MUST NOT survive in the output.
 *   - Normal Markdown (headings, bold, links) renders correctly.
 *
 * RichTextSection delegates entirely to <Markdown>, which uses react-markdown + rehype-sanitize
 * with the default schema. We render the component output and inspect the DOM.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { RichTextSettings } from '@sovecom/theme-sdk';
import type { SectionProps } from '@/lib/sections/registry';

import { RichTextSection } from './RichTextSection';

function props(settings: RichTextSettings, extra: Partial<SectionProps> = {}): SectionProps {
  return {
    settings: settings as unknown as Record<string, unknown>,
    data: undefined,
    locale: 'en',
    ...extra,
  };
}

describe('RichTextSection', () => {
  it('renders plain paragraph text', async () => {
    renderWithIntl(await RichTextSection(props({ markdown: 'Hello world' })));
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders a Markdown heading', async () => {
    renderWithIntl(await RichTextSection(props({ markdown: '## Our Story' })));
    expect(screen.getByRole('heading', { name: 'Our Story' })).toBeInTheDocument();
  });

  it('renders bold text', async () => {
    const { container } = renderWithIntl(
      await RichTextSection(props({ markdown: 'This is **bold** text' })),
    );
    expect(container.querySelector('strong')).not.toBeNull();
  });

  it('renders a safe link', async () => {
    renderWithIntl(await RichTextSection(props({ markdown: '[About us](/about)' })));
    const link = screen.getByRole('link', { name: 'About us' });
    expect(link).toHaveAttribute('href', '/about');
  });

  it('XSS: a <script> tag in Markdown does NOT render as an executable <script> element', async () => {
    const { container } = renderWithIntl(
      await RichTextSection(props({ markdown: 'Safe text\n\n<script>alert(1)</script>' })),
    );
    // rehype-sanitize (default schema) strips <script> elements entirely.
    expect(container.querySelector('script')).toBeNull();
    // The raw text "alert(1)" should NOT appear as executable code in the DOM.
    // (It may appear as inert text content if rehype-raw were used, but we don't use rehype-raw.)
  });

  it('XSS: javascript: href in a Markdown link is stripped by rehype-sanitize', async () => {
    const { container } = renderWithIntl(
      await RichTextSection(props({ markdown: '[Click me](javascript:alert(1))' })),
    );
    // rehype-sanitize default schema drops javascript: protocol links.
    // The link may be absent or href removed — assert no javascript: href survives.
    const links = container.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      expect(href.toLowerCase()).not.toMatch(/javascript:/);
    }
  });

  it('XSS: inline onclick attribute is stripped by rehype-sanitize', async () => {
    const { container } = renderWithIntl(
      await RichTextSection(props({ markdown: '<div onclick="alert(1)">Click me</div>' })),
    );
    // No element should retain an onclick attribute.
    const allEls = container.querySelectorAll('*');
    for (const el of allEls) {
      expect(el.getAttribute('onclick')).toBeNull();
    }
  });

  it('renders empty markdown without crashing', async () => {
    const { container } = renderWithIntl(await RichTextSection(props({ markdown: '' })));
    expect(container.querySelector('section')).not.toBeNull();
  });
});
