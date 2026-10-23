/** Shared desktop/mobile primary navigation composition. */

import { FolderOpen, House, MessageCircle, Package, Zap, type LucideIcon } from '../lib/icons';
import { platformApplicationHref, platformApplicationIcon, type PlatformApplication } from './catalog';

export interface PrimaryNavigationItem {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Compact count for destinations requiring the current user's attention. */
  badge?: number;
}

/**
 * Split of the primary navigation into the always-visible sidebar destinations
 * and the lower-priority group collapsed under "More". Desktop opens More as a
 * rightward flyout; mobile renders the same group as a click-expanded section.
 */
export interface PrimaryNavigation {
  primary: PrimaryNavigationItem[];
  overflow: PrimaryNavigationItem[];
}

export interface PrimaryNavigationLabels {
  home: string;
  files: string;
  skillhub: string;
  automations: string;
  chat: string;
}

interface BuildPrimaryNavigationArgs {
  applications: readonly PlatformApplication[];
  labels: PrimaryNavigationLabels;
}

/**
 * The workspace, ordered by what the team comes for (v1.5, "navigation by
 * goal"): Home (team activity) · Knowledge · Files · Tables · Projects ·
 * SkillHub · Automations · Chat. The in-app assistant comes last on purpose —
 * members mostly reach Greenhouse through their own agents; Chat is a helper,
 * not the front door.
 *
 * Knowledge, Tables and Projects are applications: each appears only when the
 * server-filtered catalog authorizes it and it has a host route.
 */
export const PRIMARY_NAV_ORDER = [
  'home',
  'knowledge',
  'files',
  'tables',
  'projects',
  'skillhub',
  'automations',
  'chat',
] as const;

const APPLICATION_SLOTS = new Set<string>(['knowledge', 'tables', 'projects']);

export function buildPrimaryNavigation({ applications, labels }: BuildPrimaryNavigationArgs): PrimaryNavigation {
  const applicationItems = applications.flatMap((application) => {
    const href = platformApplicationHref(application);
    return href
      ? [
          {
            key: application.id,
            label: application.title,
            icon: platformApplicationIcon(application),
            href,
          },
        ]
      : [];
  });
  const applicationItemById = new Map(applicationItems.map((item) => [item.key, item]));

  const fixed: Record<string, PrimaryNavigationItem> = {
    home: { key: 'home', label: labels.home, icon: House, href: '#/home' },
    files: { key: 'files', label: labels.files, icon: FolderOpen, href: '#/files' },
    skillhub: { key: 'skillhub', label: labels.skillhub, icon: Package, href: '#/skillhub' },
    automations: { key: 'automations', label: labels.automations, icon: Zap, href: '#/automations' },
    chat: { key: 'chat', label: labels.chat, icon: MessageCircle, href: '#/chat' },
  };

  const primary = PRIMARY_NAV_ORDER.flatMap((key) => {
    const item = APPLICATION_SLOTS.has(key) ? applicationItemById.get(key) : fixed[key];
    return item ? [item] : [];
  });

  // Applications with a host route but no slot of their own wait under "More".
  const overflow = applicationItems.filter((item) => !APPLICATION_SLOTS.has(item.key));

  return { primary, overflow };
}
