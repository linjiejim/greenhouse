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
    /** App operations on the schema-plan card (chat) — `components/tables/schema-plan-card.tsx`. */
    plan: {
      opAppCreate: 'Create app',
      opAppUpdate: 'Update app draft',
      opAppAudience: 'Share app',
      opAppPublish: 'Publish app',
      groupApps: 'Apps',
      appShape: '{pages} pages · {roles} roles',
      accessAudience: 'Who uses the app {app}',
      accessPublish: 'Publish the app {app}',
      audienceNobody: 'shared with nobody',
      audienceTeam: 'everyone in the team',
      audienceGroup: 'group {name}',
      audienceGroupManaged: 'group {name} (managed by {manager})',
      audienceEntry: '{who} → {role}',
      publishFirst: 'not published',
      publishLive: 'v{version} live',
      publishAfter: 'v{version} live for {audience}',
      openApp: 'Open app',
    },
    /** A Bot's proposed Tables change, as a "needs you" card (`components/bots/tables-plan-card.tsx`). */
    planRequest: {
      title: '{name} proposes a Tables change',
      hint: 'Nothing changes until you apply it — every step then runs as you, with your permissions.',
      apply: 'Apply',
      decline: 'Not now',
      applying: 'Applying…',
      applied: 'Applied',
      partial: 'Partly applied',
      failed: 'Not applied',
      tally: '{applied} applied · {failed} failed · {skipped} skipped',
      linesCount: '{count} changes',
      openBase: 'Open Base',
      openApp: 'Open app',
    },
  },
} as const;
