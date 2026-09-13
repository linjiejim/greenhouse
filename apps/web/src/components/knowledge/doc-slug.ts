/**
 * A knowledge doc's slug: how it is derived from the title, and when it is
 * allowed to follow the title.
 *
 * Leaf module (no imports) so the rules are unit-testable without dragging the
 * knowledge page in.
 */

/** Title → URL slug. CJK is kept: it survives round-trips and reads better than a hash. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

/**
 * The slug to use after the title changes.
 *
 * Two rules, both learned the hard way:
 *
 * - **A saved doc keeps its slug.** The slug is the document's link identity
 *   (`#/knowledge/internal/<space>/<slug>`, copied links, `[[refs]]`); renaming
 *   the title must not silently repoint every link to it.
 * - **A new doc's slug follows the title until someone edits it by hand.** The
 *   old rule was `slug || slugify(title)`, which froze at the FIRST keystroke:
 *   after typing "H" the slug was `h` and truthy, so nothing after it ever
 *   reached the slug and new docs were saved with one-character permalinks.
 */
export function nextSlug(editor: { id?: number; title: string; slug: string }, nextTitle: string): string {
  if (editor.id) return editor.slug;
  const handEdited = editor.slug !== '' && editor.slug !== slugify(editor.title);
  return handEdited ? editor.slug : slugify(nextTitle);
}
