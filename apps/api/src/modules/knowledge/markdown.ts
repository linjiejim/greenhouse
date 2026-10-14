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

/** A file's bytes on this server: `/api/files/<id>/content`, with a query once signed. */
const FILE_PATH = `/api/files/(fil_${ULID})/content`;
/**
 * A file link as written: maybe an origin (`https://host`) in front, maybe a query (a signature
 * someone pasted). It starts where an address can start (the beginning, a space, `(`, `<`, a
 * quote or `=`), never inside another address, and nothing path-like follows it.
 */
const FILE_LINK = new RegExp(
  String.raw`(?<![^\s(<"'=])([Hh][Tt][Tt][Pp][Ss]?://[^\s/?#()<>"'[\]\\]+)?${FILE_PATH}(\?[^\s()<>"'[\]\\]*)?(?![\w/.~%-])`,
  'g',
);

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

/**
 * The files of this server a text shows or links. Only a link with no origin or with this
 * server's own origin (`PUBLIC_URL`) is one: the same path on any other host is left as it is,
 * never canonicalised, signed or exported.
 */
export interface FileLinks {
  /** The files it shows or links, each once. */
  ids(markdown: string): string[];
  /** Stored form: without anyone's signature, so saved text never carries one. */
  canonical(markdown: string): string;
  /**
   * Read form: signed for one reader (opening it checks their access again). An address is
   * signed only as the whole target of a Markdown link or image that nothing around can extend
   * (wholeTargets); inside another address, raw HTML, an autolink or plain text it stays unsigned.
   */
  sign(markdown: string, url: (fileId: string) => string): string;
  /** Rewrites them (an export points them at the files packed next to the Markdown). */
  replace(markdown: string, to: (fileId: string) => string | null): string;
}

export function fileLinks(publicUrl: string): FileLinks {
  const own = originOf(publicUrl);
  /** No origin, or exactly this server's (`https://host[:port]`, nothing more). */
  const ours = (origin: string) =>
    !origin || (/^https?:\/\/[^\s/?#]+$/i.test(origin) && own !== null && originOf(origin) === own);
  const rewrite = (
    markdown: string,
    to: (id: string, origin: string, written: string, at: number, end: number) => string,
  ) =>
    markdown.replace(FILE_LINK, (written, origin: string | undefined, id: string, _query: unknown, at: number) =>
      ours(origin ?? '') ? to(id, origin ?? '', written, at, at + written.length) : written,
    );

  return {
    ids: (markdown) =>
      unique([...markdown.matchAll(FILE_LINK)].flatMap((match) => (ours(match[1] ?? '') ? [match[2]!] : []))),

    canonical: (markdown) => rewrite(markdown, (id, origin) => `${origin}/api/files/${id}/content`),

    sign(markdown, url) {
      if (!markdown.includes('/api/files/') || BASE_TAG.test(markdown)) return markdown;
      const targets = wholeTargets(markdown);
      const signed = new Map<string, string>();
      return rewrite(markdown, (id, origin, written, at, end) => {
        // The target must end right after the address: at `)`, or at a space before a title.
        const after = markdown[end] ?? '';
        if (!targets.has(at) || !(after === ')' || ASCII_SPACE.has(after))) return written;
        const address = signed.get(id) ?? url(id);
        signed.set(id, address);
        return `${origin}${address}`;
      });
    },

    replace: (markdown, to) => rewrite(markdown, (id, _origin, written) => to(id) ?? written),
  };
}

/** A `<base>` points every relative address of a page elsewhere: a text with one gets no signature. */
const BASE_TAG = /<base[\s/>]/i;
/** What ends a link target and an address written in text: ASCII spaces and line breaks. */
const ASCII_SPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const isLetter = (char: string | undefined) => !!char && /[A-Za-z]/.test(char);
/** Spaces as a browser reads them inside a tag. */
const isTagSpace = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r';
/** Elements whose content is not markup: a `<` inside them never starts a tag. */
const RAW_TEXT = /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)$/i;

/**
 * Where the target of a Markdown link or image starts, for each link nothing around it can turn
 * into part of a longer address. Its text is plain (no bracket, backtick, `<` or line break), and
 * its `[` is outside every other link's target, and outside any run of characters (up to an ASCII
 * space) that holds a bare address (`://`, `www.`), a reference definition (`]:`), raw HTML, an
 * autolink or an angle-bracket target. A `<` reaches as far as a browser reads a tag (quoted
 * values may hold anything, across lines) or as far as the parser reads an angle-bracket target,
 * whichever is longer. One pass, so a hostile text costs no more than a plain one; in doubt a
 * picture stays unsigned, and a signature never lands inside someone else's address.
 */
function wholeTargets(text: string): Set<number> {
  const starts = new Set<number>();
  /** This run of non-space characters may be part of another address. */
  let dirty = false;
  /** After `]:`, the next run is a reference definition's target. */
  let definition = false;
  let inRun = false;
  /** The `[` of a link text that is plain so far, and whether its run was clean. */
  let open = -1;
  let openClean = false;
  /**
   * Inside a link target, and how deep in parentheses. A `trusted` one belongs to a plain link
   * in a clean run, which the parser always reads as a link: an address inside it is no bare one.
   */
  let target: 'trusted' | 'unknown' | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (ASCII_SPACE.has(char)) {
      inRun = false;
      dirty = false;
      target = null;
      if (char === '\n') open = -1;
      continue;
    }
    if (!inRun) {
      inRun = true;
      if (definition) {
        dirty = true;
        definition = false;
      }
    }
    if (char === '\\') {
      if (ASCII_PUNCTUATION.test(text[i + 1] ?? '')) i++;
    } else if (char === '<') {
      i = Math.max(angleEnd(text, i), tagEnd(text, i)) - 1;
      dirty = true;
      target = null;
      open = -1;
    } else if (target) {
      // A target ends at an unbalanced `)`; a control character makes it no link at all.
      if (char === '(') depth++;
      else if (char === ')' && depth-- === 0) target = null;
      else if (char < ' ') {
        dirty = true;
        target = null;
      } else if (target === 'unknown' && startsAddress(text, i)) dirty = true;
    } else if (char === '`') {
      open = -1;
    } else if (char === '[') {
      open = i;
      openClean = !dirty;
    } else if (char === ']') {
      if (text[i + 1] === '(') {
        const trusted = open >= 0 && openClean;
        if (trusted) starts.add(i + 2);
        target = trusted ? 'trusted' : 'unknown';
        depth = 0;
        i++;
      } else if (text[i + 1] === ':') {
        dirty = true;
        definition = true;
      }
      open = -1;
    } else if (startsAddress(text, i)) {
      dirty = true;
    }
  }
  return starts;
}

/** An address the parser links where it is written: `scheme://…` or `www.…`. */
const startsAddress = (text: string, i: number) =>
  (text[i] === ':' && text[i + 1] === '/' && text[i + 2] === '/') ||
  ((text[i] === 'w' || text[i] === 'W') && /^www\./i.test(text.slice(i, i + 4)));

/** Where an angle-bracket target or autolink starting here ends: the next unescaped `>` on its line. */
function angleEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') i++;
    else if (char === '>') return i + 1;
    else if (char === '\n' || char === '<') return i;
  }
  return text.length;
}

/** Where a tag starting here ends as a browser reads it; just past the `<` when it is not one. */
function tagEnd(text: string, at: number): number {
  const end = text.length;
  const upTo = (close: string, from: number) => {
    const found = text.indexOf(close, from);
    return found < 0 ? end : found + close.length;
  };
  let i = at + 1;
  const first = text[i];
  if (first === '!') return text.startsWith('--', i + 1) ? upTo('-->', i + 3) : upTo('>', i);
  if (first === '?') return upTo('>', i);
  const closing = first === '/';
  if (closing) i++;
  if (!isLetter(text[i])) return closing ? upTo('>', i) : at + 1;
  const nameStart = i;
  while (i < end && !isTagSpace(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
  const name = text.slice(nameStart, i);
  for (;;) {
    while (i < end && (isTagSpace(text[i]) || text[i] === '/')) i++;
    if (i >= end) return end;
    if (text[i] === '>') break;
    while (i < end && !isTagSpace(text[i]) && text[i] !== '/' && text[i] !== '>' && text[i] !== '=') i++;
    while (i < end && isTagSpace(text[i])) i++;
    if (text[i] !== '=') continue;
    i++;
    while (i < end && isTagSpace(text[i])) i++;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1);
      if (close < 0) return end;
      i = close + 1;
    } else {
      while (i < end && !isTagSpace(text[i]) && text[i] !== '>') i++;
    }
  }
  i++;
  if (closing || !RAW_TEXT.test(name)) return i;
  // Its content runs to its own closing tag, whatever it holds.
  const close = new RegExp(`</${name}`, 'gi');
  close.lastIndex = i;
  return close.exec(text) ? upTo('>', close.lastIndex) : end;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
