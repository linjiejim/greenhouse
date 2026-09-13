import React from 'react';
import { ChevronDown } from '../../lib/icons';
import { Spinner, Tag, type TagTone } from '../ui';

export interface ArtifactCardStatus {
  label: string;
  tone?: TagTone;
  busy?: boolean;
}

const FRAME_TONE = {
  neutral: 'border-edge',
  accent: 'border-primary-edge',
  success: 'border-success/35',
  danger: 'border-danger/35',
} as const;

export function ArtifactCard({
  icon,
  title,
  meta,
  status,
  children,
  footer,
  collapsed = false,
  onToggle,
  tone = 'neutral',
  className = '',
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  status?: ArtifactCardStatus;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  tone?: keyof typeof FRAME_TONE;
  className?: string;
}) {
  const headerContent = (
    <>
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-primary-fg">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-fg">{title}</span>
        {meta && <span className="block truncate text-[10px] text-fg-faint">{meta}</span>}
      </span>
      {status && (
        <Tag
          tone={status.tone ?? 'neutral'}
          size="xs"
          icon={status.busy ? <Spinner className="h-2.5 w-2.5" /> : undefined}
        >
          {status.label}
        </Tag>
      )}
      {onToggle && (
        <ChevronDown
          size={13}
          className={`flex-shrink-0 text-fg-faint transition-transform ${collapsed ? '' : 'rotate-180'}`}
        />
      )}
    </>
  );

  return (
    <section
      data-chat-artifact-card
      className={`overflow-hidden rounded-lg border bg-surface-canvas ${FRAME_TONE[tone]} ${className}`}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={`flex w-full items-center gap-2 bg-surface-muted px-3 py-2 text-left transition-colors hover:bg-surface-muted/70 ${
            collapsed ? '' : 'border-b border-edge'
          }`}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b border-edge bg-surface-muted px-3 py-2">{headerContent}</div>
      )}
      {!collapsed && children && <div className="px-3 py-2.5">{children}</div>}
      {!collapsed && footer && <div className="border-t border-edge bg-surface-muted px-3 py-2">{footer}</div>}
    </section>
  );
}

export function ArtifactCardActions({ hint, children }: { hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {hint && <p className="min-w-0 flex-1 text-[10px] text-fg-faint">{hint}</p>}
      {children}
    </div>
  );
}
