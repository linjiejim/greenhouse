import type { ReactNode } from 'react';

/**
 * The quiet label between groups of one contextual sidebar list — the conversations
 * sidebar's Agents / People / Chats / Background (spec 20261011-agent-first-class §3.1).
 * Same type ramp as the chats' date buckets, so the whole list reads as one.
 */
export function SidebarSectionLabel({
  children,
  testId,
  actions,
}: {
  children: ReactNode;
  testId?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1 pl-3 pr-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-faint"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {actions && <div className="flex shrink-0 items-center gap-0.5 normal-case tracking-normal">{actions}</div>}
    </div>
  );
}
