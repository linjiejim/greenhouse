/**
 * An app's tile: its icon on its accent. Used by the app center, the sidebar's
 * Apps section and the app pages, so an app looks the same everywhere.
 */

import { appIcon } from '../../lib/icons';
import { appAccentClasses } from './app-accent';

const SIZES = {
  xs: { box: 'h-5 w-5 rounded-md', icon: 12 },
  sm: { box: 'h-7 w-7 rounded-lg', icon: 14 },
  md: { box: 'h-9 w-9 rounded-lg', icon: 18 },
  lg: { box: 'h-12 w-12 rounded-xl', icon: 22 },
} as const;

export function AppBadge({
  icon,
  accent,
  size = 'md',
  className = '',
}: {
  icon: string | null | undefined;
  accent: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = appIcon(icon);
  const { box, icon: iconSize } = SIZES[size];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-shrink-0 items-center justify-center ${box} ${appAccentClasses(accent)} ${className}`}
    >
      <Icon size={iconSize} />
    </span>
  );
}
