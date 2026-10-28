/**
 * The rail's "More" entry: every app that is not a built-in place, in a flyout beside the rail.
 * Hover opens it (and leaving both the entry and the flyout closes it after a short grace);
 * click or Enter toggles it for touch and keyboard; Escape or a click elsewhere closes it.
 * No backdrop, so moving the pointer back to the rail never lands on an invisible layer.
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';
import { typo, useTheme } from '../theme';
import { Icon, type IconName } from './core';
import { RailItem } from './rail-item.web';

export interface RailApp {
  id: string;
  label: string;
  icon: IconName;
  selected: boolean;
  open: () => void;
}

const GRACE_MS = 160;
const PANEL_WIDTH = 248;

export function RailMore({ label, title, apps, width }: { label: string; title: string; apps: RailApp[]; width: number }) {
  const { hex: c, isDark } = useTheme();
  const anchor = useRef<View>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const selected = apps.some((a) => a.selected);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    cancel();
    const box = (anchor.current as unknown as HTMLElement | null)?.getBoundingClientRect();
    if (box) setAt({ left: box.right + 4, top: box.top });
  };
  const hide = () => {
    cancel();
    timer.current = setTimeout(() => setAt(null), GRACE_MS);
  };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!at) return;
    const root = panel.current;
    // keep the whole panel on screen
    if (root) root.style.top = `${Math.max(8, Math.min(at.top, innerHeight - root.offsetHeight - 8))}px`;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setAt(null);
        (anchor.current as unknown as HTMLElement | null)?.querySelector<HTMLElement>('[role="button"]')?.focus();
      }
      if (['ArrowDown', 'ArrowUp'].includes(e.key) && root) {
        const items = Array.from(root.querySelectorAll<HTMLElement>('button'));
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    };
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!root?.contains(target) && !(anchor.current as unknown as HTMLElement | null)?.contains(target)) setAt(null);
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('mousedown', outside, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('mousedown', outside, true);
    };
  }, [at]);
  if (!apps.length) return null;
  return (
    <View ref={anchor} onPointerEnter={show} onPointerLeave={hide}>
      <RailItem
        id="more"
        label={label}
        icon="grid"
        selected={selected}
        expanded={!!at}
        width={width}
        onPress={() => {
          if (at) return setAt(null);
          show();
          // a click or Enter opens it for keyboard users too: focus the first app
          requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button')?.focus());
        }}
      />
      {at
        ? createPortal(
            <div
              ref={panel}
              role="menu"
              aria-label={title}
              data-testid="rail-more-menu"
              onPointerEnter={cancel}
              onPointerLeave={hide}
              style={{
                position: 'fixed',
                left: at.left,
                top: at.top,
                zIndex: 1000,
                width: PANEL_WIDTH,
                maxHeight: 'calc(100vh - 16px)',
                overflowY: 'auto',
                padding: 6,
                background: c.secondaryGroupedBackground,
                border: `1px solid ${c.separator}`,
                borderRadius: 12,
                boxShadow: isDark ? undefined : '0 8px 32px rgba(0,0,0,.14)',
                color: c.label,
                fontFamily: typo.body.fontFamily,
                colorScheme: isDark ? 'dark' : 'light',
              }}
            >
              <div className="gh-rail-more-title">{title}</div>
              {apps.map((app) => (
                <button
                  key={app.id}
                  role="menuitem"
                  data-testid={`rail-${app.id}`}
                  aria-current={app.selected ? 'page' : undefined}
                  className="gh-rail-more-item"
                  onClick={() => {
                    setAt(null);
                    app.open();
                  }}
                >
                  <Icon name={app.icon} size={18} color={app.selected ? c.accentText : c.secondaryLabel} />
                  <span>{app.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </View>
  );
}
