/**
 * How an app looks on the phone: its catalog icon (`APP_ICONS`, a fixed list
 * every client draws) as one of the app's SF Symbols, and its accent (`APP_ACCENTS`)
 * as a tile colour. Accents are data colours chosen by the app's builder (like a
 * project's colour), the same in light and dark; `brand` is the app's own accent.
 */

import type { ColorValue } from 'react-native';
import type { AppAccent, AppIconName } from '../shared/apps';
import type { ThemeColors } from '../theme';
import type { IconName } from '../ui/core';

const ICON: Record<AppIconName, IconName> = {
  app: 'apps',
  inbox: 'tray',
  check: 'checkCircle',
  clipboard: 'form',
  cart: 'cart',
  users: 'users',
  briefcase: 'briefcase',
  calendar: 'calendar',
  chart: 'bar',
  table: 'table',
  kanban: 'board',
  ticket: 'ticket',
  wrench: 'wrench',
  book: 'book',
  star: 'star',
  flag: 'flag',
  home: 'house',
  settings: 'gear',
};

/** An app / page icon; an unknown name (a newer server) falls back to the app glyph. */
export function appIcon(name: string | undefined): IconName {
  return (name && ICON[name as AppIconName]) || 'apps';
}

const ACCENT_HEX: Record<Exclude<AppAccent, 'brand'>, string> = {
  blue: '#3B82F6',
  teal: '#14B8A6',
  amber: '#F59E0B',
  rose: '#F43F5E',
  violet: '#8B5CF6',
  slate: '#64748B',
};

/** The tile colour of an app (`IconTile tint`). */
export function appAccent(accent: string | undefined, c: ThemeColors): ColorValue {
  if (!accent || accent === 'brand') return c.accent;
  return ACCENT_HEX[accent as Exclude<AppAccent, 'brand'>] ?? c.accent;
}
