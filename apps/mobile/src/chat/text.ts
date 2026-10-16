import { RICH_BLOCKS } from '../shared/rich-output';

const richFence = new RegExp(
  '^[ \t]*```(' +
    RICH_BLOCKS.map((block) => block.fence).join('|') +
    ')[^\\n]*\\n[\\s\\S]*?(?:^[ \t]*```[ \t]*$|(?![\\s\\S]))',
  'gm',
);

/** Plain text out of a reply's Markdown (quotes, menu previews, table cell widths). No React. */

/** A one-line, length-capped excerpt. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Markdown → readable plain text: drops emphasis / code / strike markers, heading hashes, quote
 * markers, fences and table pipes; links and images keep their text.
 */
export function plainText(md: string): string {
  return md
    .replace(richFence, '')
    .replace(/^[ \t]*```.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/gm, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
      row
        .split('|')
        .map((cell) => cell.trim())
        .join('  '),
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
