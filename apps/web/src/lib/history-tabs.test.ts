import { describe, expect, it } from 'vitest';
import { historyListRequest } from './history-tabs';

describe('historyListRequest', () => {
  it('Mine leaves automation runs out, Scheduled is only them', () => {
    expect(historyListRequest('mine')).toEqual({ scope: 'mine', excludeChannels: ['task'] });
    expect(historyListRequest('scheduled')).toEqual({ scope: 'mine', channel: 'task' });
  });

  it('Shared and Team keep their plain scope', () => {
    expect(historyListRequest('shared')).toEqual({ scope: 'shared' });
    expect(historyListRequest('team')).toEqual({ scope: 'team' });
  });
});
