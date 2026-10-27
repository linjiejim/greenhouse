/** Layout widths are CSS pixels and shared with the browser's regression tests. */
export const RAIL_WIDTH = 72;
export const SECONDARY_WIDTH = 264;
export const INSPECTOR_WIDTH = 400;
export const INSPECTOR_MIN = 360;
export const INSPECTOR_MAX = 520;
/** Breakpoints: wide shell from WIDE_MIN, secondary column from SECONDARY_MIN, docked inspector from DOCK_MIN. */
export const WIDE_MIN = 760;
export const SECONDARY_MIN = 1100;
export const DOCK_MIN = 1440;
export function wideLayout(width: number) {
  return { wide: width >= WIDE_MIN, collapseSecondary: width < SECONDARY_MIN, floatInspector: width < DOCK_MIN };
}
/** Sidebar dates: compact recent ages, weekday within a week, then month/day. */
export function conversationAge(iso: string, now: number, lang: 'zh' | 'en'): string {
  const date = new Date(iso),
    diff = Math.max(0, now - date.getTime());
  if (!Number.isFinite(diff)) return '';
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 172800000) return '1d';
  if (diff < 604800000)
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' }).format(date);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
