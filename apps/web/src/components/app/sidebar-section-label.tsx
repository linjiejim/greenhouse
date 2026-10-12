import type { ReactNode } from 'react';

/**
 * The quiet label between groups of one contextual sidebar list — the conversations
 * sidebar's Main thread / Agents / Chats / Background (spec 20261011-agent-first-class §3.1).
 * Same type ramp as the chats' date buckets, so the whole list reads as one.
 */
export function SidebarSectionLabel({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span
      className="block truncate px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-fg-faint"
      data-testid={testId}
    >
      {children}
    </span>
  );
}
