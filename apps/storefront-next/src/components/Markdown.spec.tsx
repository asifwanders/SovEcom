import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

/**
 * SECURITY REGRESSION TEST (XSS-critical).
 *
 * `pages.body` is admin-authored Markdown rendered to the PUBLIC storefront. The render path uses
 * react-markdown + rehype-sanitize with the default safe schema and NO raw-HTML passthrough
 * (no rehype-raw). These tests assert the dangerous payloads are stripped and that safe Markdown
 * still renders correctly.
 */
describe('Markdown — sanitization (XSS guard)', () => {
  it('strips a <script> tag — no executable script element is created', () => {
    const { container } = render(
      <Markdown>{'Hello\n\n<script>window.__pwned = true;</script>'}</Markdown>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('window.__pwned');
  });

  it('strips an onerror event handler from an <img>', () => {
    const { container } = render(
      <Markdown>{'<img src="x" onerror="window.__pwned=true">'}</Markdown>,
    );
    // Either the img is dropped entirely or it survives WITHOUT the onerror handler — never with it.
    const img = container.querySelector('img');
    if (img) {
      expect(img.getAttribute('onerror')).toBeNull();
      expect(img.outerHTML).not.toContain('onerror');
    }
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('strips a javascript: URL from a link href', () => {
    const { container } = render(
      <Markdown>{'[click me](javascript:window.__pwned=true)'}</Markdown>,
    );
    const anchor = container.querySelector('a');
    // rehype-sanitize drops disallowed-protocol hrefs; the link text remains but href is not js:.
    const href = anchor?.getAttribute('href') ?? '';
    expect(href.toLowerCase()).not.toContain('javascript:');
    expect(container.innerHTML.toLowerCase()).not.toContain('javascript:');
  });

  it('strips inline event handlers embedded in raw HTML blocks', () => {
    const { container } = render(
      <Markdown>{'<div onclick="window.__pwned=true">hi</div>'}</Markdown>,
    );
    expect(container.innerHTML).not.toContain('onclick');
    expect(container.innerHTML).not.toContain('window.__pwned');
  });

  // Obfuscated / alternate-protocol vectors.
  // The render pipeline as a whole (react-markdown's urlTransform for Markdown-native links +
  // rehype-sanitize's safe schema for any raw HTML, with NO rehype-raw) must block every one of
  // these. The raw-HTML cases (entity/tab hrefs, svg/iframe/style, raw <img onerror>) specifically
  // give the suite teeth against the most dangerous regression: someone enabling rehype-raw.
  it.each([
    ['mixed-case js: link', '[x](jAvAsCrIpT:window.__pwned=true)'],
    [
      'raw js: image src+onerror',
      '<img src="javascript:window.__pwned=true" onerror="window.__pwned=true">',
    ],
    ['data:text/html link', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
    ['raw data: image src+onerror', '<img src="data:text/html,<x>" onerror="window.__pwned=true">'],
    ['vbscript: link', '[x](vbscript:window.__pwned=true)'],
    ['entity-obfuscated raw href', '<a href="&#106;avascript:window.__pwned=true">x</a>'],
    ['tab-obfuscated raw href', '<a href="java\tscript:window.__pwned=true">x</a>'],
    ['svg onload', '<svg onload="window.__pwned=true"></svg>'],
    ['iframe js src', '<iframe src="javascript:window.__pwned=true"></iframe>'],
    ['style url(javascript:)', '<style>a{background:url(javascript:window.__pwned=true)}</style>'],
  ])('blocks %s', (_label, payload) => {
    const { container } = render(<Markdown>{payload}</Markdown>);
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('vbscript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('window.__pwned');
    expect(html).not.toContain('onload');
    expect(html).not.toContain('onerror');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
  });
});

describe('Markdown — safe content renders correctly', () => {
  it('renders a heading', () => {
    render(<Markdown>{'# Privacy Policy'}</Markdown>);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders a safe link with its href intact', () => {
    const { container } = render(<Markdown>{'[Home](https://example.com)'}</Markdown>);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.textContent).toBe('Home');
  });

  it('renders bold text and lists', () => {
    const { container } = render(<Markdown>{'**bold** text\n\n- one\n- two'}</Markdown>);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('one');
  });

  it('renders paragraphs of plain text', () => {
    render(<Markdown>{'Just a normal paragraph.'}</Markdown>);
    expect(screen.getByText('Just a normal paragraph.')).toBeInTheDocument();
  });
});

describe('Markdown — shiftHeadings (single-h1 invariant for embedded bodies)', () => {
  it('default (no shift) renders a body heading as <h1>', () => {
    const { container } = render(<Markdown>{'# Title\n\n## Section'}</Markdown>);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('h2')?.textContent).toBe('Section');
  });

  it('shiftHeadings=1 downshifts h1→h2 and h2→h3 (no body <h1>)', () => {
    const { container } = render(<Markdown shiftHeadings={1}>{'# Title\n\n## Section'}</Markdown>);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Title');
    expect(container.querySelector('h3')?.textContent).toBe('Section');
  });

  it('clamps the shift at h6 (h6 stays h6)', () => {
    const { container } = render(<Markdown shiftHeadings={1}>{'###### Deep'}</Markdown>);
    expect(container.querySelector('h6')?.textContent).toBe('Deep');
  });

  it('still strips dangerous content when shifting (sanitizer intact)', () => {
    const { container } = render(
      <Markdown shiftHeadings={1}>{'# Ok\n\n<script>window.__pwned=1</script>'}</Markdown>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('window.__pwned');
  });
});
