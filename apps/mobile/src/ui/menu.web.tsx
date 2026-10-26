import React, { useState } from 'react';
import { Overlay } from './overlay.web';
import { Icon } from './core.web';
import { useTheme } from '../theme';
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
  const { hex: c } = useTheme();
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setPoint({
      x: trigger === 'longPress' ? e.clientX : rect.left,
      y: trigger === 'longPress' ? e.clientY : rect.bottom + 4,
    });
  };
  const rows = (entries: MenuItem[]): React.ReactNode =>
    entries.map((item) =>
      item.children ? (
        item.inline ? (
          <div key={item.id} style={{ borderTop: `1px solid ${c.separator}`, paddingBlock: 4 }}>
            {item.title ? <div style={{ padding: 8 }}>{item.title}</div> : null}
            {rows(item.children)}
          </div>
        ) : (
          <details key={item.id}>
            <summary tabIndex={0} style={{ padding: 8, cursor: 'pointer' }}>
              {item.title}
            </summary>
            {rows(item.children)}
          </details>
        )
      ) : (
        <button
          key={item.id}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            setPoint(null);
            onSelect(item.id);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            minHeight: 32,
            border: 0,
            borderRadius: 6,
            background: 'transparent',
            color: item.destructive ? c.red : c.label,
            padding: '4px 8px',
            textAlign: 'left',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          {item.icon ? <Icon name={item.icon} size={16} /> : null}
          <span style={{ flex: 1 }}>{item.title}</span>
          {item.checked ? '✓' : null}
          {item.shortcut ? <span style={{ color: c.secondaryLabel }}>{item.shortcut}</span> : null}
        </button>
      ),
    );
  return (
    <div
      data-testid={testID}
      tabIndex={trigger === 'tap' ? 0 : undefined}
      aria-haspopup="menu"
      onKeyDown={(e) => {
        if ((trigger === 'tap' && (e.key === 'Enter' || e.key === ' ')) || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setPoint({ x: rect.left, y: rect.bottom + 4 });
        }
      }}
      style={{ display: fill || trigger === 'longPress' ? 'block' : 'inline-flex', width, ...style }}
      onClick={trigger === 'tap' ? open : undefined}
      onContextMenu={trigger === 'longPress' ? open : undefined}
    >
      {children}
      {point ? (
        <Overlay role="menu" label={title} point={point} modal={false} onClose={() => setPoint(null)}>
          {title ? <div style={{ padding: 8, color: c.secondaryLabel }}>{title}</div> : null}
          {rows(items)}
        </Overlay>
      ) : null}
    </div>
  );
}
export const Menu = NativeMenu;
export function ContextMenu(props: Omit<React.ComponentProps<typeof NativeMenu>, 'trigger'>) {
  return <NativeMenu {...props} trigger="longPress" />;
}
export function MenuHost() {
  return null;
}
