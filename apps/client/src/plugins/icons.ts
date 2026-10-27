/**
 * App (plugin) icons. A manifest names a lucide icon (`BookOpen`, `book-open`); the client draws its own
 * semantic icon set (SF Symbols / Material / lucide on web), so names map through this table. Official
 * native screens keep the icon their client glue declares. Anything unknown is the generic app tile.
 */
import type { IconName } from '../ui/core';
import type { PluginPage } from '../shared/plugins';
import { nativeScreens } from './native-registry';

const LUCIDE: Record<string, IconName> = {
  activity: 'runs',
  alarmclock: 'clock',
  apartment: 'building',
  archive: 'archive',
  atsign: 'at',
  barchart: 'bar',
  barchart2: 'bar',
  barchart3: 'bar',
  bell: 'bell',
  book: 'book',
  bookopen: 'book',
  bot: 'sparkle',
  box: 'box',
  brain: 'brain',
  briefcase: 'box',
  building: 'building',
  building2: 'building',
  calendar: 'calendar',
  calendardays: 'calendar',
  chartbar: 'bar',
  chartcolumn: 'bar',
  chartpie: 'chart',
  checksquare: 'checklist',
  clipboardlist: 'form',
  clock: 'clock',
  code: 'code',
  database: 'server',
  filetext: 'file',
  file: 'fileOther',
  folder: 'folder',
  folderkanban: 'checklist',
  globe: 'globe',
  inbox: 'mail',
  kanban: 'checklist',
  kanbansquare: 'checklist',
  key: 'key',
  layoutgrid: 'apps',
  link: 'link',
  listchecks: 'checklist',
  listtodo: 'checklist',
  mail: 'mail',
  messagecircle: 'msg',
  messagesquare: 'comment',
  messagessquare: 'msgs',
  monitor: 'computer',
  network: 'diagram',
  notebook: 'note',
  package: 'box',
  piechart: 'chart',
  presentation: 'slides',
  server: 'server',
  settings: 'gear',
  shield: 'shieldCheck',
  shieldcheck: 'shieldCheck',
  shoppingbag: 'cart',
  shoppingcart: 'cart',
  sparkles: 'sparkle',
  stickynote: 'note',
  store: 'cart',
  table: 'table',
  table2: 'table',
  trendingup: 'chart',
  truck: 'box',
  user: 'person',
  users: 'users',
  wand: 'wand',
  wandsparkles: 'wand',
  wrench: 'wrench',
};

/** `BookOpen`, `book-open`, `book_open` → the semantic icon, or undefined. */
export function lucideIcon(name: string | undefined): IconName | undefined {
  if (!name) return undefined;
  return LUCIDE[name.replace(/[-_\s]/g, '').toLowerCase()];
}

/** The icon of one app entry: the manifest's, else the official screen's own, else the generic tile. */
export function pluginIcon(nav: { icon?: string }, page?: Pick<PluginPage, 'kind'> & { screen?: string }): IconName {
  const native = page?.kind === 'native' && page.screen ? nativeScreens[page.screen]?.icon : undefined;
  return lucideIcon(nav.icon) ?? native ?? 'apps';
}
