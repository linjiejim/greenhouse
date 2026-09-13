import { describe, expect, it } from 'vitest';

import { newlySettledMissionRun, shouldPollForSettlement } from './use-mission-run';

describe('newlySettledMissionRun', () => {
  it('waits for the durable settled cursor and emits it once', () => {
    const active = { sessionId: 'session-1', runId: null };
    const settled = { sessionId: 'session-1', runId: 'run-1' };

    expect(newlySettledMissionRun(active, active)).toBeNull();
    expect(newlySettledMissionRun(active, settled)).toBe('run-1');
    expect(newlySettledMissionRun(settled, settled)).toBeNull();
  });

  it('does not report an already-settled run when navigating into a session', () => {
    expect(
      newlySettledMissionRun({ sessionId: 'session-1', runId: 'run-1' }, { sessionId: 'session-2', runId: 'run-2' }),
    ).toBeNull();
  });
});

describe('shouldPollForSettlement', () => {
  it('polls a terminal run that has no durable cursor yet', () => {
    // The exact shape of the 2026-08-13 stall: outcome delivered, page frozen.
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      expect(shouldPollForSettlement({ status, settled_at: null }), status).toBe(true);
    }
  });

  it('stops once the run reports settled_at', () => {
    expect(shouldPollForSettlement({ status: 'completed', settled_at: '2026-08-13T14:56:51.981Z' })).toBe(false);
  });

  it('never polls while the run is still active — replay already covers it', () => {
    for (const status of ['queued', 'starting', 'running'] as const) {
      expect(shouldPollForSettlement({ status, settled_at: null }), status).toBe(false);
    }
  });

  it('has nothing to poll for without a run', () => {
    expect(shouldPollForSettlement(null)).toBe(false);
  });
});
