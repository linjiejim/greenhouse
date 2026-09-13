import { describe, expect, it } from 'vitest';
import type { CloudAgentEvent } from '../../lib/api/cloud-agent';
import { missionDockProgress } from './task-dock';

function event(seq: number, type: string, tool?: string): CloudAgentEvent {
  return {
    seq,
    type,
    payload: JSON.stringify(tool ? { tool } : {}),
    created_at: '2026-08-13T08:00:00.000Z',
  } as CloudAgentEvent;
}

describe('missionDockProgress', () => {
  it('counts observed tool steps and exposes only the currently open tool', () => {
    expect(
      missionDockProgress([
        event(1, 'run.started'),
        event(2, 'tool.started', 'read'),
        event(3, 'tool.completed', 'read'),
        event(4, 'message.assistant'),
        event(5, 'tool.started', 'bash'),
      ]),
    ).toEqual({ stepCount: 2, currentTool: 'bash' });
  });

  it('keeps the completed step count without inventing a planned total', () => {
    expect(missionDockProgress([event(1, 'tool.started', 'bash'), event(2, 'tool.completed', 'bash')])).toEqual({
      stepCount: 1,
      currentTool: null,
    });
  });
});
