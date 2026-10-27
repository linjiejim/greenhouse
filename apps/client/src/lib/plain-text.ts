/**
 * Server text (often Markdown: automation summaries, run errors) as one quiet line or a plain
 * paragraph. React-free (./plain-text.test.ts). Fenced blocks say nothing in a list row, so they
 * are dropped rather than flattened.
 */

export function plainText(markdown: string | null | undefined, options: { oneLine?: boolean } = {}): string {
  if (!markdown) return '';
  let text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\|/g, ' ');
  text = options.oneLine ? text.replace(/\s+/g, ' ') : text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
