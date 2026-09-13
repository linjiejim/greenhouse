import { describe, expect, it } from 'vitest';
import { groupMissionOutcomes } from './mission-outcome-grouping';

const dispatchStep = (dispatchId: string) => ({
  step: 1,
  tool: 'mission_dispatch',
  input: {},
  output: { type: 'mission_dispatch', dispatch_id: dispatchId, prompt: 'Create a file' },
  duration_ms: 10,
});

describe('groupMissionOutcomes', () => {
  it('groups a durable outcome under the exact dispatch message', () => {
    const groups = groupMissionOutcomes(
      [
        {
          id: 'assistant-dispatch',
          role: 'assistant',
          content: 'Task ready',
          created_at: '2026-08-13T07:04:00Z',
          pipeline: [dispatchStep('cad_1')],
        },
        {
          id: 'cloud-agent-outcome:car_1',
          role: 'assistant',
          content: 'Done',
          created_at: '2026-08-13T07:05:00Z',
          pipeline: [],
        },
      ],
      [{ id: 'car_1', dispatch_id: 'cad_1' }],
    );

    expect(groups.byOriginMessageId.get('assistant-dispatch')?.content).toBe('Done');
    expect(groups.groupedOutcomeMessageIds.has('cloud-agent-outcome:car_1')).toBe(true);
  });

  it('leaves follow-up or unmatched outcomes as independent messages', () => {
    const groups = groupMissionOutcomes(
      [
        {
          id: 'cloud-agent-outcome:car_2',
          role: 'assistant',
          content: 'Follow-up done',
          created_at: '2026-08-13T07:06:00Z',
          pipeline: [],
        },
      ],
      [{ id: 'car_2', dispatch_id: null }],
    );

    expect(groups.byOriginMessageId.size).toBe(0);
    expect(groups.groupedOutcomeMessageIds.size).toBe(0);
  });
});
