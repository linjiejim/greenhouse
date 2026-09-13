import { describe, expect, it } from 'vitest';
import { settingsAllModules } from './nav-registry';

describe('personal AI tool navigation', () => {
  it('keeps Chat utility workspaces out of the Settings registry', () => {
    expect(settingsAllModules.find((module) => module.id === 'settings.automations')).toBeUndefined();
    expect(settingsAllModules.find((module) => module.id === 'settings.prompts')).toBeUndefined();
  });
});
