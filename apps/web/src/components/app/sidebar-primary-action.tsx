import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from '../../lib/icons';

interface SidebarPrimaryActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  children: ReactNode;
}

/** Primary create action shared by contextual application sidebars. */
export function SidebarPrimaryAction({ icon: Icon, children, className = '', ...props }: SidebarPrimaryActionProps) {
  return (
    <button
      type="button"
      className={`flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-600 ${className}`}
      {...props}
    >
      <Icon size={14} />
      <span>{children}</span>
    </button>
  );
}
