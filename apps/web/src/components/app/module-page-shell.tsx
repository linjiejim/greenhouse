/**
 * Shared shell primitives for second-level module pages.
 *
 * Used by Dashboard / Settings to keep full-height layout,
 * mobile module tabs, and cached module panes consistent.
 */

import React from 'react';
import { ChevronDown } from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import type { NavModule } from '../../lib/nav-registry';

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function defaultModuleKey(mod: NavModule) {
  return mod.id.split('.').pop()!;
}

function defaultNavigate(mod: NavModule) {
  window.location.hash = mod.path;
}

interface MobileModuleTabGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  items: NavModule[];
  getItemKey?: (mod: NavModule) => string;
  onNavigate?: (mod: NavModule) => void;
}

interface MobileModuleTabsProps {
  activeKey: string;
  items?: NavModule[];
  groups?: MobileModuleTabGroup[];
  getItemKey?: (mod: NavModule) => string;
  onNavigate?: (mod: NavModule) => void;
  className?: string;
}

function mobileTabClasses(active: boolean) {
  return joinClasses(
    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors border',
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
  const Icon = mod.icon;
  return (
    <button type="button" onClick={() => onNavigate(mod)} className={mobileTabClasses(active)}>
      <Icon size={13} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
      {mod.label}
    </button>
  );
}

export function MobileModuleTabs({
  activeKey,
  items = [],
  groups = [],
  getItemKey = defaultModuleKey,
  onNavigate = defaultNavigate,
  className,
}: MobileModuleTabsProps) {
  if (items.length === 0 && groups.every((group) => group.items.length === 0)) return null;

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

      {groups.map((group) => {
        if (group.items.length === 0) return null;
        const GroupIcon = group.icon;
        const navigateGroupItem = group.onNavigate || onNavigate;
        const getGroupItemKey = group.getItemKey || getItemKey;

        return (
          <React.Fragment key={group.key}>
            <button type="button" onClick={group.onToggle} className={mobileTabClasses(group.active)}>
              <GroupIcon size={13} className={group.active ? 'text-primary-fg' : 'text-fg-faint'} />
              {group.label}
              <ChevronDown
                size={10}
                className={joinClasses('transition-transform duration-200', group.collapsed && '-rotate-90')}
              />
            </button>

            {!group.collapsed &&
              group.items.map((mod) => (
                <MobileModuleTab
                  key={mod.id}
                  mod={mod}
                  active={activeKey === getGroupItemKey(mod)}
                  onNavigate={navigateGroupItem}
                />
              ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface ModulePageShellProps {
  activeKey: string;
  mobileItems?: NavModule[];
  mobileGroups?: MobileModuleTabGroup[];
  getMobileItemKey?: (mod: NavModule) => string;
  onMobileNavigate?: (mod: NavModule) => void;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

export function ModulePageShell({
  activeKey,
  mobileItems,
  mobileGroups,
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
        groups={mobileGroups}
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
