import { describe, expect, it } from 'vitest';
import { abortMissionRelayRequests, beginMissionRelayRequest } from './relay-requests.js';

describe('Mission relay request cancellation', () => {
  it('aborts every in-flight request for one terminal Run and isolates other Runs', () => {
    const first = beginMissionRelayRequest('run-a');
    const second = beginMissionRelayRequest('run-a');
    const other = beginMissionRelayRequest('run-b');

    expect(abortMissionRelayRequests('run-a', 'mission_canceled')).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);

    first.close();
    second.close();
    other.close();
  });

  it('removes a completed request and never aborts it later', () => {
    const request = beginMissionRelayRequest('run-complete');
    request.close();

    expect(abortMissionRelayRequests('run-complete')).toBe(0);
    expect(request.signal.aborted).toBe(false);
  });
});
