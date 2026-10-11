/**
 * Tables · Automations: rule editor, triggers, actions and the run log.
 * Owned by slice Au; spread into `tables` by ./en.ts (keys resolve as `tables.<namespace>.*`).
 */

export const tablesAutomationsEn = {
  automations: {
    title: 'Automations',
    description:
      'Rules execute as the teammate who creates them. Their Base edit access is checked again before every run.',
    loadFailed: 'Unable to load automations',
    createFailed: 'Unable to create automation',
    updateFailed: 'Unable to update automation',
    loadRunsFailed: 'Unable to load runs',
    ruleName: 'Rule name',
    ruleNamePlaceholder: 'Notify owner on new intake',
    table: 'Table',
    trigger: 'Trigger',
    recordCreated: 'Record created',
    recordUpdated: 'Record updated',
    enableImmediately: 'Enable immediately',
    notifyTeammates: 'Notify teammates',
    notificationTitle: 'Notification title',
    message: 'Message',
    createRule: 'Create rule',
    newAutomation: 'New automation',
    emptyTitle: 'No automations yet',
    emptyDescription: 'Create a deterministic rule for record events and internal notifications.',
    tableNumber: 'Table #{id}',
    revision: 'revision {revision}',
    runs: 'Runs',
    noRuns: 'No runs recorded.',
    runSummary: 'Run #{id} · {status} · {count} actions',
  },
} as const;
