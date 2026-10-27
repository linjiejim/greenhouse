import React, { useState } from 'react';
import { Overlay } from './overlay.web';
import { Icon } from './core.web';
import type { MenuItem } from './menu-items';
export { menuSections, type MenuItem } from './menu-items';
export function NativeMenu({
  items,
  onSelect,
  title,
  trigger = 'tap',
  fill,
  width,
  children,
  style,
  testID,
}: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  title?: string;
  trigger?: 'tap' | 'longPress';
  fill?: boolean;
  width?: number;
  children: React.ReactNode;
  style?: any;
  testID?: string;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPoint({
      x: trigger === 'longPress' ? e.clientX : rect.left,
      y: trigger === 'longPress' ? e.clientY : rect.bottom + 4,
    });
  };
  return (
    <div
      data-testid={testID}
      tabIndex={trigger === 'tap' ? 0 : undefined}
      aria-haspopup="menu"
      onKeyDown={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        if ((trigger === 'tap' && (e.key === 'Enter' || e.key === ' ')) || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.left, y: rect.bottom + 4 });
        }
      }}
      style={{ display: fill || trigger === 'longPress' ? 'block' : 'inline-flex', width, ...style }}
      // RN Pressable stops click bubbling. Capture the trigger instead; portal
      // events must never reopen the menu after an item closes it.
      onClickCapture={
        trigger === 'tap'
          ? (e) => {
              if (!point) open(e);
            }
          : undefined
      }
      onContextMenu={trigger === 'longPress' ? open : undefined}
    >
      {children}
      {point ? <MenuPanel items={items} title={title} point={point} onSelect={onSelect} close={() => setPoint(null)} /> : null}
    </div>
  );
}
/** The one menu surface (dropdowns and context menus alike): rows with icon, title, check and shortcut. */
export function MenuPanel({
  items,
  title,
  point,
  onSelect,
  close,
}: {
  items: MenuItem[];
  title?: string;
  point: { x: number; y: number };
  onSelect: (id: string) => void;
  close: () => void;
}) {
  const rows = (entries: MenuItem[]): React.ReactNode =>
    entries.map((item) =>
      item.children ? (
        item.inline ? (
          <div key={item.id} className="gh-menu-section">
            {item.title ? <div className="gh-menu-title">{item.title}</div> : null}
            {rows(item.children)}
          </div>
        ) : (
          <details key={item.id} className="gh-menu-sub">
            <summary tabIndex={0}>{item.title}</summary>
            {rows(item.children)}
          </details>
        )
      ) : (
        <button
          key={item.id}
          role="menuitem"
          className="gh-menu-item"
          data-destructive={item.destructive || undefined}
          disabled={item.disabled}
          onClick={() => {
            close();
            onSelect(item.id);
          }}
        >
          {item.icon ? <Icon name={item.icon} size={16} /> : null}
          <span>{item.title}</span>
          {item.checked ? <Icon name="check" size={14} /> : null}
          {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
        </button>
      ),
    );
  return (
    <Overlay role="menu" label={title} point={point} modal={false} onClose={close}>
      {title ? <div className="gh-menu-title">{title}</div> : null}
      {rows(items)}
    </Overlay>
  );
}
export const Menu = NativeMenu;
export function ContextMenu(props: Omit<React.ComponentProps<typeof NativeMenu>, 'trigger'>) {
  return <NativeMenu {...props} trigger="longPress" />;
}
export function MenuHost() {
  return null;
}
