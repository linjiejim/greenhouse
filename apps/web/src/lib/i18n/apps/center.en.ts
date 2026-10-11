/**
 * Apps · the app center (`#/apps`): shelves, entry points, empty states.
 * Owned by slice C (center); spread into `apps` by ./en.ts (keys resolve as `apps.center.*`).
 */

export const appsCenterEn = {
  center: {
    loadFailed: 'Unable to load your apps',
    newApp: 'New app',
    askBot: 'Ask a Bot to build one',
    fromTemplate: 'From a template',
    entryUnavailable: 'Not available yet — building apps arrives with the app builder.',
    shelf: {
      managed: 'Managed by me',
      managedHint: 'Apps on Bases you own or build, drafts included',
      shared: 'Shared with me',
      sharedHint: 'Published apps given to you, a group of yours or everyone',
      featured: 'Featured',
      featuredHint: 'Picked by an administrator for everyone who can open them',
    },
    emptyTitle: 'No apps yet',
    emptyDescription:
      'Apps turn a Base into pages for one job — a request form, an approval board, a report — shared with the people who use it.',
    version: 'v{version}',
    notPublished: 'Not published yet',
    open: 'Open {name}',
    edit: 'Edit {name}',
    noDescription: 'No description',
    pin: 'Pin {name} to the sidebar',
    unpin: 'Unpin {name}',
    pinFailed: 'Unable to update your pinned apps',
  },
} as const;
