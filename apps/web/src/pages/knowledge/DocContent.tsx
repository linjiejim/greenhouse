/**
 * A doc read on the page (KNOW-03, KNOW-15): its Markdown through the editor's own parser and the
 * sanitizer (render.ts), so it looks as it will in the editor, plus the contents built from its
 * headings.
 */

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import { icon } from '@greenhouse/ui/tokens';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { docHtml } from './render';

export interface Heading {
  index: number;
  level: number;
  text: string;
}

const HEADINGS = 'h1, h2, h3';

/** Scrolls the page to the nth heading of the doc on screen. */
export function goToHeading(container: HTMLElement | null, index: number) {
  const target = container?.querySelectorAll<HTMLElement>(HEADINGS)[index];
  if (!target) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

export const DocContent = memo(function DocContent({
  markdown,
  className,
  onHeadings,
  contentRef,
}: {
  markdown: string;
  className?: string;
  onHeadings?: (headings: Heading[]) => void;
  contentRef?: (element: HTMLDivElement | null) => void;
}) {
  const html = useMemo(() => docHtml(markdown), [markdown]);
  const own = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!onHeadings) return;
    const nodes = Array.from(own.current?.querySelectorAll<HTMLElement>(HEADINGS) ?? []);
    onHeadings(
      nodes.map((node, index) => ({
        index,
        level: Number(node.tagName.slice(1)),
        text: node.textContent?.trim() ?? '',
      })),
    );
  }, [html, onHeadings]);
  return (
    <div
      ref={(element) => {
        own.current = element;
        contentRef?.(element);
      }}
      className={cx('app-markdown app-doc-content', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/**
 * The contents of a long doc: beside it on wide screens, a list that opens above it elsewhere.
 * Two headings at least; each goes to its place in the doc.
 */
export function DocToc({
  headings,
  onGo,
  collapsible = false,
}: {
  headings: readonly Heading[];
  onGo: (index: number) => void;
  collapsible?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (headings.length < 2) return null;
  const top = Math.min(...headings.map((heading) => heading.level));
  const list = (
    <ul>
      {headings.map((heading) => (
        <li key={heading.index} style={{ paddingLeft: `calc(${heading.level - top} * var(--gh-space-3))` }}>
          <button type="button" onClick={() => onGo(heading.index)}>
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  );
  if (!collapsible) {
    return (
      <nav className="app-doc-toc" aria-label={t('knowledge.contents')}>
        <p className="app-doc-toc-title">{t('knowledge.contents')}</p>
        {list}
      </nav>
    );
  }
  return (
    <nav className="app-doc-toc is-inline" aria-label={t('knowledge.contents')}>
      <button type="button" className="app-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListTree size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
        {t('knowledge.contents')}
      </button>
      {open && list}
    </nav>
  );
}

/** Headings of the doc on screen, for the contents. */
export function useHeadings() {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const onHeadings = useCallback(
    (next: Heading[]) =>
      setHeadings((current) =>
        current.length === next.length &&
        current.every((item, index) => item.text === next[index]!.text && item.level === next[index]!.level)
          ? current
          : next,
      ),
    [],
  );
  return { headings, onHeadings };
}
