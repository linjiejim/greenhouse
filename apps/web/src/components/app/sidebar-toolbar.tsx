import React from 'react';
import type { LucideIcon } from '../../lib/icons';
import { MoreHorizontal } from '../../lib/icons';
import { IconButton, SearchInput } from '../ui';
import { ContextMenu, useContextMenu } from './context-menu';
import { useT } from '../../lib/i18n';

export interface SidebarToolbarAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}

interface SidebarToolbarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  actions?: SidebarToolbarAction[];
}

/**
 * Search + contextual actions for a resizable app sidebar.
 *
 * The app-sidebar container query keeps full action buttons at comfortable
 * widths and collapses them into one labelled menu at 219px and below.
 */
export function SidebarToolbar({ value, onChange, placeholder, actions = [] }: SidebarToolbarProps) {
  const t = useT();
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [searchFocused, setSearchFocused] = React.useState(false);

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <SearchInput
          value={value}
          onChange={onChange}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder={placeholder}
          size="sm"
          className="min-w-0 basis-0 flex-1 transition-[flex-basis,width] duration-200"
        />
        {actions.length > 0 && (
          <div
            className={`flex flex-shrink-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-200 ${
              searchFocused ? 'pointer-events-none max-w-0 translate-x-2 opacity-0' : 'max-w-32 opacity-100'
            }`}
            aria-hidden={searchFocused}
          >
            <div className="sidebar-actions-expanded flex-shrink-0 items-center gap-0.5">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <IconButton
                    key={action.label}
                    label={action.label}
                    size="compact"
                    onClick={action.onClick}
                    tabIndex={searchFocused ? -1 : 0}
                  >
                    <Icon size={13} />
                  </IconButton>
                );
              })}
            </div>
            <div className="sidebar-actions-compact flex-shrink-0">
              <IconButton
                label={t('navigation.more')}
                size="compact"
                aria-haspopup="menu"
                aria-expanded={menu != null}
                tabIndex={searchFocused ? -1 : 0}
                onClick={(event) => openMenu(event, actions)}
              >
                <MoreHorizontal size={15} />
              </IconButton>
            </div>
          </div>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </>
  );
}
