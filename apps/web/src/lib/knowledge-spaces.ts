/**
 * KB "spaces" (team knowledge-base categories) — pure grouping helpers.
 *
 * A space is not a first-class entity: it's the `/`-delimited `meta.space` path
 * carried by each team doc (e.g. `eng/backend`). These helpers turn a flat doc
 * list into the nested tree the nav renders, and answer "is this doc under that
 * space subtree?" for list filtering. Kept side-effect-free so they can be unit
 * tested without the DOM.
 */

export interface SpaceNode {
  /** Last path segment — the label shown in the tree. */
  name: string;
  /** Full canonical path, e.g. `eng/backend`. */
  path: string;
  /** Docs whose space is exactly this path (excludes descendants). */
  count: number;
  /** Docs in this space plus every descendant space. */
  total: number;
  children: SpaceNode[];
}

/**
 * Canonicalize a space path: trim each `/`-segment, drop empties (so `//` and
 * stray slashes collapse), fall back to `general`. Mirrors the server-side
 * normalizer so client grouping matches what's stored.
 */
export function normalizeSpacePath(raw: string | null | undefined): string {
  return (
    (raw ?? '')
      .split('/')
      .map((seg) => seg.trim())
      .filter(Boolean)
      .join('/') || 'general'
  );
}

/**
 * Group docs into a nested space tree. Every path prefix becomes a node, so a
 * lone `eng/backend` doc still materializes an `eng` parent. `count` is direct
 * docs; `total` includes descendants. Siblings sort alphabetically.
 */
export function buildSpaceTree(docs: Array<{ space?: string | null }>): SpaceNode[] {
  const roots: SpaceNode[] = [];
  const byPath = new Map<string, SpaceNode>();

  const ensure = (segments: string[]): SpaceNode => {
    let siblings = roots;
    let acc = '';
    let node: SpaceNode | undefined;
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      node = byPath.get(acc);
      if (!node) {
        node = { name: seg, path: acc, count: 0, total: 0, children: [] };
        byPath.set(acc, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    return node!;
  };

  for (const doc of docs) {
    const node = ensure(normalizeSpacePath(doc.space).split('/'));
    node.count += 1;
  }

  // Post-order pass: sort siblings and roll descendant counts up into `total`.
  const finalize = (nodes: SpaceNode[]): number => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    let sum = 0;
    for (const n of nodes) {
      n.total = n.count + finalize(n.children);
      sum += n.total;
    }
    return sum;
  };
  finalize(roots);

  return roots;
}

/**
 * True when `docSpace` is the selected space or any space nested beneath it —
 * used to show a whole category subtree when a parent node is opened. Callers
 * must guard against an empty `root` (that means "all spaces", not a filter).
 */
export function isSpaceInSubtree(docSpace: string | null | undefined, root: string): boolean {
  const doc = normalizeSpacePath(docSpace);
  const sel = normalizeSpacePath(root);
  return doc === sel || doc.startsWith(sel + '/');
}
