/** Shared desktop/mobile primary navigation composition. */

import { Bot, MessageCircle, Package, type LucideIcon } from '../lib/icons';
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
   * Bots, when the member has the `bots` feature (the caller decides with
   * `canUseFeature`; the API enforces it again). `badge` = pending "needs
   * you" requests — the one place a waiting Bot is visible from every page.
   */
  bots?: { label: string; badge?: number } | null;
}

export function buildPrimaryNavigation({
  applications,
  chatLabel,
  skillhubLabel,
  bots,
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

  // Visible sidebar order: Chat, Bots, then the authorized primary apps
  // (Knowledge, Projects, CRM). SkillHub and secondary destinations collapse
  // into "More". Chat leads because it is also the home page — a new
  // conversation opens onto the user's workbench; Bots sit right after it as
  // the other place you talk.
  const primary: PrimaryNavigationItem[] = [
    {
      key: 'chat',
      label: chatLabel,
      icon: MessageCircle,
      href: '#/chat',
    },
    ...(bots ? [{ key: 'bots', label: bots.label, icon: Bot, href: '#/bots', badge: bots.badge || undefined }] : []),
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
