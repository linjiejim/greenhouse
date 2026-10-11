/**
 * Apps · the Agent side: the Assistant's `app-page` context, app plan operations,
 * Bots plan requests and built-in templates.
 * Owned by slice AG; spread into `apps` by ./en.ts (keys resolve as `apps.agent.*`).
 */

export const appsAgentEn = {
  agent: {
    context: {
      label: '{app} · {page}',
      appOnly: '{app}',
      unnamedApp: 'App #{id}',
      builderLabel: '{app} · builder',
      empty: 'Ask about “{app}” — what a page is for, or how to use it.',
      builderEmpty: 'Ask about “{app}” — its pages, roles, and who it is shared with.',
      explainPage: 'Explain this page',
      explainPagePrompt: 'Explain what the “{page}” page of “{app}” is for and how to use it.',
      planPage: 'Plan a page',
      planPagePrompt: 'Help me plan a new page for the app “{app}”.',
    },
  },
} as const;
