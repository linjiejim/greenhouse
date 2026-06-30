/**
 * Shared PostgreSQL full-text-search query builder.
 *
 * Turns a free-text query into a prefix-match `to_tsquery` string
 * (`word:* | word:*`). Returns null when nothing usable remains — callers
 * fall back to ILIKE in that case.
 *
 * Used by the knowledge-base service.
 *
 * NOTE: `search.ts` has a richer, intentionally different variant (stopword
 * filtering + Unicode normalisation + parameterised AND/OR) and does NOT use
 * this helper — folding it in here would add options with a single consumer.
 */
export function buildPrefixTsQuery(query: string): string | null {
  const words = query
    .replace(/['"\\]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(' | ');
}
