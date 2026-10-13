/**
 * What the knowledge base reads out of a doc's Markdown: links to other docs (backlinks),
 * mentioned members (notifications), files it shows (signed for each reader), and plain text
 * for search and snippets. Code blocks and inline code never count as links or mentions.
 */

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DOC_LINK = new RegExp(`#/knowledge/(doc_${ULID})(?![0-9A-Za-z])`, 'g');
/** `[@Name](member:mbr_…)`; the name may carry escaped brackets. */
const MENTION = new RegExp(`\\[@(?:\\\\.|[^\\]\\\\\\n])*\\]\\(member:(mbr_${ULID})\\)`, 'g');
/** A file of ours shown in a doc; the query is a signature made for one reader. */
const FILE_LINK = new RegExp(`/api/files/(fil_${ULID})/content(?:\\?[^\\s)"'<>\\]]*)?`, 'g');

/** The Markdown without fenced code blocks and inline code: what is prose and links. */
export function withoutCode(markdown: string): string {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ').replace(/`[^`\n]*`/g, ' ');
}

const unique = (values: Iterable<string>) => [...new Set(values)];

/** The docs this one links to (`[Title](#/knowledge/doc_…)`), each once. */
export function docLinkIds(markdown: string): string[] {
  return unique([...withoutCode(markdown).matchAll(DOC_LINK)].map((match) => match[1]!));
}

/** The members it mentions (`[@Name](member:mbr_…)`), each once. */
export function mentionIds(markdown: string): string[] {
  return unique([...withoutCode(markdown).matchAll(MENTION)].map((match) => match[1]!));
}

/** The files it shows or links, each once. */
export function fileLinkIds(markdown: string): string[] {
  return unique([...markdown.matchAll(FILE_LINK)].map((match) => match[1]!));
}

/** Stored form: file links without anyone's signature, so a saved doc never carries one. */
export function canonicalFileLinks(markdown: string): string {
  return markdown.replace(FILE_LINK, '/api/files/$1/content');
}

/** Read form: every file link signed for the reader (opening it checks their access again). */
export function signFileLinks(markdown: string, url: (fileId: string) => string): string {
  return markdown.replace(FILE_LINK, (_match, id: string) => url(id));
}

/** Rewrites file links (for an export that carries the files next to the Markdown). */
export function replaceFileLinks(markdown: string, to: (fileId: string) => string | null): string {
  return markdown.replace(FILE_LINK, (match, id: string) => to(id) ?? match);
}

/** Rewrites links to docs (for an export: to the exported file when it is there). */
export function replaceDocLinks(markdown: string, to: (docId: string) => string | null): string {
  return markdown.replace(new RegExp(`\\]\\((?:[^()\\s]*)#/knowledge/(doc_${ULID})\\)`, 'g'), (match, id: string) => {
    const target = to(id);
    return target ? `](${target})` : match;
  });
}

/** Readable text: link and image targets, markup and escapes gone; the words stay. */
export function markdownText(markdown: string): string {
  return markdown
    .replace(/^(```|~~~)[^\n]*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^[\s|:-]*-{3,}[\s|:-]*$/gm, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/(\*\*|__|~~|[*`|])/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * About `size` characters of `text` around the earliest of the words, on one line, with an
 * ellipsis where cut; the start of the text when none is there.
 */
export function snippetFor(text: string, words: readonly string[], size = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = word ? lower.indexOf(word.toLowerCase()) : -1;
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${flat.slice(0, size)}…`;
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size));
  return `${start ? '…' : ''}${flat.slice(start, start + size)}${start + size < flat.length ? '…' : ''}`;
}
