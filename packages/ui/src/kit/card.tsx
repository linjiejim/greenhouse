/**
 * The one card for what an Agent shows inside a reply (docs/design-system/conversation.md, 回复卡片):
 * results (records, tables, charts, files, media), process (tool calls, run steps) and decisions
 * (需要你). Title row 44: icon, bold title, "· meta", then the status badge at the far right.
 * Process cards fold and lead with a chevron. Actions sit bottom left, primary first.
 */

import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { icon, motion } from '../tokens/haven';
import { StatusBadge, type Tone } from './feedback';
import { cx } from './provider';

export function ChatCard({
  icon: glyph,
  title,
  meta,
  status,
  tone,
  attention = false,
  expandable = false,
  defaultOpen = false,
  footer,
  footerEnd = false,
  className,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  status?: string;
  tone?: Tone;
  /** A decision waiting for the user: a warning-tinted border and icon. */
  attention?: boolean;
  /** A process card: folds to its title row. */
  expandable?: boolean;
  defaultOpen?: boolean;
  footer?: ReactNode;
  /** Explicit end alignment for standalone previews; conversation cards use the default start alignment. */
  footerEnd?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const element = useRef<HTMLElement>(null);
  const previousHeight = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const card = element.current;
    if (!card) return;
    animation.current?.cancel();
    const next = card.getBoundingClientRect().height;
    const previous = previousHeight.current;
    previousHeight.current = next;
    if (
      previous === null ||
      previous === next ||
      !card.animate ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
      return;
    animation.current = card.animate(
      [
        { height: `${previous}px`, overflow: 'hidden' },
        { height: `${next}px`, overflow: 'hidden' },
      ],
      {
        duration: parseInt(motion.durationBase, 10),
        easing: motion.easeStandard,
      },
    );
    return () => animation.current?.cancel();
  }, [attention, open]);
  const heading = (
    <>
      {expandable ? (
        <ChevronRight
          size={icon.md}
          strokeWidth={icon.stroke}
          className={cx('gh-chat-card-chevron', open && 'is-open')}
        />
      ) : (
        glyph && <span className="gh-chat-card-icon">{glyph}</span>
      )}
      <span className="gh-chat-card-title">{title}</span>
      {meta && <span className="gh-chat-card-meta">{meta}</span>}
      <span className="gh-chat-card-spacer" />
      {status && <StatusBadge status={status} tone={tone} />}
    </>
  );
  return (
    <section ref={element} className={cx('gh-chat-card', attention && 'is-attention', className)}>
      {expandable ? (
        <button type="button" className="gh-chat-card-header" aria-expanded={open} onClick={() => setOpen(!open)}>
          {heading}
        </button>
      ) : (
        <header className="gh-chat-card-header">{heading}</header>
      )}
      {(!expandable || open) && Children.toArray(children).length > 0 && (
        <div className="gh-chat-card-body">{children}</div>
      )}
      {footer && <footer className={cx('gh-chat-card-footer', footerEnd && 'is-end')}>{footer}</footer>}
    </section>
  );
}
