/**
 * Administration nav panel — sidebar contextual panel for the (super-only)
 * Administration surface.
 *
 * Mirrors {@link SettingsNavPanel} but lists the global management modules
 * (Users, Agent Usages, Feature Requests, Evaluation, AI Gateway,
 * MCP Access). Settings is user-scoped; Administration is global.
 */

import React from 'react';
import { Pin, PinOff } from '../../../lib/icons';
import { useAuthStore, usePinStore } from '../../../stores';
import { ContextMenu, useContextMenu } from '../context-menu';
import { administrationModules, localizeNavModule } from '../../../lib/nav-registry';
import { canUseFeature } from '../../../lib/features';
import type { NavModule } from '../../../lib/nav-registry';
import { useT } from '../../../lib/i18n';

interface AdministrationNavPanelProps {
  activeModule: string;
  collapsed?: boolean;
}

export function AdministrationNavPanel({ activeModule, collapsed }: AdministrationNavPanelProps) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const { pinItem, unpinItem, isPinned } = usePinStore();
  const { menu, openMenu, closeMenu } = useContextMenu();

  if (collapsed) return null;

  const canViewModule = (mod: NavModule) => {
    const roleAllowed = !mod.requireRole || (mod.requireRole.includes('super') && isSuper);
    const featureAllowed = !mod.requireFeature || canUseFeature(currentUser, mod.requireFeature);
    return roleAllowed && featureAllowed;
  };

  const navigate = (key: string) => {
    window.location.hash = `#/administration/${key}`;
  };

  const getShortKey = (mod: NavModule) => mod.id.split('.').pop()!;

  const buildPinMenuItems = (mod: NavModule) => {
    if (mod.pinnable === false) return [];
    const pinned = isPinned(mod.id);
    return [
      pinned
        ? { label: t('sessionGroups.unpin'), icon: PinOff, onClick: () => unpinItem(mod.id) }
        : { label: t('sessionGroups.pin'), icon: Pin, onClick: () => pinItem(mod.id) },
    ];
  };

  const visibleItems = administrationModules.filter(canViewModule);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2 flex-shrink-0">
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">{t('app.administration')}</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {visibleItems.map((mod) => (
          <NavItem
            key={mod.id}
            mod={localizeNavModule(mod, t)}
            isActive={activeModule === getShortKey(mod)}
            onClick={() => navigate(getShortKey(mod))}
            onContextMenu={(e) => {
              const items = buildPinMenuItems(mod);
              if (items.length > 0) openMenu(e, items);
            }}
          />
        ))}
      </nav>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </div>
  );
}

function NavItem({
  mod,
  isActive,
  onClick,
  onContextMenu,
}: {
  mod: NavModule;
  isActive: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const Icon = mod.icon;
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs transition-colors ${
        isActive
          ? 'bg-primary-subtle text-primary-fg-strong font-medium'
          : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
      }`}
    >
      <Icon size={14} className={isActive ? 'text-primary-fg' : 'text-fg-faint'} />
      <span className="flex-1 text-left">{mod.label}</span>
    </button>
  );
}
