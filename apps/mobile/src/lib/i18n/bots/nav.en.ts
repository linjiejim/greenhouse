/** Agents (code: bots) entry & navigation copy (`bots.nav`) — English, the key source. */

export const botsNavEn = {
  nav: {
    /** The drawer's sections (主线 · Agent · 会话 — the third is `drawer.sessions`). */
    agents: 'Agents',
    showAll: 'Show All ({n})',
    archived: 'Archived ({n})',
    loadFailed: 'Couldn’t load Agents · Retry',
    pinnedA11y: 'Pinned',
    open: 'Open',
    markRead: 'Mark as Read',
    profileHint: 'Starts fresh — stays out of your ongoing conversation',
    backTo: 'Back to {name}',
    unavailable: 'Agents aren’t available',
    archivedTitle: 'Archived',
    profile: 'Agent Profile',
    untitledGroup: 'Group',
    archivedName: '{name} (archived)',
    botSaid: '{name}: {text}',
    unread: 'Unread',
    unreadN: '{n} unread',
    lastMessage: 'Last message: {text}',
    listSep: ', ',
    markReadFailed: 'Couldn’t mark as read',
    menuBadgeA11y: '{n} need your attention',
    // the archived sheet
    archivedEmpty: 'No Archived Conversations',
    archivedEmptyHint: 'When an Agent is archived, its conversations stay here, read-only.',
    archivedFooter: 'Nobody here replies any more — the history stays readable.',
    loadFailedTitle: 'Couldn’t Load Conversations',
    /** Someone else's public Agent (P4): who published it, beside its name in a row. */
    byOwner: 'by {name}',
    /** The drawer's way to the public Agents offered to the member (`/bots/agents`). */
    browse: 'Browse Agents',
    browseHint: 'Agents your teammates shared with you',
  },
  /** "Browse Agents" (app/bots/agents.tsx): other members' public Agents offered to this member. */
  agents: {
    title: 'Browse Agents',
    talk: 'Talk',
    open: 'Open',
    byOwner: 'By {name}',
    footer:
      'Each one is its owner’s, shared with you. They see how much it’s used and your ratings — never your conversations.',
    empty: 'No Shared Agents Yet',
    emptyHint: 'When a teammate shares an Agent with you, it shows up here.',
    noMatch: 'No Results',
    loadFailed: 'Couldn’t Load Agents',
    missing: 'Not Available on This Server',
    missingHint: 'This server doesn’t share Agents yet.',
    gone: '{name} isn’t shared with you any more',
    startFailed: 'Couldn’t start a conversation with {name}',
  },
};
