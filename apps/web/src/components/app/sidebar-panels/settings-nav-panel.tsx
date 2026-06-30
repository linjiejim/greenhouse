/**
 * Settings nav panel — sidebar contextual panel for Settings tab.
 *
 * Sections (see `settingsSections` in nav-registry):
 * - Preferences (standalone, top — no header)
 * - Personal: Automation, My Prompts, My Agents
 * - Workspace: Groups, Cloud Email
 * - Administration (super only): Users, AI Gateway, MCP Access, System Agents, Agent Usages, Feature Requests
 * - Labs (super only, beta): Memory
 *
 * Module definitions sourced from unified nav-registry.
 */

import React, { useState } from 'react';
import { Pin, PinOff, LogOut } from '../../../lib/icons';
import { useAuthStore, usePinStore } from '../../../stores';
import { ConfirmDialog } from '../../ui';
import { useT } from '../../../lib/i18n';
import { ContextMenu, useContextMenu } from '../context-menu';
import { settingsSections } from '../../../lib/nav-registry';
import type { NavModule, SettingsNavSection } from '../../../lib/nav-registry';

// ─── Component ───────────────────────────────────────────

interface SettingsNavPanelProps {
  activeModule: string;
  collapsed?: boolean;
  onSignOut?: () => void;
}

export function SettingsNavPanel({ activeModule, collapsed, onSignOut }: SettingsNavPanelProps) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { pinItem, unpinItem, isPinned } = usePinStore();
  const { menu, openMenu, closeMenu } = useContextMenu();

  if (collapsed) return null;

  const canViewModule = (mod: NavModule) => !mod.requireRole || (mod.requireRole.includes('super') && isSuper);
  const canViewSection = (section: SettingsNavSection) =>
    !section.requireRole || (section.requireRole.includes('super') && isSuper);

  const navigate = (key: string) => {
    window.location.hash = `#/settings/${key}`;
  };

  const getShortKey = (mod: NavModule) => mod.id.split('.').pop()!;

  /** Build context menu items for a module */
  const buildPinMenuItems = (mod: NavModule) => {
    if (mod.pinnable === false) return [];
    const pinned = isPinned(mod.id);
    return [
      pinned
        ? { label: 'Unpin from Sidebar', icon: PinOff, onClick: () => unpinItem(mod.id) }
        : { label: 'Pin to Sidebar', icon: Pin, onClick: () => pinItem(mod.id) },
    ];
  };

  const renderItem = (mod: NavModule) => (
    <NavItem
      key={mod.id}
      mod={mod}
      isActive={activeModule === getShortKey(mod)}
      onClick={() => navigate(getShortKey(mod))}
      onContextMenu={(e) => {
        const items = buildPinMenuItems(mod);
        if (items.length > 0) openMenu(e, items);
      }}
    />
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-3 py-2 flex-shrink-0">
        <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Settings</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {settingsSections.filter(canViewSection).map((section, sectionIndex) => {
          const visibleItems = section.items.filter(canViewModule);

          // Skip empty sections entirely (e.g. all items role-gated out).
          if (visibleItems.length === 0) return null;

          return (
            <React.Fragment key={section.key}>
              {section.label && (
                <>
                  {sectionIndex > 0 && <div className="mx-1 my-1.5 border-t border-edge" />}
                  <div className="px-3 pt-1 pb-0.5">
                    <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
                      {section.label}
                    </span>
                  </div>
                </>
              )}

              {visibleItems.map(renderItem)}
            </React.Fragment>
          );
        })}
      </nav>

      {/* Logout — pinned to the bottom of the settings sidebar */}
      {onSignOut && (
        <div className="flex-shrink-0 border-t border-edge p-2">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs text-danger hover:bg-danger-subtle transition-colors"
          >
            <LogOut size={14} />
            <span className="flex-1 text-left font-medium">{t('app.logout')}</span>
          </button>
        </div>
      )}

      {/* Context menu portal */}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onSignOut?.();
        }}
        title={t('app.logoutTitle')}
        description={t('app.logoutDesc')}
        confirmLabel={t('app.logout')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ─── Shared nav item ─────────────────────────────────────

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
