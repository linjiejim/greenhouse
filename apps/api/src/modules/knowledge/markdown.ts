/**
 * What the knowledge base reads out of a doc's Markdown: links to other docs (backlinks),
 * mentioned members (notifications), files it shows (signed for each reader), and plain text
 * for search and snippets. Code blocks and inline code never count as links or mentions.
 *
 * Every pattern here runs on text anyone can write (up to 500 000 characters), on saves,
 * comments and search hits: each must stay linear. A class never accepts the character that
 * opens its own construct, quantifiers never overlap, and whitespace runs are collapsed before
 * anything looks around a newline.
 */

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DOC_LINK = new RegExp(`#/knowledge/(doc_${ULID})(?![0-9A-Za-z])`, 'g');
/** `[@Name](member:mbr_…)`; the name may carry escaped brackets, never a bare one. */
const MENTION = new RegExp(`\\[@(?:\\\\.|[^\\[\\]\\\\\\n])*\\]\\(member:(mbr_${ULID})\\)`, 'g');
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

/** Link or image text: escaped characters, never a bare bracket, so a run of `[` stays linear. */
const LABEL = String.raw`(?:\\.|[^[\]\\\n])*`;
const IMAGE = new RegExp(String.raw`!\[(${LABEL})\]\([^()\n]*\)`, 'g');
const LINK = new RegExp(String.raw`\[(${LABEL})\]\([^()\n]*\)`, 'g');

/** Readable text: link and image targets, markup and escapes gone; the words stay. */
export function markdownText(markdown: string): string {
  return (
    markdown
      .replace(/^(```|~~~)[^\n]*$/gm, ' ')
      .replace(IMAGE, '$1')
      .replace(LINK, '$1')
      .replace(/<[^<>\n]+>/g, ' ')
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
      // A table's rule line or a horizontal rule: one quantifier over the line, then a plain check.
      .replace(/^[ \t|:-]+$/gm, (line) => (line.includes('---') ? ' ' : line))
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/(\*\*|__|~~|[*`|])/g, ' ')
      // Spaces first (any kind but the newline), so what follows never scans a long run twice.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n\s*/g, '\n')
      .trim()
  );
}

/**
 * About `size` characters of `text` around the earliest of the words, on one line, with an
 * ellipsis where cut; the start of the text when none is there.
 */
export function snippetFor(text: string, words: readonly string[], size = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const at = earliest(flat, words);
  if (at < 0) return `${flat.slice(0, size)}…`;
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size));
  return `${start ? '…' : ''}${flat.slice(start, start + size)}${start + size < flat.length ? '…' : ''}`;
}

/** Markdown read around a match for a snippet: enough for one line on either side. */
const SNIPPET_WINDOW = 1_000;

/**
 * A snippet of a doc's Markdown: the Markdown is cut around the earliest word first, so a long
 * doc costs no more than a short one.
 */
export function docSnippet(markdown: string, words: readonly string[], size = 160): string {
  const at = earliest(markdown, words);
  const start = Math.max(0, at - SNIPPET_WINDOW);
  const end = Math.max(at, 0) + SNIPPET_WINDOW;
  let snippet = snippetFor(markdownText(markdown.slice(start, end)), words, size);
  if (!snippet) return snippet;
  if (start > 0 && !snippet.startsWith('…')) snippet = `…${snippet}`;
  if (end < markdown.length && !snippet.endsWith('…')) snippet = `${snippet}…`;
  return snippet;
}

/** Where the first of the words is in the text, case aside; -1 when none is. */
function earliest(text: string, words: readonly string[]): number {
  const lower = text.toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = word ? lower.indexOf(word.toLowerCase()) : -1;
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at;
}
