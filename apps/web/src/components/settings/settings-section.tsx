import React from 'react';
import type { LucideIcon } from '../../lib/icons';
import { Card } from '../ui';

export function SettingsPanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`w-full space-y-4 ${className}`}>{children}</div>;
}

export function SettingsSection({
  title,
  description,
  icon: Icon,
  action,
  children,
  accent = false,
  className = '',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <Card className={`overflow-hidden ${className}`}>
      {accent && <div className="brand-gradient h-1" aria-hidden="true" />}
      <section className="p-4">
        {(title || description || action) && (
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              {title && (
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  {Icon && <Icon size={14} className="flex-shrink-0 text-primary-fg" aria-hidden="true" />}
                  <span>{title}</span>
                </div>
              )}
              {description && <p className="mt-1 text-xs leading-5 text-fg-muted">{description}</p>}
            </div>
            {action && <div className="flex-shrink-0">{action}</div>}
          </div>
        )}
        {children}
      </section>
    </Card>
  );
}
