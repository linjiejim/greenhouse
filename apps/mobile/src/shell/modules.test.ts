import { describe, expect, it } from 'vitest';
import { HUB_MODULES, hasTables, visibleModules } from './modules';

describe('the hub’s places', () => {
  it('starts at home and lists every module once', () => {
    expect(HUB_MODULES[0]!.id).toBe('home');
    expect(new Set(HUB_MODULES.map((m) => m.id)).size).toBe(HUB_MODULES.length);
    expect(HUB_MODULES.map((m) => m.id)).toEqual(['home', 'knowledge', 'files', 'projects', 'tables', 'agent', 'assistant']);
  });

  it('shows Tables only with the feature, or to a super', () => {
    expect(hasTables({ role: 'team', features: { tables: true } })).toBe(true);
    expect(hasTables({ role: 'team', features: {} })).toBe(false);
    expect(hasTables({ role: 'super', features: {} })).toBe(true);
    expect(hasTables(null)).toBe(false);
    expect(visibleModules({ role: 'team', features: {} }).map((m) => m.id)).not.toContain('tables');
    expect(visibleModules({ role: 'team', features: { tables: true } }).map((m) => m.id)).toContain('tables');
  });
});
