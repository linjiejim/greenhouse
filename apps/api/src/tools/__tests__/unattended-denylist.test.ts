/**
 * Unattended-context denylist.
 *
 * `automation_mutation` schedules unattended agent runs. Handing it to a context
 * that is ITSELF unattended — a scheduled-task run or a workflow node — removes
 * the only real gate (a user agreeing to the schedule) and lets a task schedule
 * more tasks, draining the quota and the model budget with nobody watching.
 *
 * A custom Agent profile pins its own tool array, so this is reachable in
 * practice: name the tool in a profile, point a scheduled task at that profile.
 * The read-only `automation_query` stays available — an unattended run reporting
 * on the user's schedules is useful and harmless.
 */

import { describe, it, expect } from 'vitest';
import { filterUnattendedToolIds, UNATTENDED_TOOL_DENYLIST } from '../../agent-runtime/tool-resolution.js';
import { scheduledToolBase } from '../../scheduler/executor.js';
import { NODE_TOOL_DENYLIST } from '../../workflow-engine/index.js';

describe('unattended-context tool denylist', () => {
  it('drops automation_mutation from a scheduled run even when the owner holds it', () => {
    const effective = ['knowledge_query', 'automation_query', 'automation_mutation'];

    expect(scheduledToolBase(effective)).toEqual(['knowledge_query', 'automation_query']);
  });

  it('defaults every unattended surface to catalogued read-only tools', () => {
    expect(
      filterUnattendedToolIds([
        'knowledge_query',
        'knowledge_mutation',
        'project_query',
        'project_mutation',
        'tables_mutation',
        'memory',
        'spawn_session',
      ]),
    ).toEqual(['knowledge_query', 'project_query']);
  });

  it('requires an explicit replay-safe declaration instead of trusting proxy read', () => {
    expect(filterUnattendedToolIds(['generate_image', 'analyze_image', 'external_search', 'knowledge_query'])).toEqual([
      'knowledge_query',
    ]);
  });

  it('drops automation_mutation from workflow nodes too', () => {
    expect(NODE_TOOL_DENYLIST.has('automation_mutation')).toBe(true);
    expect(NODE_TOOL_DENYLIST.has('automation_query')).toBe(false);
  });

  it('keeps the node denylist a superset of the shared unattended set', () => {
    for (const id of UNATTENDED_TOOL_DENYLIST) {
      expect(NODE_TOOL_DENYLIST.has(id), `${id} is denied for scheduled runs but not for workflow nodes`).toBe(true);
    }
  });
});
