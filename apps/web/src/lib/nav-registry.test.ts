import { describe, expect, it } from 'vitest';
import { resolveSubModule, settingsAllModules } from './nav-registry';

describe('personal AI tool navigation', () => {
  it('keeps Chat utility workspaces out of the Settings registry', () => {
    expect(settingsAllModules.find((module) => module.id === 'settings.automations')).toBeUndefined();
    expect(settingsAllModules.find((module) => module.id === 'settings.prompts')).toBeUndefined();
  });
});

describe('resolveSubModule breadcrumbs for deep links', () => {
  it('shows a numeric detail id but not a tab name or request id', () => {
    expect(resolveSubModule('settings', 'groups/12')?.secondary).toMatch(/› #12$/);
    expect(resolveSubModule('settings', 'agent-connections/activity')?.secondary).not.toContain('#');
  });
});
