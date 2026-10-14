/**
 * Tiptap (ProseMirror) JSON → canonical Markdown.
 *
 * The inverse of md-html: what the editor holds is written back as Markdown that parses (marked,
 * GFM) into the same document, so opening a doc and saving it never changes what it says. Both
 * directions of the Markdown ⇄ editor round-trip live in this package and share one schema.
 *
 * - Blocks are separated by a blank line; what sits inside a list item is indented by the width
 *   of its marker, so nested lists stay nested under `1.` as well as under `-`.
 * - Marks open and close as the marks of the text change, with spaces kept outside the delimiters
 *   (`**Note:** rest`, never `**Note: **rest`). Where Markdown would not read a delimiter as one
 *   (CommonMark's flanking rules, which bite next to CJK punctuation: `**注意：**请看`), the mark
 *   is written as its HTML tag instead.
 * - Hard breaks are a backslash at the end of the line; in headings and table cells, which are
 *   one line, they are `<br>`.
 * - Text is escaped only where Markdown would read it as syntax, so prose like "LPH-Max", "v1.0"
 *   or "(2026)" passes through as typed (audit 2026-06-10 defect #5).
 *
 * Not kept: HTML that ProseMirror has no node for (comments, `<details>`, …) is gone once the
 * editor has loaded the doc.
 */

/** Minimal shape of a Tiptap/ProseMirror JSON node (kept dependency-free). */
export interface TiptapNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: TiptapNode[];
}

type Mark = NonNullable<TiptapNode['marks']>[number];

/** How a hard break is written: a backslash line end, or `<br>` where the block is one line. */
type Breaks = 'line' | 'html';

// ─── Characters ──────────────────────────────────────────

const isSpace = (char: string | undefined) => char === undefined || /\s/u.test(char);
/** CommonMark's punctuation: Unicode punctuation and symbols. */
const isPunctuation = (char: string | undefined) => char !== undefined && /[\p{P}\p{S}]/u.test(char);

/** Characters that would be read as Markdown inside a line. */
function escapeText(text: string, { inLink, tildes }: { inLink: boolean; tildes: boolean }): string {
  let out = text.replace(inLink ? /[\\`*_[\]]/g : /[\\`*_[]/g, '\\$&');
  // A tag or an entity would be read as HTML: `<b>` typed as text stays text, `&amp;` stays `&amp;`.
  out = out.replace(/<(?=[A-Za-z/!?])/g, '\\<').replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  // One tilde can't strike anything; two or more can (marked strikes `~a~` too).
  if (tildes) out = out.replace(/~/g, '\\~');
  return out;
}

/**
 * Block syntax at the start of a line of a paragraph: headings, quotes, list markers, a line
 * of `-` or `=` (a rule, or the underline of a heading), and indentation (code).
 */
function escapeLineStart(line: string): string {
  const text = line.replace(/^[ \t]+/, '');
  if (/^(?:-+|=+)[ \t]*$/.test(text)) return `\\${text}`;
  // Ordered lists: the escapable character is the punctuation, not the digit ("1\. text").
  const ordered = /^(\d{1,9})([.)])(?=\s|$)/.exec(text);
  if (ordered) return `${ordered[1]}\\${ordered[2]}${text.slice(ordered[0].length)}`;
  if (/^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$))/.test(text)) return `\\${text}`;
  return text;
}

/** A link or picture address: in angle brackets when it has spaces or brackets. */
function destination(url: string): string {
  if (!/[\s()<>]/.test(url)) return url;
  return `<${url.replace(/[<>\n]/g, (char) => encodeURIComponent(char))}>`;
}

const title = (value: unknown) => (typeof value === 'string' && value ? ` "${value.replace(/[\\"]/g, '\\$&')}"` : '');

/** Inline code: enough backticks to hold the backticks inside, padded where it starts or ends with one. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  // CommonMark strips one space from each side when both have one, and needs one next to a backtick.
  const pad = /^`|`$/.test(text) || (/^ .*[^ ].* $/.test(text) && text.length > 2) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// ─── Inline content ──────────────────────────────────────

/** Outermost first: a link holds bold, bold holds italic, and so on. Code is a span of its own. */
const MARK_ORDER = ['link', 'bold', 'italic', 'strike'] as const;
type MarkType = (typeof MARK_ORDER)[number];

const TAGS: Record<Exclude<MarkType, 'link'>, { md: string; open: string; close: string }> = {
  bold: { md: '**', open: '<strong>', close: '</strong>' },
  italic: { md: '*', open: '<em>', close: '</em>' },
  strike: { md: '~~', open: '<del>', close: '</del>' },
};

const sameMark = (a: Mark, b: Mark) => a.type === b.type && (a.type !== 'link' || a.attrs?.href === b.attrs?.href);
const hasMark = (marks: readonly Mark[], mark: Mark) => marks.some((other) => sameMark(other, mark));

function ordered(marks: TiptapNode['marks']): Mark[] {
  return (marks ?? [])
    .filter((mark) => (MARK_ORDER as readonly string[]).includes(mark.type))
    .filter((mark) => mark.type !== 'link' || String(mark.attrs?.href ?? ''))
    .sort((a, b) => MARK_ORDER.indexOf(a.type as MarkType) - MARK_ORDER.indexOf(b.type as MarkType));
}

/** A run of inline content with the same marks: text to escape, code, a mention, a break. */
interface Piece {
  kind: 'text' | 'code' | 'atom' | 'break';
  text: string;
  marks: Mark[];
}

function pieces(nodes: readonly TiptapNode[]): Piece[] {
  const out: Piece[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      if (!node.text) continue;
      const code = (node.marks ?? []).some((mark) => mark.type === 'code');
      out.push({ kind: code ? 'code' : 'text', text: node.text, marks: ordered(node.marks) });
    } else if (node.type === 'hardBreak') {
      out.push({ kind: 'break', text: '', marks: [] });
    } else if (node.type === 'mention') {
      // `[@label](member:<id>)`: the `member:<id>` target is what the server reads to notify them.
      const id = String(node.attrs?.id ?? '');
      const label = String(node.attrs?.label ?? id);
      out.push(
        id
          ? { kind: 'atom', text: `[@${label.replace(/[\\[\]]/g, '\\$&')}](member:${id})`, marks: ordered(node.marks) }
          : { kind: 'text', text: `@${label}`, marks: ordered(node.marks) },
      );
    } else {
      const text = rawText(node);
      if (text) out.push({ kind: 'text', text, marks: ordered(node.marks) });
    }
  }
  // A break at the end of a block shows nothing, and a backslash there would show as itself.
  const blank = (piece: Piece) => piece.kind === 'break' || (piece.kind === 'text' && !piece.text.trim());
  while (out.length && blank(out[out.length - 1]!)) out.pop();
  return out;
}

/**
 * Spaces at the edge of a marked run move outside it (`**Note:** rest`): a delimiter next to a
 * space is not read as one. A break keeps the marks around it (except code, which can't span lines).
 */
function settleSpaces(list: Piece[]): Piece[] {
  const out: Piece[] = [];
  list.forEach((piece, index) => {
    const before = list[index - 1]?.marks ?? [];
    const after = list[index + 1]?.marks ?? [];
    if (piece.kind === 'break') {
      out.push({ ...piece, marks: before.filter((mark) => hasMark(after, mark)) });
      return;
    }
    if (piece.kind !== 'text') {
      out.push(piece);
      return;
    }
    if (!piece.text.trim()) {
      out.push({ ...piece, marks: piece.marks.filter((mark) => hasMark(before, mark) && hasMark(after, mark)) });
      return;
    }
    const [, lead = '', body = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece.text) ?? [];
    if (lead) out.push({ kind: 'text', text: lead, marks: piece.marks.filter((mark) => hasMark(before, mark)) });
    out.push({ ...piece, text: body });
    if (trail) out.push({ kind: 'text', text: trail, marks: piece.marks.filter((mark) => hasMark(after, mark)) });
  });
  return out;
}

interface Run {
  mark: Mark;
  /** Written as the HTML tag, where the Markdown delimiter would not be read as one. */
  html: boolean;
}
type Token = { kind: 'text'; text: string } | { kind: 'open' | 'close'; run: Run };

function tokens(list: readonly Piece[], breaks: Breaks): Token[] {
  const tildes =
    list.some((piece) => piece.marks.some((mark) => mark.type === 'strike')) ||
    list.reduce((count, piece) => count + (piece.kind === 'text' ? (piece.text.match(/~/g)?.length ?? 0) : 0), 0) > 1;
  const out: Token[] = [];
  const stack: Run[] = [];
  for (const piece of list) {
    let keep = 0;
    while (keep < stack.length && keep < piece.marks.length && sameMark(stack[keep]!.mark, piece.marks[keep]!)) keep++;
    while (stack.length > keep) out.push({ kind: 'close', run: stack.pop()! });
    for (const mark of piece.marks.slice(keep)) {
      const run = { mark, html: false };
      stack.push(run);
      out.push({ kind: 'open', run });
    }
    const inLink = piece.marks.some((mark) => mark.type === 'link');
    const text =
      piece.kind === 'text'
        ? escapeText(piece.text, { inLink, tildes })
        : piece.kind === 'code'
          ? codeSpan(piece.text)
          : piece.kind === 'break'
            ? breaks === 'line'
              ? '\\\n'
              : '<br>'
            : piece.text;
    out.push({ kind: 'text', text });
  }
  while (stack.length) out.push({ kind: 'close', run: stack.pop()! });
  return out;
}

function delimiter(token: Exclude<Token, { kind: 'text' }>): string {
  const { mark, html } = token.run;
  if (mark.type === 'link') {
    if (token.kind === 'open') return '[';
    return `](${destination(String(mark.attrs?.href ?? ''))}${title(mark.attrs?.title)})`;
  }
  const tag = TAGS[mark.type as Exclude<MarkType, 'link'>];
  if (!html) return tag.md;
  return token.kind === 'open' ? tag.open : tag.close;
}

/**
 * Writes the tokens; a delimiter Markdown would not read as one (CommonMark's left- and
 * right-flanking rules) turns its run into HTML tags, and the line is written again.
 */
function write(list: readonly Token[]): string {
  for (let attempt = 0; ; attempt++) {
    let out = '';
    const places = new Map<Run, { open: [number, number]; close: [number, number] }>();
    for (const token of list) {
      if (token.kind === 'text') {
        out += token.text;
        continue;
      }
      const start = out.length;
      out += delimiter(token);
      const place = places.get(token.run) ?? { open: [start, out.length], close: [start, out.length] };
      place[token.kind] = [start, out.length];
      places.set(token.run, place);
    }
    const failing = [...places].filter(([run, place]) => {
      if (run.html || run.mark.type === 'link') return false;
      const char = run.mark.type === 'strike' ? '~' : '*';
      // The whole delimiter run counts: `***` where bold and italic meet is one run.
      let from = place.open[0];
      let to = place.open[1];
      while (from > 0 && out[from - 1] === char && out[from - 2] !== '\\') from--;
      while (out[to] === char) to++;
      const opens =
        !isSpace(out[to]) && (!isPunctuation(out[to]) || isSpace(out[from - 1]) || isPunctuation(out[from - 1]));
      from = place.close[0];
      to = place.close[1];
      while (from > 0 && out[from - 1] === char && out[from - 2] !== '\\') from--;
      while (out[to] === char) to++;
      const closes =
        !isSpace(out[from - 1]) && (!isPunctuation(out[from - 1]) || isSpace(out[to]) || isPunctuation(out[to]));
      return !opens || !closes;
    });
    if (!failing.length) return out;
    // Each pass only turns delimiters into tags; after a few, every remaining one is a tag.
    for (const [run] of attempt < 3 ? failing.slice(0, 1) : failing) run.html = true;
  }
}

/** Inline content as Markdown. */
function inline(nodes: readonly TiptapNode[], breaks: Breaks): string {
  return write(tokens(settleSpaces(pieces(nodes)), breaks));
}

/** Raw text content of a subtree (for code blocks — no escaping at all). */
function rawText(node: TiptapNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(rawText).join('');
}

// ─── Blocks ──────────────────────────────────────────────

const LIST_FAMILY: Record<string, 'bullet' | 'ordered'> = {
  bulletList: 'bullet',
  taskList: 'bullet',
  orderedList: 'ordered',
};

/** A list's first line is only its marker: an empty item, which can't follow a paragraph line. */
const EMPTY_ITEM = /^(?:[-*]|\d{1,9}[.)])(?: \[[ x]\])?[ \t]*(?:\n|$)/;

/**
 * Blocks one after another, a blank line between them. Inside a list item, a list follows its
 * paragraph directly so the item stays tight. Two lists of the same kind in a row switch their
 * marker (`-`/`*`, `.`/`)`), or Markdown would read them as one list.
 */
function blocks(nodes: readonly TiptapNode[], inItem = false): string {
  let out = '';
  let previous: TiptapNode | undefined;
  let flip = false;
  for (const node of nodes) {
    const family = LIST_FAMILY[node.type ?? ''];
    flip = !!family && !!previous && LIST_FAMILY[previous.type ?? ''] === family ? !flip : false;
    const md = block(node, flip);
    if (!md) continue;
    if (out) {
      // Only a list that starts at 1 with something in its first item may follow a paragraph line.
      const tight =
        inItem &&
        previous?.type === 'paragraph' &&
        !!family &&
        (family === 'bullet' || Number(node.attrs?.start ?? 1) === 1) &&
        !EMPTY_ITEM.test(md);
      out += tight ? '\n' : '\n\n';
    }
    out += md;
    previous = node;
  }
  return out;
}

/**
 * One list item: its marker, then its blocks indented to where its content starts (`indent`).
 * Null for an empty task: Markdown has no empty task (`- [ ]` alone is the text "[ ]").
 */
function item(node: TiptapNode, marker: string, indent: number): string | null {
  const [first, ...rest] = node.content ?? [];
  const task = node.type === 'taskItem';
  // A box kept as text (a task in a list that also has plain items, see md-html) stays a box.
  const box = (text: string) => (task ? text : text.replace(/^\\(\[[ xX]\] )/, '$1'));
  const lead = first ? box(block(first)) : '';
  const more = blocks(rest, true);
  if (!lead && !more) return task ? null : marker.trimEnd();
  const pad = ' '.repeat(indent);
  const indented = (text: string) => text.split('\n').map((line) => (line ? `${pad}${line}` : ''));
  if (!lead) return [task ? `${marker}&nbsp;` : marker.trimEnd(), ...indented(more)].join('\n');
  const body = box(blocks(node.content ?? [], true));
  const [head = '', ...tail] = body.split('\n');
  return [`${marker}${head}`, ...tail.map((line) => (line ? `${pad}${line}` : ''))].join('\n');
}

function list(node: TiptapNode, flip: boolean): string {
  const items = node.content ?? [];
  if (node.type === 'orderedList') {
    const start = Number(node.attrs?.start ?? 1);
    const first = Number.isFinite(start) && start >= 0 ? Math.floor(start) : 1;
    return items
      .map((child, index) => {
        const marker = `${first + index}${flip ? ')' : '.'} `;
        return item(child, marker, marker.length);
      })
      .filter((line): line is string => line !== null)
      .join('\n');
  }
  const bullet = flip ? '*' : '-';
  return items
    .map((child) =>
      child.type === 'taskItem'
        ? item(child, `${bullet} [${child.attrs?.checked ? 'x' : ' '}] `, 2)
        : item(child, `${bullet} `, 2),
    )
    .filter((line): line is string => line !== null)
    .join('\n');
}

// ─── Tables ──────────────────────────────────────────────

/** A table cell as one line: paragraphs and breaks become `<br>`, pipes are escaped. */
function cell(node: TiptapNode): string {
  return (node.content ?? [])
    .map((child) =>
      child.type === 'paragraph' || child.type === 'heading' ? inline(child.content ?? [], 'html') : blocks([child]),
    )
    .filter(Boolean)
    .join('<br>')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

function table(node: TiptapNode): string {
  const rows = (node.content ?? []).filter((row) => row.type === 'tableRow');
  if (rows.length === 0) return '';
  const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  // GFM needs a header row: the first row is it (Tiptap marks it with tableHeader cells).
  const [head, ...body] = rows.map((entry) => (entry.content ?? []).map(cell));
  const columns = Math.max(1, head!.length);
  const fit = (cells: string[]) =>
    [...cells, ...Array.from({ length: columns - cells.length }, () => '')].slice(0, columns);
  return [
    row(fit(head!)),
    row(Array.from({ length: columns }, () => '---')),
    ...body.map((cells) => row(fit(cells))),
  ].join('\n');
}

// ─── Block rendering ─────────────────────────────────────

function block(node: TiptapNode, flip = false): string {
  const children = node.content ?? [];
  switch (node.type) {
    case 'paragraph':
      return inline(children, 'line').split('\n').map(escapeLineStart).join('\n').trim();
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2));
      // A heading is one line; a `#` run at its end would be read as the closing sequence.
      const text = inline(children, 'html')
        .replace(/\s*\n\s*/g, ' ')
        .trim()
        .replace(/(^|\s)(#+)$/, '$1\\$2');
      return `${'#'.repeat(level)} ${text}`.trimEnd();
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(node, flip);
    case 'blockquote':
      return blocks(children)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language.replace(/[\s`]/g, '') : '';
      // A browser keeps the newline that ends the code in Markdown; without dropping it here
      // every save would add an empty line at the end of the block.
      const code = rawText(node).replace(/\n$/, '');
      const longest = Math.max(0, ...(code.match(/^ {0,3}`{3,}/gm) ?? []).map((run) => run.trim().length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${language}\n${code}\n${fence}`;
    }
    case 'table':
      return table(node);
    case 'image': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '').replace(/[\\[\]]/g, '\\$&');
      return src ? `![${alt}](${destination(src)}${title(node.attrs?.title)})` : '';
    }
    case 'horizontalRule':
      return '---';
    case 'text':
    case 'hardBreak':
    case 'mention':
      return inline([node], 'line');
    default:
      // Something the schema grew later: its words, as a paragraph or as the blocks it holds.
      if (children.some((child) => child.type === 'text' || child.type === 'hardBreak' || child.type === 'mention')) {
        return inline(children, 'line').split('\n').map(escapeLineStart).join('\n').trim();
      }
      return blocks(children);
  }
}

/** Serialize a Tiptap JSON document to canonical Markdown. */
export function tiptapJsonToMarkdown(json: TiptapNode): string {
  if (json.type === 'doc' || !json.type) return blocks(json.content ?? []).trim();
  return block(json).trim();
}
