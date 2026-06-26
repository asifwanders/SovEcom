/**
 * Server-side Markdown renderer for CMS-lite page bodies (XSS-critical).
 *
 * `pages.body` is admin-authored Markdown rendered to the PUBLIC storefront. Because the author is
 * trusted-ish but the audience is the public web, the body is a stored-XSS surface, so it
 * is rendered through react-markdown + rehype-sanitize with the DEFAULT safe schema:
 *
 *   - No `dangerouslySetInnerHTML` of unsanitized input — react-markdown builds a sanitized React
 *     tree, never injects raw HTML strings.
 *   - No raw-HTML passthrough: `rehype-raw` is deliberately NOT used, so any literal HTML in the
 *     Markdown source (e.g. `<script>`, `<div onclick=…>`) is treated as inert text, not parsed
 *     into DOM. rehype-sanitize is the defense-in-depth layer on top, stripping any disallowed
 *     element, attribute, event handler, and `javascript:`/other unsafe-protocol URL that could
 *     otherwise slip through.
 *
 * `shiftHeadings` downshifts the body's heading levels (h1→h2, …, clamped at h6). Pages that already
 * render their own page-title `<h1>` (the legal/content routes do) pass `shiftHeadings={1}` so an
 * authored leading `# Title` doesn't become a SECOND `<h1>` — keeping exactly one h1 per page (a11y/SEO).
 *
 * This is a server component (RSC) — static page content needs no client interactivity.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Build a components map that renders each Markdown heading shifted DOWN by `shift` levels (clamped
 * at h6). The `node` prop react-markdown passes is an internal hast node, not a valid DOM attribute,
 * so it is dropped before the remaining props are spread onto the heading element.
 */
function headingShiftComponents(shift: number): Components {
  const components: Components = {};
  for (let level = 1; level <= 6; level += 1) {
    const Tag = `h${Math.min(level + shift, 6)}` as 'h1';
    components[`h${level}` as 'h1'] = function ShiftedHeading({ node: _node, ...props }) {
      return <Tag {...props} />;
    };
  }
  return components;
}

/**
 * Render a Markdown string as a sanitized React tree. Markdown-only (links, headings, lists, bold,
 * etc.); all raw HTML and dangerous attributes/URLs are stripped by rehype-sanitize's default schema.
 * `shiftHeadings` (default 0 = no remap) downshifts heading levels so an embedded body keeps a single
 * top-level heading below the host page's `<h1>`.
 */
export function Markdown({
  children,
  shiftHeadings = 0,
}: {
  children: string;
  shiftHeadings?: number;
}) {
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeSanitize]}
      components={shiftHeadings > 0 ? headingShiftComponents(shiftHeadings) : undefined}
    >
      {children}
    </ReactMarkdown>
  );
}
