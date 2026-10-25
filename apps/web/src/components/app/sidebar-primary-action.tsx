import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from '../../lib/icons';

interface SidebarPrimaryActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  children: ReactNode;
}

/**
 * Create action shared by contextual application sidebars (New Chat). A secondary control — a
 * raised neutral row with an accent icon — so the sidebar's one solid accent is not a big block.
 */
export function SidebarPrimaryAction({ icon: Icon, children, className = '', ...props }: SidebarPrimaryActionProps) {
  return (
    <button
      type="button"
      className={`flex w-full items-center justify-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-1.5 text-sm font-medium text-fg shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-muted ${className}`}
      {...props}
    >
      <Icon size={15} className="text-primary-fg" aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}
