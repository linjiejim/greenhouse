import { describe, expect, it } from 'vitest';
import { formatRate, overallCacheHitRate, sumCounts, totalsByClient, totalsByKey } from './report';

const toolCalls = [
  { key: 'knowledge_query', client: 'mcp', count: 7 },
  { key: 'knowledge_query', client: 'web_chat', count: 3 },
  { key: 'tables_query', client: 'mcp', count: 4 },
];
const pageOpens = [
  { key: 'chat', client: 'web', count: 5 },
  { key: 'chat', client: 'desktop', count: 1 },
];

describe('module usage report shaping', () => {
  it('totals per key with per-client counts, largest first', () => {
    expect(totalsByKey(toolCalls)).toEqual([
      {
        key: 'knowledge_query',
        total: 10,
        clients: [
          { client: 'mcp', count: 7 },
          { client: 'web_chat', count: 3 },
        ],
      },
      { key: 'tables_query', total: 4, clients: [{ client: 'mcp', count: 4 }] },
    ]);
  });

  it('breaks both kinds down per client', () => {
    expect(totalsByClient(toolCalls, pageOpens)).toEqual([
      { client: 'mcp', toolCalls: 11, pageOpens: 0 },
      { client: 'web', toolCalls: 0, pageOpens: 5 },
      { client: 'web_chat', toolCalls: 3, pageOpens: 0 },
      { client: 'desktop', toolCalls: 0, pageOpens: 1 },
    ]);
    expect(sumCounts(toolCalls)).toBe(14);
    expect(sumCounts([])).toBe(0);
  });

  it('weights the overall cache hit rate by input tokens', () => {
    const rows = [
      { model: 'a', calls: 1, input_tokens: 900, cached_tokens: 900, hit_rate: 1 },
      { model: 'b', calls: 1, input_tokens: 100, cached_tokens: 0, hit_rate: 0 },
    ];
    expect(overallCacheHitRate(rows)).toBe(0.9);
    expect(overallCacheHitRate([])).toBeNull();
    expect(formatRate(0.9)).toBe('90.0%');
    expect(formatRate(null)).toBe('—');
  });
});
