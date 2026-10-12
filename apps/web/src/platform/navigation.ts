/** Shared desktop/mobile primary navigation composition. */

import { LayoutGrid, MessageCircle, Package, type LucideIcon } from '../lib/icons';
import {
  PRIMARY_NAV_APPLICATION_IDS,
  platformApplicationHref,
  platformApplicationIcon,
  type PlatformApplication,
} from './catalog';

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

interface BuildPrimaryNavigationArgs {
  applications: readonly PlatformApplication[];
  chatLabel: string;
  skillhubLabel: string;
  /**
   * Agents' persistent threads, when the member has the `bots` feature (the
   * caller decides with `canUseFeature`; the API enforces it again). They live
   * under the one conversations entry (spec 20261011-agent-first-class §3.1):
   * the entry then opens the member's main thread (`#/bots`), and `badge` =
   * pending "needs you" requests — the one place a waiting Agent is visible
   * from every page.
   */
  bots?: { badge?: number } | null;
  /**
   * Apps — the ones members build on Tables (spec 20261011-tables-apps), when
   * the member has the `apps` feature. A host destination, not a catalog
   * application: apps are a module of the Tables manifest, and the people an
   * app is shared with need not have Tables at all. Sits right after Tables.
   */
  apps?: { label: string } | null;
}

export function buildPrimaryNavigation({
  applications,
  chatLabel,
  skillhubLabel,
  bots,
  apps,
}: BuildPrimaryNavigationArgs): PrimaryNavigation {
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
  const primaryApplicationIds = new Set<string>(PRIMARY_NAV_APPLICATION_IDS);
  const applicationItemById = new Map(applicationItems.map((item) => [item.key, item]));
  const primaryApplicationItems = PRIMARY_NAV_APPLICATION_IDS.flatMap((applicationId) => {
    const item = applicationItemById.get(applicationId);
    return item ? [item] : [];
  });
  const overflowApplicationItems = applicationItems.filter((item) => !primaryApplicationIds.has(item.key));
  if (apps) {
    // Right after Tables, or at the end of the primary apps for a member without Tables.
    const tablesIndex = primaryApplicationItems.findIndex((item) => item.key === 'tables');
    const at = tablesIndex >= 0 ? tablesIndex + 1 : primaryApplicationItems.length;
    primaryApplicationItems.splice(at, 0, { key: 'apps', label: apps.label, icon: LayoutGrid, href: '#/apps' });
  }

  // Visible sidebar order: conversations, then the authorized primary modules
  // (Knowledge, Projects, Tables) and Apps. SkillHub and secondary destinations collapse
  // into "More". Conversations lead because they are the home page. With
  // Agents' threads the one entry opens the main thread — the default place to
  // start — and every chat and Agent thread is one sidebar list below it;
  // without them it opens a new chat, which opens onto the user's workbench.
  const primary: PrimaryNavigationItem[] = [
    {
      key: 'chat',
      label: chatLabel,
      icon: MessageCircle,
      href: bots ? '#/bots' : '#/chat',
      ...(bots?.badge ? { badge: bots.badge } : {}),
    },
    ...primaryApplicationItems,
  ];

  // Secondary destinations live under "More" on both desktop and mobile. Durable
  // work has one separate fixed Execution Center entry near the account row, so
  // Mission no longer competes in this menu.
  const overflow: PrimaryNavigationItem[] = [
    ...overflowApplicationItems,
    {
      key: 'skillhub',
      label: skillhubLabel,
      icon: Package,
      href: '#/skillhub',
    },
  ];

  return { primary, overflow };
}
