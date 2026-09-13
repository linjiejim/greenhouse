import { describe, expect, it } from 'vitest';
import { ADMIN_REDIRECTS, resolveSettingsRedirect } from './redirects';
import { administrationModules } from '../../lib/nav-registry';

const adminKey = (id: string) => id.split('.').pop()!;

describe('resolveSettingsRedirect', () => {
  it('sends the retired My Agents page to the Agents surface', () => {
    expect(resolveSettingsRedirect('my-profiles')).toBe('#/agents');
  });

  it('sends the retired System Agents inventory to Agent Usages', () => {
    expect(resolveSettingsRedirect('profiles')).toBe('#/administration/usage');
    expect(resolveSettingsRedirect('profiles/anything')).toBe('#/administration/usage');
  });

  it('sends retired personal-tool settings links to their independent pages', () => {
    expect(resolveSettingsRedirect('automations')).toBe('#/automations');
    expect(resolveSettingsRedirect('prompts')).toBe('#/tasks');
  });

  it('returns null for a real Settings module (stays put)', () => {
    expect(resolveSettingsRedirect('preferences')).toBeNull();
    expect(resolveSettingsRedirect('')).toBeNull();
    expect(resolveSettingsRedirect('memory')).toBeNull();
  });

  it('redirects the folded App Permissions page to the Users home', () => {
    // The standalone #/settings/permissions page folded into the per-user modal
    // under Administration → Users; it must not fall through to Preferences.
    expect(resolveSettingsRedirect('permissions')).toBe('#/administration/users');
  });

  it('preserves the sub-path for 1:1 admin remaps', () => {
    expect(resolveSettingsRedirect('eval/runs/123')).toBe('#/administration/eval/runs/123');
  });

  it('drops any tail for folded pages (no sub-route of their own)', () => {
    expect(resolveSettingsRedirect('permissions/anything')).toBe('#/administration/users');
  });

  // Guards the "class of gap" that let #/settings/permissions rot: every
  // administration module must be reachable from its legacy Settings path, and
  // every redirect target must resolve to a real administration module.
  it('has a live redirect for every administration module', () => {
    for (const mod of administrationModules) {
      const key = adminKey(mod.id);
      expect(resolveSettingsRedirect(key), `missing redirect for #/settings/${key}`).toBe(mod.path);
    }
  });

  it('only targets administration modules that exist', () => {
    const realKeys = new Set(administrationModules.map((m) => adminKey(m.id)));
    for (const target of Object.values(ADMIN_REDIRECTS)) {
      expect(realKeys.has(target), `redirect target "${target}" is not a real admin module`).toBe(true);
    }
  });
});
