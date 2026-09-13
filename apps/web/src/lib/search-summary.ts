/**
 * Turn an authored summary into compact plain text for search-result previews.
 * Missing summaries stay empty: the UI must never substitute Markdown body
 * excerpts and present them as document summaries.
 */
export function toSearchSummary(summary: string | null | undefined): string {
  const source = summary?.trim() || '';

  return source
    .replace(/```[\w-]*\n?/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
