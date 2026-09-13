import React from 'react';

export type RichBlockTone = 'default' | 'accent' | 'muted';

interface RichBlockShellProps {
  children: React.ReactNode;
  compact?: boolean;
  header?: React.ReactNode;
  tone?: RichBlockTone;
  className?: string;
}

const TONE_STYLES: Record<RichBlockTone, string> = {
  default: 'border-edge bg-surface-card',
  accent: 'border-primary-edge bg-primary-subtle/30',
  muted: 'border-edge bg-surface-sunken',
};

/**
 * Shared visual frame for blocks embedded by <RichMarkdown>.
 *
 * Spacing between blocks belongs to the RichMarkdown parent; this shell owns
 * only the block surface, header density, and semantic tone.
 */
export function RichBlockShell({
  children,
  compact = false,
  header,
  tone = 'default',
  className = '',
}: RichBlockShellProps) {
  return (
    <section
      data-rich-block-density={compact ? 'compact' : 'base'}
      className={`rich-block overflow-hidden rounded-lg border ${TONE_STYLES[tone]} ${className}`}
    >
      {header && (
        <div className={`border-b border-edge bg-surface-sunken ${compact ? 'px-3 py-1.5' : 'px-3 py-2'}`}>
          {header}
        </div>
      )}
      {children}
    </section>
  );
}

export function richBlockBodyClass(compact = false): string {
  return compact ? 'px-3 py-2.5' : 'px-4 py-3';
}
