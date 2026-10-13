import { describe, expect, it } from 'vitest';
import { decideApproval, initialRecords, saveRecord } from './data';

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
