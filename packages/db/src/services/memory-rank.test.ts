/**
 * Recall ranking (spec 20261009 D7). The bug it replaces: `ILIKE '%query%'`
 * needed the whole query verbatim, so a multi-word query found nothing even
 * when every word was in a memory.
 */

import { describe, expect, it } from 'vitest';
import { memoryTerms, rankMemories, type RankableMemory } from './memory-rank.js';

const NOW = Date.parse('2026-10-09T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function memory(id: number, title: string, content: string, extra: Partial<RankableMemory> = {}): RankableMemory {
  return {
    id,
    title,
    content,
    pinned: false,
    status: 'active',
    last_used_at: null,
    created_at: daysAgo(10),
    ...extra,
  };
}

const rows = [
  memory(
    1,
    'Prefers CRM figures broken down by 客户类型',
    'When reporting CRM numbers, group by 客户类型 rather than by country.',
  ),
  memory(2, '周报格式偏好', '周报先写结论，再列数据；表格不超过五列。'),
  memory(3, 'Works on the LPH64 water-level alarm', 'Owns the LPH64 低水位报警 firmware investigation.'),
  memory(4, 'Timezone', 'Lives in Shanghai (UTC+8); schedule meetings after 10:00.'),
];

const ids = (list: RankableMemory[]) => list.map((m) => m.id);

describe('rankMemories', () => {
  it('matches a multi-word query word by word — the ILIKE version found nothing here', () => {
    expect(ids(rankMemories(rows, 'CRM 报表 偏好', { now: NOW }))[0]).toBe(1);
    expect(ids(rankMemories(rows, '周报 格式', { now: NOW }))).toEqual([2]);
  });

  it('finds Chinese text across segmentation differences via bigrams', () => {
    // "水位报警" is not a jieba word of "低水位报警", but its bigrams overlap.
    expect(ids(rankMemories(rows, '水位报警', { now: NOW }))).toEqual([3]);
  });

  it('returns nothing when no word matches, rather than the newest memories', () => {
    expect(rankMemories(rows, 'kubernetes ingress', { now: NOW })).toEqual([]);
    expect(rankMemories(rows, '   ', { now: NOW })).toEqual([]);
  });

  it('still ranks the exact phrase first', () => {
    const list = [
      memory(10, 'Report layout', 'quarterly report sections and charts'),
      memory(11, 'Quarterly report owner', 'The quarterly report is owned by Ana.'),
    ];
    expect(ids(rankMemories(list, 'quarterly report is owned', { now: NOW }))[0]).toBe(11);
  });

  it('breaks lexical ties by pinned, then recency', () => {
    const list = [
      memory(20, 'Coffee order', 'oat latte', { created_at: daysAgo(200) }),
      memory(21, 'Coffee order', 'oat latte, no sugar', { created_at: daysAgo(1) }),
      memory(22, 'Coffee order', 'oat latte with an extra shot', { created_at: daysAgo(300), pinned: true }),
    ];
    expect(ids(rankMemories(list, 'coffee', { now: NOW, budgetChars: 10_000 })).slice(0, 2)).toEqual([22, 21]);
  });

  it('drops near-duplicates the weekly consolidation has not merged yet', () => {
    const list = [
      memory(30, 'Prefers short answers', 'Keep answers short and skip the preamble.'),
      memory(31, 'Prefers short answers', 'Keep answers short and skip the preamble!'),
      memory(32, 'Prefers tables', 'Use tables for comparisons.'),
    ];
    expect(ids(rankMemories(list, 'prefers answers tables', { now: NOW }))).toHaveLength(2);
  });

  it('keeps the bodies within the character budget, always returning the best one', () => {
    const big = (id: number) => memory(id, `Project ${id} notes`, `project ${'x'.repeat(1900)}`);
    const list = [big(40), big(41), big(42), big(43), big(44)];
    expect(rankMemories(list, 'project notes', { now: NOW, budgetChars: 4000 })).toHaveLength(2);
    expect(rankMemories(list, 'project notes', { now: NOW, budgetChars: 10 })).toHaveLength(1);
  });

  it('prefers active over dormant on equal text', () => {
    const list = [
      memory(50, 'Prefers dark mode', 'dark theme everywhere', { status: 'dormant' }),
      memory(51, 'Prefers dark mode', 'dark theme in every app', { status: 'active' }),
    ];
    expect(ids(rankMemories(list, 'dark mode', { now: NOW }))[0]).toBe(51);
  });
});

describe('memoryTerms', () => {
  it('keeps identifiers, drops stopwords and lone CJK characters, adds CJK bigrams', () => {
    const terms = memoryTerms('The LPH64 低水位报警');
    expect(terms.has('lph64')).toBe(true);
    expect(terms.has('the')).toBe(false);
    expect(terms.has('水位')).toBe(true);
    expect(terms.has('低')).toBe(false);
  });
});
