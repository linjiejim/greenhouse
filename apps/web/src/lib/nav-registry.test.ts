import { describe, expect, it } from 'vitest';
import { getNavModule, resolveSubModule, settingsAllModules } from './nav-registry';

describe('desktop settings module', () => {
  it('settings.desktop is visible everywhere: browsers get the installer download', () => {
    // The same nav entry manages native controls inside the shell and renders the
    // download card (desktop-download.tsx) in a browser. Regressing the gate
    // would hide the only place the installer is offered.
    const module = getNavModule('settings.desktop');
    expect(module, 'settings.desktop must stay registered').toBeDefined();
    expect(module?.requireDesktop).toBeUndefined();
    expect(module?.path).toBe('#/settings/desktop');
  });

  it('no settings module is desktop-only today', () => {
    // Asserted as a closed set: a stray requireDesktop elsewhere would silently
    // make a page disappear for every browser user. Add to the list deliberately.
    const gated = settingsAllModules.filter((module) => module.requireDesktop).map((module) => module.id);
    expect(gated).toEqual([]);
  });
});

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
