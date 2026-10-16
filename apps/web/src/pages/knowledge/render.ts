/**
 * A doc's Markdown made safe to show outside the editor: the reading page, a version, comments.
 * md-html is the editor's own parser and passes raw HTML through (only ProseMirror's schema tames
 * it there), so everything read-only goes through DOMPurify here: no scripts, handlers, styles or
 * forms; links open only http(s), mailto and the app's own `#/` routes (members are mention
 * chips, never links); pictures come only from our file service or the web. The browser tests
 * open a hostile doc (e2e/knowledge.e2e.ts): DOMPurify needs a real DOM to be tested.
 *
 * Its own DOMPurify instance: the chat's renderer (conversation/Markdown.tsx) adds a global hook
 * that opens every link in a new tab, which would send `#/knowledge/…` links out of the app.
 */

import createDOMPurify from 'dompurify';
import { markdownToEditorHtml } from '@greenhouse/knowledge-editor/md-html';

/** Where a link may go: `app` stays in this tab (`#/` routes), `web` opens a new one, null is no link. */
export function linkKind(href: string | null | undefined): 'app' | 'web' | null {
  const target = (href ?? '').trim();
  if (target.startsWith('#/')) return 'app';
  if (/^(?:https?:\/\/|mailto:)/i.test(target)) return 'web';
  return null;
}

/** Pictures from our own file service (relative, signed for the reader) or the web. */
export const pictureAllowed = (src: string | null | undefined) =>
  /^(?:https?:\/\/|\/api\/files\/[A-Za-z0-9_]+\/content(?:\?|$))/i.test((src ?? '').trim());

let purifier: ReturnType<typeof createDOMPurify> | null = null;

function instance() {
  if (purifier) return purifier;
  const next = createDOMPurify(window);
  next.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const kind = linkKind(node.getAttribute('href'));
      node.removeAttribute('target');
      node.removeAttribute('rel');
      if (!kind) node.removeAttribute('href');
      if (kind === 'web') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (node.tagName === 'IMG') {
      if (!pictureAllowed(node.getAttribute('src'))) node.removeAttribute('src');
      node.removeAttribute('srcset');
      node.setAttribute('loading', 'lazy');
    }
  });
  purifier = next;
  return next;
}

/** A doc's (or a comment's) Markdown as HTML that is safe to put on the page. */
export function docHtml(markdown: string): string {
  return instance().sanitize(markdownToEditorHtml(markdown), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'button', 'select', 'option', 'iframe', 'object', 'embed'],
    // No classes or ids either: a doc must not dress up as the app (its overlays, its buttons).
    FORBID_ATTR: ['style', 'class', 'id'],
  });
}
