/**
 * A page as the Agent reads it: the accessibility tree (`Accessibility.getFullAXTree`) folded
 * into short lines, with a ref (`e12`) on everything it can act on, or the page's visible text.
 * Both are bounded; a model never gets a whole DOM.
 */

export interface AxValue {
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value: AxValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface Snapshot {
  lines: string[];
  /** ref → the node's backendDOMNodeId, for every ref in the whole page. */
  refs: Map<string, number>;
}

/** What the Agent can act on: each gets a ref. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'listbox',
  'ListBoxOption',
  'MenuListOption',
  'PopUpButton',
  'DisclosureTriangle',
]);
/** Interactive roles whose children matter too (the options of a list, the tabs of a tab list). */
const HOLDS_CHOICES = new Set(['listbox', 'combobox', 'menu', 'menubar', 'tablist', 'radiogroup', 'tree', 'grid']);
/** Containers worth a line of their own: their contents are indented under them. */
const CONTAINERS = new Set([
  'dialog',
  'alertdialog',
  'alert',
  'form',
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'table',
  'list',
  'menu',
  'menubar',
  'tablist',
  'radiogroup',
  'tree',
  'grid',
  'article',
  'status',
]);
/** Containers shown only when they have a name. */
const NAMED_CONTAINERS = new Set(['region', 'group', 'figure']);
/** Blocks: their text is one line of its own. */
const BLOCKS = new Set([
  'paragraph',
  'listitem',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'caption',
  'blockquote',
  'Pre',
  'LabelText',
  'Legend',
  'term',
  'definition',
  'DescriptionListTerm',
  'DescriptionListDetail',
  'heading',
]);
const SILENT = new Set(['InlineTextBox', 'LineBreak', 'Canvas', 'separator']);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

const NAME_MAX = 120;
const TEXT_MAX = 300;
const VALUE_MAX = 80;
/** Lines kept per page, whatever its size; a window of them goes to the model. */
const MAX_LINES = 4000;
/** The choices shown under one list (a country picker can hold hundreds). */
const MAX_CHOICES = 25;

/** Collapsed and clipped; callers redact first, so a clip never leaves part of a secret. */
const clean = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const quoted = (text: string) => `"${text.replace(/"/g, '\\"')}"`;

function property(node: AxNode, name: string): unknown {
  return node.properties?.find((entry) => entry.name === name)?.value?.value;
}

/** A value the page shows masked (a password field) is never repeated. */
function shownValue(node: AxNode, redact: (text: string) => string): string {
  const raw = node.value?.value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const text = clean(redact(String(raw)), VALUE_MAX);
  return /^[•●*·]+$/.test(text) ? '' : text;
}

function stateOf(node: AxNode, role: string): string {
  const states: string[] = [];
  const checked = property(node, 'checked');
  if (checked === 'true' || checked === true) states.push('checked');
  else if (checked === 'mixed') states.push('mixed');
  else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role))
    states.push('unchecked');
  if (property(node, 'pressed') === 'true' || property(node, 'pressed') === true) states.push('pressed');
  if (property(node, 'selected') === true) states.push('selected');
  const expanded = property(node, 'expanded');
  if (expanded === true) states.push('expanded');
  else if (expanded === false) states.push('collapsed');
  if (property(node, 'disabled') === true) states.push('disabled');
  if (property(node, 'required') === true) states.push('required');
  if (property(node, 'focused') === true) states.push('focused');
  return states.length ? ` (${states.join(', ')})` : '';
}

/**
 * The page's lines and refs; the same tree always gives the same refs. `redact` runs on every
 * piece of page text before it is shortened.
 */
export function buildSnapshot(nodes: readonly AxNode[], redact: (text: string) => string = (text) => text): Snapshot {
  const tidy = (value: unknown, max: number) => clean(typeof value === 'string' ? redact(value) : value, max);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
  const lines: string[] = [];
  const refs = new Map<string, number>();
  let text: string[] = [];

  const push = (depth: number, line: string) => {
    if (lines.length < MAX_LINES) lines.push(`${'  '.repeat(Math.min(depth, 12))}- ${line}`);
  };
  const flush = (depth: number) => {
    if (!text.length) return;
    const joined = tidy(text.join(' '), TEXT_MAX);
    text = [];
    if (joined) push(depth, `text: ${joined}`);
  };

  /** The plain text under a node, and whether something to act on is in there. */
  const plain = (id: string, seen = 0): { text: string; acts: boolean } => {
    const node = byId.get(id);
    if (!node || seen > 200) return { text: '', acts: false };
    const role = String(node.role?.value ?? '');
    if (!node.ignored && INTERACTIVE.has(role)) return { text: '', acts: true };
    if (!node.ignored && role === 'StaticText') return { text: tidy(node.name?.value, TEXT_MAX), acts: false };
    const parts = (node.childIds ?? []).map((child) => plain(child, seen + 1));
    return {
      text: parts
        .map((part) => part.text)
        .filter(Boolean)
        .join(' '),
      acts: parts.some((part) => part.acts),
    };
  };

  const visit = (id: string, depth: number, guard: number) => {
    const node = byId.get(id);
    if (!node || guard > 500) return;
    const children = node.childIds ?? [];
    const role = String(node.role?.value ?? '');
    if (node.ignored || role === 'generic' || role === 'none' || role === 'presentation' || role === 'RootWebArea') {
      for (const child of children) visit(child, depth, guard + 1);
      return;
    }
    if (SILENT.has(role)) return;
    if (role === 'StaticText') {
      if (typeof node.name?.value === 'string' && node.name.value.trim()) text.push(node.name.value);
      return;
    }
    const name = tidy(node.name?.value, NAME_MAX);
    if (INTERACTIVE.has(role)) {
      // The label that names this element was just read: say it once.
      if (name && tidy(text.join(' '), TEXT_MAX) === name) text = [];
      flush(depth);
      let line = `${role}${name ? ` ${quoted(name)}` : ''}`;
      const value = TEXT_ROLES.has(role) ? shownValue(node, redact) : '';
      if (value && value !== name) line += ` value=${quoted(value)}`;
      line += stateOf(node, role);
      if (node.backendDOMNodeId !== undefined) {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [${ref}]`;
      }
      push(depth, line);
      if (HOLDS_CHOICES.has(role)) {
        const before = lines.length;
        for (const child of children) visit(child, depth + 1, guard + 1);
        flush(depth + 1);
        const hidden = lines.length - before - MAX_CHOICES;
        if (hidden > 0) {
          lines.splice(before + MAX_CHOICES);
          push(depth + 1, `… ${hidden} more`);
        }
      }
      return;
    }
    if (role === 'heading') {
      flush(depth);
      const level = property(node, 'level');
      const inside = plain(id);
      const content = name || inside.text;
      if (content) push(depth, `heading${typeof level === 'number' ? ` h${level}` : ''} ${quoted(content)}`);
      // A heading that holds a link keeps its ref.
      if (inside.acts) for (const child of children) visit(child, depth + 1, guard + 1);
      flush(depth + 1);
      return;
    }
    if (role === 'image' || role === 'img') {
      flush(depth);
      if (name) push(depth, `img ${quoted(name)}`);
      return;
    }
    if (role === 'row') {
      flush(depth);
      const cells = children.map((child) => plain(child));
      if (!cells.some((cell) => cell.acts)) {
        const row = cells
          .map((cell) => cell.text)
          .filter(Boolean)
          .join(' | ');
        if (row) push(depth, `row: ${tidy(row, TEXT_MAX)}`);
        return;
      }
      push(depth, 'row');
      for (const child of children) visit(child, depth + 1, guard + 1);
      flush(depth + 1);
      return;
    }
    if (CONTAINERS.has(role) || (NAMED_CONTAINERS.has(role) && name)) {
      flush(depth);
      push(depth, `${role}${name ? ` ${quoted(name)}` : ''}`);
      for (const child of children) visit(child, depth + 1, guard + 1);
      flush(depth + 1);
      return;
    }
    if (BLOCKS.has(role)) flush(depth);
    for (const child of children) visit(child, depth, guard + 1);
    if (BLOCKS.has(role)) flush(depth);
  };

  if (root) visit(root.nodeId, 0, 0);
  flush(0);
  return { lines, refs };
}

/** A window of lines within `maxChars`, from `fromLine` (1-based), and where the next one starts. */
export function windowOf(
  lines: readonly string[],
  fromLine: number,
  maxChars: number,
): { text: string; first: number; last: number; total: number; next: number | null } {
  const start = Math.min(Math.max(fromLine, 1), Math.max(lines.length, 1)) - 1;
  const out: string[] = [];
  let size = 0;
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (out.length && size + line.length + 1 > maxChars) break;
    out.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
    size += line.length + 1;
  }
  return {
    text: out.join('\n'),
    first: start + 1,
    last: index,
    total: lines.length,
    next: index < lines.length ? index + 1 : null,
  };
}

/** Visible text in short form: no runs of spaces or blank lines. */
export function compactText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line || (index > 0 && all[index - 1]))
    .join('\n')
    .trim();
}

/** Replaces every occurrence of these values; the longest first, so none survives in part. */
export function redactor(values: readonly string[]): (text: string) => string {
  const sorted = [...new Set(values.filter((value) => value.length >= 4))].sort((a, b) => b.length - a.length);
  if (!sorted.length) return (text) => text;
  return (text) => {
    let out = text;
    for (const value of sorted) if (out.includes(value)) out = out.split(value).join('[hidden]');
    return out;
  };
}
