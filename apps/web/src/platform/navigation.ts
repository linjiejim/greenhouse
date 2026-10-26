/** Shared desktop/mobile primary navigation composition. */

import { FolderOpen, Package, Zap, type LucideIcon } from '../lib/icons';
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
  files: string;
  skillhub: string;
  automations: string;
  /** Localized names of the built-in applications by id; the catalog's `title` is English metadata. */
  applications?: Record<string, string>;
}

interface BuildPrimaryNavigationArgs {
  applications: readonly PlatformApplication[];
  labels: PrimaryNavigationLabels;
}

/**
 * The workspace, ordered by what the team comes for (v1.5, "navigation by
 * goal"): Knowledge · Files · Tables · Projects · SkillHub · Automations. Home
 * is the conversation itself (3.0): New Chat and the logo open it, and its
 * history shows under the list.
 *
 * Knowledge, Tables and Projects are applications: each appears only when the
 * server-filtered catalog authorizes it and it has a host route.
 */
export const PRIMARY_NAV_ORDER = ['knowledge', 'files', 'skillhub', 'automations'] as const;

const APPLICATION_SLOTS = new Set<string>(['knowledge']);

export function buildPrimaryNavigation({ applications, labels }: BuildPrimaryNavigationArgs): PrimaryNavigation {
  const applicationItems = applications.flatMap((application) => {
    const href = platformApplicationHref(application);
    return href
      ? [
          {
            key: application.id,
            label: labels.applications?.[application.id] ?? application.title,
            icon: platformApplicationIcon(application),
            href,
          },
        ]
      : [];
  });
  const applicationItemById = new Map(applicationItems.map((item) => [item.key, item]));

  const fixed: Record<string, PrimaryNavigationItem> = {
    files: { key: 'files', label: labels.files, icon: FolderOpen, href: '#/files' },
    skillhub: { key: 'skillhub', label: labels.skillhub, icon: Package, href: '#/skillhub' },
    automations: { key: 'automations', label: labels.automations, icon: Zap, href: '#/automations' },
  };

  const primary = PRIMARY_NAV_ORDER.flatMap((key) => {
    const item = APPLICATION_SLOTS.has(key) ? applicationItemById.get(key) : fixed[key];
    return item ? [item] : [];
  });

  // Registered application pages sit before the shared prompt library.
  const contributed = applicationItems.filter((item) => !APPLICATION_SLOTS.has(item.key));
  primary.splice(
    primary.findIndex((item) => item.key === 'skillhub'),
    0,
    ...contributed,
  );
  const overflow: PrimaryNavigationItem[] = [];

  return { primary, overflow };
}

/**
 * The navigation item the current page belongs to, or null when the page has
 * no home in the navigation (the Activity log is reached from the account menu
 * and Administration; Settings, Administration and the design page are their
 * own workspaces; Home and a conversation are reached from New Chat, not the list). Read from the canonical route only — the query (`?tab=…`)
 * picks a tab inside the page, never a different item — so a retired hash that
 * redirected (`#/agents` → `#/automations?tab=profiles`) highlights where it
 * landed.
 */
export function activeNavigationKey(route: string): string | null {
  if (isConversationRoute(route)) return null;
  if (route === 'activity' || route === 'settings' || route === 'administration' || route === 'design') return null;
  if (route === 'extension') return null;
  return route;
}

/** Home and `#/chat` are the same screen: a conversation (Home is a new one). */
export function isConversationRoute(route: string): boolean {
  return route === 'chat' || route === 'home';
}
