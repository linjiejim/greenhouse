/**
 * Apps · the app center (`#/apps`): shelves, entry points, empty states, the create dialogs.
 * Owned by slice R; spread into `apps` by ./en.ts (keys resolve as `apps.center.*`).
 */

export const appsCenterEn = {
  center: {
    loadFailed: 'Unable to load your apps',
    newApp: 'New app',
    fromTemplate: 'From a template',
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
    emptyViewerDescription: 'Apps shared with you, a group of yours or everyone show up here.',
    version: 'v{version}',
    notPublished: 'Not published yet',
    open: 'Open {name}',
    edit: 'Edit {name}',
    noDescription: 'No description',
    pin: 'Pin {name} to the sidebar',
    unpin: 'Unpin {name}',
    pinFailed: 'Unable to update your pinned apps',
    askBot: {
      entry: 'Ask a Bot to build one',
      title: 'Ask a Bot to build an app',
      hint: 'Chat opens with your request. The Bot drafts the tables and pages as a plan you confirm before anything is built.',
      base: 'On which Base',
      newBase: 'A new Base (the Bot proposes one)',
      goal: 'What should the app do?',
      goalPlaceholder: 'e.g. purchase requests with approval by Finance and a monthly report',
      open: 'Open Chat',
      prompt: 'Build an app on my Base “{base}” (Base #{id}) for: {goal}',
      promptNewBase: 'Build an app on a new Base for: {goal}',
    },
    templates: {
      title: 'Start from a template',
      note: 'A template creates a new Base you own, with its tables, and a draft app on it — ready to adjust and publish.',
      use: 'Use this template',
      installing: 'Setting it up…',
      failed: 'Unable to install the template',
    },
  },
} as const;
