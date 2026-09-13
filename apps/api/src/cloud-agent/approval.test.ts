import { describe, expect, it } from 'vitest';

import { canonicalAgentToolInput, cloudMutationNeedsApproval, hashAgentToolInput } from './approval.js';

describe('Cloud Agent mutation approval policy', () => {
  it('binds semantically identical object input to one canonical hash', () => {
    const left = { action: 'update', data: { z: 2, a: 1 }, ids: ['b', 'a'] };
    const right = { ids: ['b', 'a'], data: { a: 1, z: 2 }, action: 'update' };
    expect(canonicalAgentToolInput(left)).toBe(canonicalAgentToolInput(right));
    expect(hashAgentToolInput(left)).toBe(hashAgentToolInput(right));
    expect(hashAgentToolInput({ ...left, ids: ['a', 'b'] })).not.toBe(hashAgentToolInput(left));
  });

  it('only auto-allows a private email draft', () => {
    expect(cloudMutationNeedsApproval('email_mutation', { action: 'draft' })).toBe(false);
    expect(cloudMutationNeedsApproval('email_mutation', { action: 'send' })).toBe(true);
    expect(cloudMutationNeedsApproval('crm_mutation', { action: 'update_company' })).toBe(true);
  });
});
