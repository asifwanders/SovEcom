/**
 * StructuredData — RSC that emits a single JSON-LD `<script>`.
 *
 * Takes a typed (`schema-dts`) JSON-LD object and renders
 * `<script type="application/ld+json">{serialized}</script>`. The object is OUR first-party catalog
 * data (not arbitrary user HTML), but JSON-LD inside a `<script>` is still an injection surface, so:
 *   - we `JSON.stringify` a typed object (no `dangerouslySetInnerHTML` of free-form input), and
 *   - we escape every `<` to its `<` unicode form, which makes a `</script>` sequence (and any
 *     other tag-like text) impossible to materialize and break out of the script element.
 * This is the standard Next/React-safe JSON-LD pattern. `null`/`undefined` data renders nothing, so
 * callers can pass an optional object without a guard at each call site.
 */
import type { Graph, Thing, WithContext } from 'schema-dts';

/** Any top-level JSON-LD value we render: a `@context`-stamped Thing or a `@graph` document. */
type JsonLd = WithContext<Thing> | Graph;

/**
 * Escape characters that could let a JSON string break out of a `<script>` element, plus the two
 * JSON-legal-but-JS-illegal line separators (U+2028/U+2029). `<` covers `</script>`/`<!--`; `&`/`>`
 * are belt-and-braces. All become their JSON unicode escapes, which `JSON.parse` reads back verbatim.
 * The regex uses `\u` escapes (not literal characters) so the source file stays plain-ASCII.
 */
function safeJsonLd(data: object): string {
  // U+2028 / U+2029 are valid in JSON strings but illegal in JS source; escape them too.
  const dangerous = /[<>&\u2028\u2029]/g;
  return JSON.stringify(data).replace(
    dangerous,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

export function StructuredData({ data }: { data: JsonLd | null | undefined }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      // The payload is escaped above so it cannot break out of the script element.
      dangerouslySetInnerHTML={{ __html: safeJsonLd(data) }}
    />
  );
}
