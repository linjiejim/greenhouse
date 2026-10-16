import { describe, expect, it } from 'vitest';
import { matchesBase, matchesDirectory } from './directory-filter';
import type { BaseSummary } from '../shared/contract';

describe('native directory matching', () => {
  it('matches names and Agent roles like the web, without searching ids', () => {
    expect(matchesDirectory('  ReSEARch ', 'Greeny', 'Research')).toBe(true);
    expect(matchesDirectory('知识', '共享知识库')).toBe(true);
    expect(matchesDirectory('  ', 'Greeny')).toBe(true);
    expect(matchesDirectory('agt_private', 'Greeny', 'Research')).toBe(false);
    expect(matchesDirectory('other', 'Greeny', 'Research')).toBe(false);
  });
  it('keeps a base when a loaded table, view or dashboard matches', () => {
    const base = {
      name: 'Operations',
      tables: [{ name: 'Tickets', views: [{ name: 'Assigned to me' }] }],
      dashboards: [{ name: 'Overview' }],
    } as BaseSummary;
    for (const query of ['operations', ' tickets ', 'Assigned', 'Overview'])
      expect(matchesBase(query, base)).toBe(true);
    expect(matchesBase('missing', base)).toBe(false);
  });
});
