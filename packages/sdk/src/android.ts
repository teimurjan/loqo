/** Markup the quote rules do not apply to: tag attributes carry their own quotes, CDATA is verbatim. */
const OPAQUE = /(<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>)/;

/** A backslash escape is kept as a pair (`\"` is a literal quote); a bare `"` goes. */
const dropQuotes = (text: string): string => text.replace(/\\[\s\S]|"/g, (match) => (match === '"' ? '' : match));

/**
 * Android resource text quotes a run to keep its whitespace and apostrophes — `"  Padded  "`,
 * `<xliff:g id="n">"%1$s"</xliff:g>" left"` — and aapt drops every unescaped `"` at build time.
 * The quotes are file syntax, not content, so a value is stored without them and re-quoted on push.
 */
export const unwrapAndroidQuotes = (value: string): string =>
  value
    .split(OPAQUE)
    .map((segment, index) => (index % 2 === 1 ? segment : dropQuotes(segment)))
    .join('');
