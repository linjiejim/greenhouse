import { Overlay } from './overlay.web';
/** Browser place chrome; domain reads and writes stay in existing APIs. */
import React from 'react';
import { Stack } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useWideShell } from '../shell/wide-shell.web';
import { useTheme, typo } from '../theme';
import { Icon, type IconName } from './core';
import { NativeMenu } from './menu.web';
import type { MenuItem } from './menu-items';
import { useT } from '../lib/i18n';
export function Place({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { hex: c } = useTheme();
  const { width } = useWindowDimensions();
  const shell = useWideShell();
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <div className="gh-place" style={{ color: c.label, background: c.background, fontSize: typo.body.fontSize }}>
        <header className="gh-place-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {width >= 760 && width < 1100 ? (
              <button aria-label={t('client.secondary')} onClick={shell.toggleSecondary}>
                <Icon name="menu" size={18} />
              </button>
            ) : null}
            <strong>{title}</strong>
          </div>
          <div className="gh-place-actions">{actions}</div>
        </header>
        {children}
      </div>
    </>
  );
}
export function PlaceSidebar({
  title,
  query,
  onQuery,
  action,
  children,
}: {
  title: string;
  query: string;
  onQuery: (q: string) => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { hex: c } = useTheme();
  const t = useT();
  return (
    <div className="gh-place-sidebar" style={{ color: c.label }}>
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      <label className="gh-place-search" style={{ background: c.tertiaryFill, color: c.secondaryLabel }}>
        <Icon name="search" size={16} />
        <input
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <small>⌘K</small>
      </label>
      {children}
    </div>
  );
}
export function PlaceRow({
  title,
  detail,
  icon = 'file',
  selected,
  onOpen,
  items = [],
  onSelect,
  children,
}: {
  title: string;
  detail?: string;
  icon?: IconName;
  selected?: boolean;
  onOpen: () => void;
  items?: MenuItem[];
  onSelect?: (id: string) => void;
  children?: React.ReactNode;
}) {
  const { hex: c } = useTheme();
  const row = (
    <button
      className="gh-place-row"
      data-place-row
      aria-current={selected ? 'page' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = Array.from(
            e.currentTarget.closest('[data-place-list]')?.querySelectorAll<HTMLButtonElement>('[data-place-row]') ?? [],
          );
          rows[(rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
        }
      }}
      style={{
        background: selected ? c.sidebarSelection : 'transparent',
        color: selected ? c.label : c.secondaryLabel,
      }}
    >
      <Icon name={icon} size={16} />
      <span>{title}</span>
      {detail ? <small>{detail}</small> : null}
      {children}
    </button>
  );
  return items.length ? (
    <NativeMenu trigger="longPress" fill items={items} onSelect={(id) => onSelect?.(id)}>
      <div className="gh-place-row-wrap">
        {row}
        <NativeMenu items={items} onSelect={(id) => onSelect?.(id)}>
          <button className="gh-place-row-more" aria-label={title + ' · ⋯'}>
            <Icon name="more" size={16} />
          </button>
        </NativeMenu>
      </div>
    </NativeMenu>
  ) : (
    row
  );
}
/**
 * Loading, failure and empty states of a place. With a `title` it is the "nothing here yet" state
 * (icon, title, one supporting line, the place's create action); without one it reads as an empty
 * search or filter result.
 */
export function PlaceEmpty({
  loading,
  error,
  retry,
  icon,
  title,
  message,
  action,
}: {
  loading?: boolean;
  error?: string | null;
  retry?: () => void;
  icon?: IconName;
  title?: string;
  message?: string;
  action?: React.ReactNode;
}) {
  const t = useT();
  if (loading || error || !title)
    return (
      <div className="gh-place-empty" role="status">
        {loading ? t('common.loading') : error || t('common.noMatches')}
        {error && retry ? <button onClick={retry}>{t('common.retry')}</button> : null}
      </div>
    );
  return (
    <div className="gh-place-empty gh-place-empty-rich" role="status">
      <span className="gh-place-empty-icon">
        <Icon name={icon ?? 'apps'} size={24} color="var(--gh-accent-text)" />
      </span>
      <strong>{title}</strong>
      {message ? <span>{message}</span> : null}
      {action}
    </div>
  );
}

export type PlaceContextPoint = { id: string; x: number; y: number };
export function PlaceContext({
  point,
  close,
  items,
}: {
  point: PlaceContextPoint | null;
  close: () => void;
  items: { label: string; run: () => void }[];
}) {
  if (!point) return null;
  return (
    <Overlay role="menu" modal={false} point={point} onClose={close}>
      {items.map((item, index) => (
        <button
          key={index}
          role="menuitem"
          className="gh-place-row"
          onClick={() => {
            close();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </Overlay>
  );
}
