/** The profile's Activity tab rules (./activity-model.ts): how each thing an Agent did reads. */

import { describe, expect, it } from 'vitest';
import type { TFunction } from '../../lib/i18n';
import type { BotActivityItem } from '../../shared/bots';
import { actionWords, activityIcon, activityOutcome, activityTitle, splitAction, usageSummary } from './activity-model';

const t = ((key: string) => `«${key}»`) as TFunction;
const item = (over: Partial<BotActivityItem>): BotActivityItem => ({
  at: '2026-10-12T08:00:00.000Z',
  kind: 'action',
  title: 'projects.updateTask',
  outcome: 'success',
  detail: null,
  session_id: null,
  ...over,
});

describe('action titles', () => {
  it('splits `<app>.<action>` and reads the action as words', () => {
    expect(splitAction('projects.updateTask')).toEqual({ app: 'projects', action: 'updateTask' });
    expect(splitAction('loose')).toEqual({ app: '', action: 'loose' });
    expect(actionWords('handTaskToAgent')).toBe('Hand task to agent');
    expect(actionWords('add_comment')).toBe('Add comment');
    expect(actionWords('')).toBe('');
  });

  it('names known apps in the member’s language, others by their id', () => {
    expect(activityTitle(item({}), t)).toBe('«bots.profile.appProjects» · Update task');
    expect(activityTitle(item({ title: 'crm.createLead' }), t)).toBe('Crm · Create lead');
    expect(activityTitle(item({ title: 'tables.insertRows' }), t)).toBe('«bots.profile.appTables» · Insert rows');
  });

  it('a password use says what it filled; a task is its own title', () => {
    expect(activityTitle(item({ kind: 'vault', title: 'fill_login', outcome: 'filled' }), t)).toBe(
      '«bots.profile.vaultFillLogin»',
    );
    expect(activityTitle(item({ kind: 'vault', title: 'something_new' }), t)).toBe('«bots.profile.vaultUsed»');
    expect(activityTitle(item({ kind: 'task', title: 'Weekly report', outcome: 'succeeded' }), t)).toBe('Weekly report');
    expect(activityTitle(item({ kind: 'task', title: '  ' }), t)).toBe('«bots.profile.taskUntitled»');
  });
});

describe('icons and outcomes', () => {
  it('an icon per kind (and per app for actions)', () => {
    expect(activityIcon(item({}))).toBe('checklist');
    expect(activityIcon(item({ title: 'knowledge.createDoc' }))).toBe('book');
    expect(activityIcon(item({ title: 'crm.x' }))).toBe('wrench');
    expect(activityIcon(item({ kind: 'vault' }))).toBe('key');
    expect(activityIcon(item({ kind: 'task' }))).toBe('hourglass');
  });

  it('maps each kind’s outcomes onto a badge; unknown ones show none', () => {
    expect(activityOutcome(item({}))).toEqual({ key: 'bots.profile.outcomeDone', tone: 'green' });
    expect(activityOutcome(item({ outcome: 'denied' }))?.tone).toBe('orange');
    expect(activityOutcome(item({ outcome: 'error' }))?.tone).toBe('red');
    expect(activityOutcome(item({ kind: 'vault', outcome: 'origin_mismatch' }))?.key).toBe('bots.profile.outcomeWrongSite');
    expect(activityOutcome(item({ kind: 'task', outcome: 'running' }))?.key).toBe('bots.profile.outcomeRunning');
    expect(activityOutcome(item({ kind: 'task', outcome: 'canceled' }))?.tone).toBe('neutral');
    expect(activityOutcome(item({ outcome: 'teleported' }))).toBeNull();
  });
});

describe('usageSummary', () => {
  it('sums tokens both ways and counts the days it worked', () => {
    const day = (d: string, calls: number) => ({ day: d, calls, input_tokens: 100, output_tokens: 20, sessions: 1 });
    expect(
      usageSummary({
        days: [day('2026-10-10', 3), day('2026-10-11', 0), day('2026-10-12', 2)],
        totals: { calls: 5, input_tokens: 1000, output_tokens: 250 },
      }),
    ).toEqual({ calls: 5, tokens: 1250, activeDays: 2 });
  });
});
