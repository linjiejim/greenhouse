import { describe, expect, it } from 'vitest';
import { AUTOMATIONS_PROFILES_HASH, retiredWorkspaceRedirect, SKILLHUB_PROMPTS_HASH } from './workspace-routes';

describe('retiredWorkspaceRedirect', () => {
  it('sends the retired My prompts page and its aliases to the SkillHub tab', () => {
    expect(SKILLHUB_PROMPTS_HASH).toBe('#/skillhub?tab=prompts');
    expect(retiredWorkspaceRedirect('tasks')).toBe(SKILLHUB_PROMPTS_HASH);
    expect(retiredWorkspaceRedirect('prompts')).toBe(SKILLHUB_PROMPTS_HASH);
    expect(retiredWorkspaceRedirect('chat', 'prompts')).toBe(SKILLHUB_PROMPTS_HASH);
  });

  it('sends the retired My Agents page to the Automations › Run profiles tab', () => {
    expect(AUTOMATIONS_PROFILES_HASH).toBe('#/automations?tab=profiles');
    expect(retiredWorkspaceRedirect('agents')).toBe(AUTOMATIONS_PROFILES_HASH);
    expect(retiredWorkspaceRedirect('chat', 'agents')).toBe(AUTOMATIONS_PROFILES_HASH);
  });

  it('canonicalizes the legacy Chat workspace switches', () => {
    expect(retiredWorkspaceRedirect('chat', 'automations')).toBe('#/automations');
  });

  it('leaves live routes alone', () => {
    expect(retiredWorkspaceRedirect('chat')).toBeNull();
    expect(retiredWorkspaceRedirect('chat', 'conversation')).toBeNull();
    expect(retiredWorkspaceRedirect('skillhub')).toBeNull();
    expect(retiredWorkspaceRedirect('automations')).toBeNull();
  });
});
