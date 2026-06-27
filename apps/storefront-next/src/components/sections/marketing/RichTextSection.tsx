/**
 * WS-3d — `rich-text` marketing section renderer.
 *
 * RSC (no "use client"). Renders merchant-authored Markdown via the existing <Markdown> component
 * (react-markdown + rehype-sanitize, NO rehype-raw, NO dangerouslySetInnerHTML).
 *
 * XSS posture: all sanitization is delegated to <Markdown>. This component MUST NOT:
 *   - Use dangerouslySetInnerHTML with settings.markdown.
 *   - Import or use rehype-raw.
 *   - Render the raw string as HTML in any other way.
 *
 * The Markdown component uses rehype-sanitize's DEFAULT schema: strips <script>, event attributes,
 * javascript: URLs, and all disallowed elements/attributes. Any raw HTML in the Markdown source
 * (including <script> tags) is treated as inert text (not parsed to DOM) because rehype-raw is absent.
 *
 * `shiftHeadings={1}` prevents a leading `# Title` from becoming a second <h1> on the page (a11y/SEO).
 */
import type { SectionProps } from '@/lib/sections/registry';
import type { RichTextSettings } from '@sovecom/theme-sdk';
import { Markdown } from '@/components/Markdown';

export async function RichTextSection({ settings }: SectionProps) {
  const s = settings as unknown as RichTextSettings;

  return (
    <section className="prose prose-neutral max-w-none py-4">
      {/* Security: render ONLY through <Markdown> — never dangerouslySetInnerHTML */}
      <Markdown shiftHeadings={1}>{s.markdown}</Markdown>
    </section>
  );
}
