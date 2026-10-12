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
    emptyDescription: 'Create an app or start from a template.',
    emptyViewerDescription: 'Apps shared with you appear here.',
    version: 'v{version}',
    open: 'Open {name}',
    edit: 'Edit {name}',
    pin: 'Pin {name} to the sidebar',
    unpin: 'Unpin {name}',
    pinFailed: 'Unable to update your pinned apps',
    askBot: {
      entry: 'Build with an Agent',
      title: 'Build with an Agent',
      hint: 'Refine your request in chat, then confirm the plan before creation.',
      base: 'Data source',
      newBase: 'A new Base',
      goal: 'What should the app do?',
      goalPlaceholder: 'e.g. purchase requests with approval by Finance and a monthly report',
      open: 'Continue to chat',
      prompt: 'Build an app on my Base “{base}” (Base #{id}) for: {goal}',
      promptNewBase: 'Build an app on a new Base for: {goal}',
    },
    templates: {
      title: 'Start from a template',
      note: 'Creates a private Base and draft app. Automations start disabled. Configure it before publishing.',
      use: 'Choose template',
      back: 'Choose another',
      installing: 'Setting it up…',
      failed: 'Unable to install the template',
    },
  },
} as const;
