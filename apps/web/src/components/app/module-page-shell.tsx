/**
 * Shared shell primitives for second-level module pages.
 *
 * Used by Settings / Administration / CRM to keep full-height layout,
 * mobile module tabs, and cached module panes consistent.
 */

import React from 'react';
import { localizeNavModule, type NavModule } from '../../lib/nav-registry';
import { useT } from '../../lib/i18n';

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function defaultModuleKey(mod: NavModule) {
  return mod.id.split('.').pop()!;
}

function defaultNavigate(mod: NavModule) {
  window.location.hash = mod.path;
}

interface MobileModuleTabsProps {
  activeKey: string;
  items?: NavModule[];
  getItemKey?: (mod: NavModule) => string;
  onNavigate?: (mod: NavModule) => void;
  className?: string;
}

function mobileTabClasses(active: boolean) {
  return joinClasses(
    'flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs whitespace-nowrap transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40',
    active
      ? 'bg-primary-subtle text-primary-fg-strong font-medium border-primary-edge'
      : 'text-fg-muted hover:text-fg-secondary border-transparent',
  );
}

function MobileModuleTab({
  mod,
  active,
  onNavigate,
}: {
  mod: NavModule;
  active: boolean;
  onNavigate: (mod: NavModule) => void;
}) {
  const t = useT();
  const localized = localizeNavModule(mod, t);
  const Icon = localized.icon;
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    const button = buttonRef.current;
    if (!active || !button || button.offsetParent === null) return;
    button.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => onNavigate(mod)}
      className={mobileTabClasses(active)}
    >
      <Icon size={13} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
      {localized.label}
    </button>
  );
}

export function MobileModuleTabs({
  activeKey,
  items = [],
  getItemKey = defaultModuleKey,
  onNavigate = defaultNavigate,
  className,
}: MobileModuleTabsProps) {
  if (items.length === 0) return null;

  return (
    <div
      className={joinClasses(
        'md:hidden flex items-center gap-1.5 px-3 py-2 border-b border-edge bg-surface-raised overflow-x-auto scrollbar-hide flex-shrink-0',
        className,
      )}
    >
      {items.map((mod) => (
        <MobileModuleTab key={mod.id} mod={mod} active={activeKey === getItemKey(mod)} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

interface ModulePageShellProps {
  activeKey: string;
  mobileItems?: NavModule[];
  getMobileItemKey?: (mod: NavModule) => string;
  onMobileNavigate?: (mod: NavModule) => void;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

export function ModulePageShell({
  activeKey,
  mobileItems,
  getMobileItemKey,
  onMobileNavigate,
  className,
  contentClassName,
  children,
}: ModulePageShellProps) {
  return (
    <div className={joinClasses('h-full flex flex-col overflow-hidden', className)}>
      <MobileModuleTabs
        activeKey={activeKey}
        items={mobileItems}
        getItemKey={getMobileItemKey}
        onNavigate={onMobileNavigate}
      />
      <main className={joinClasses('flex-1 overflow-hidden relative', contentClassName)}>{children}</main>
    </div>
  );
}

/**
 * Renders children only after first visit, then keeps them mounted but hidden.
 * This preserves component state (scroll position, form inputs, etc.) across module switches.
 */
export function CachedModule({
  active,
  visited,
  children,
}: {
  active: boolean;
  visited: boolean;
  children: React.ReactNode;
}) {
  if (!visited) return null;
  return <div className={joinClasses('h-full', !active && 'hidden')}>{children}</div>;
}
