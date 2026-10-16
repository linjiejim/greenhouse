import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  decideRequest,
  initialRequests,
  nextPendingRequest,
  pendingRequests,
  initialRecords,
  saveRecord,
} from './data';

describe('design prototype interactions', () => {
  it('cannot submit an expired or already decided approval', () => {
    const pending = { state: 'pending' as const, expiresAt: 1000 };
    expect(decideApproval(pending, 'accepted', 1001).state).toBe('expired');
    const accepted = decideApproval(pending, 'accepted', 900);
    expect(decideApproval(accepted, 'rejected', 901)).toEqual(accepted);
  });

  it('saves a trimmed title without changing the other records, and rejects an empty title', () => {
    const changed = saveRecord(initialRecords, { ...initialRecords[0], title: '  新标题  ' });
    expect(changed[0].title).toBe('新标题');
    expect(changed[1]).toEqual(initialRecords[1]);
    expect(initialRecords[0].title).toBe('完善成员邀请流程');
    expect(() => saveRecord(initialRecords, { ...initialRecords[0], title: ' ' })).toThrow('请输入标题');
  });
});

describe('shared needs-you requests', () => {
  it('decides only pending requests and keeps expiry at its exact boundary', () => {
    const request = { ...initialRequests[0], expiresAt: 1000 };
    expect(decideRequest(request, 'accepted', 999).state).toBe('accepted');
    expect(decideRequest(request, 'accepted', 1000).state).toBe('expired');
    expect(decideRequest(request, 'rejected', 1001).state).toBe('expired');
    for (const state of ['accepted', 'rejected', 'expired', 'done'] as const) {
      const terminal = { ...request, state };
      expect(decideRequest(terminal, 'accepted', 500)).toBe(terminal);
    }
    expect(decideRequest(initialRequests[2], 'done').state).toBe('done');
    expect(initialRequests[0].state).toBe('pending');
  });
  it('lists pending requests without changing their order or mutating the source', () => {
    const requests = initialRequests.map((request, index) =>
      index === 0 ? decideRequest(request, 'accepted') : request,
    );
    expect(pendingRequests(requests)).toEqual(initialRequests.slice(1));
    expect(pendingRequests([])).toEqual([]);
    expect(initialRequests).toHaveLength(6);
  });
  it('finds the next pending request, wraps and skips the current one', () => {
    const requests = initialRequests.slice(0, 3);
    expect(nextPendingRequest(requests, requests[0].id)).toBe(requests[1]);
    expect(nextPendingRequest(requests, requests[2].id)).toBe(requests[0]);
    expect(nextPendingRequest([requests[0]], requests[0].id)).toBeUndefined();
    expect(nextPendingRequest([], 'missing')).toBeUndefined();
    expect(nextPendingRequest(requests, 'missing')).toBe(requests[0]);
    const decided = requests.map((request) => decideRequest(request, 'rejected'));
    expect(nextPendingRequest(decided, requests[0].id)).toBeUndefined();
    expect(nextPendingRequest([requests[0], decided[1], requests[2]], requests[0].id)).toBe(requests[2]);
  });
});
