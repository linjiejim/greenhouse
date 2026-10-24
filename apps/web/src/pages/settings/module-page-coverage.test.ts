import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ModulePageContract {
  file: string;
  moduleId: string;
  layout: 'form' | 'list' | 'canvas';
}

const MODULE_PAGES: ModulePageContract[] = [
  { file: './preferences.tsx', moduleId: 'settings.preferences', layout: 'form' },
  { file: './agent-access/index.tsx', moduleId: 'settings.agent-connections', layout: 'list' },
  { file: './provider-bindings.tsx', moduleId: 'settings.provider-bindings', layout: 'form' },
  { file: './email-accounts.tsx', moduleId: 'settings.email-accounts', layout: 'list' },
  { file: './memory.tsx', moduleId: 'settings.memory', layout: 'list' },
  { file: '../administration/users.tsx', moduleId: 'admin.users', layout: 'list' },
  { file: '../administration/usage.tsx', moduleId: 'admin.usage', layout: 'list' },
  { file: '../administration/feature-requests.tsx', moduleId: 'admin.issues', layout: 'list' },
  { file: '../administration/frictions.tsx', moduleId: 'admin.issues', layout: 'list' },
  { file: '../administration/mcp-keys.tsx', moduleId: 'admin.mcp-keys', layout: 'list' },
  { file: '../administration/runtime-config.tsx', moduleId: 'admin.runtime-config', layout: 'form' },
  { file: '../administration/team-context.tsx', moduleId: 'admin.team-context', layout: 'form' },
  { file: '../administration/branding-studio.tsx', moduleId: 'admin.branding', layout: 'canvas' },
  { file: '../automations.tsx', moduleId: 'workspace.automations', layout: 'list' },
  // Run profiles (custom agents) is the second Automations tab.
  { file: '../run-profiles.tsx', moduleId: 'workspace.automations', layout: 'list' },
  { file: '../tables/index.tsx', moduleId: 'workspace.tables', layout: 'list' },
  { file: '../tables/data-catalog.tsx', moduleId: 'workspace.data-catalog', layout: 'list' },
  { file: '../projects.tsx', moduleId: 'workspace.projects', layout: 'canvas' },
  { file: '../files.tsx', moduleId: 'workspace.files', layout: 'list' },
  { file: '../home.tsx', moduleId: 'workspace.home', layout: 'list' },
  { file: '../skillhub/index.tsx', moduleId: 'workspace.skillhub', layout: 'canvas' },
  // The My prompts tab is a list inside the same module.
  { file: '../skillhub/index.tsx', moduleId: 'workspace.skillhub', layout: 'list' },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('ModulePage coverage', () => {
  it.each(MODULE_PAGES)('$moduleId uses the shared $layout page contract', ({ file, moduleId, layout }) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const pageContract = new RegExp(
      `<ModulePage[\\s\\S]{0,240}moduleId=["']${escapeRegExp(moduleId)}["'][\\s\\S]{0,240}layout=["']${layout}["']`,
    );

    expect(source).toMatch(pageContract);
  });

  it('renders the Activity log on the shared list contract for both of its hosts', () => {
    // One page, two identities: the member's own record and the admin's view of everyone.
    const page = readFileSync(new URL('../activity/activity-log.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/<ModulePage[\s\S]{0,240}moduleId=\{moduleId\}[\s\S]{0,240}layout="list"/);
    const member = readFileSync(new URL('../activity/index.tsx', import.meta.url), 'utf8');
    expect(member).toContain('<ActivityLogPage moduleId="workspace.activity" />');
    const admin = readFileSync(new URL('../administration/index.tsx', import.meta.url), 'utf8');
    expect(admin).toContain('<ActivityLogPage moduleId="admin.activity" />');
  });

  it('gives every tabbed page one row of shared <Tabs>, never a second tab bar or pills for sections', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    // Sections are <Tabs> in the tabs slot.
    expect(read('../files.tsx')).toMatch(/tabs=\{[\s\S]{0,200}<Tabs/);
    for (const file of ['../skillhub/index.tsx', '../automations.tsx', '../administration/issues.tsx']) {
      expect(read(file)).toContain('<Tabs');
    }
    // A tab's own content never stacks another tab row under the page's.
    for (const file of ['../run-profiles.tsx', '../skillhub/prompts.tsx', '../administration/frictions.tsx']) {
      expect(read(file)).not.toContain('<Tabs');
    }
    const requests = read('../administration/feature-requests.tsx');
    expect(requests.match(/<Tabs/g) ?? []).toHaveLength(0);
  });

  it('keeps scrolling and page padding out of the route-level shells', () => {
    for (const file of ['./index.tsx', '../administration/index.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).not.toContain('overflow-y-auto');
      expect(source).not.toMatch(/px-(?:3|4|5|6|8)/);
    }
  });

  it('keeps standalone workspace route wrappers out of App', () => {
    const source = readFileSync(new URL('../../app.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/route === 'automations' && <AutomationsPage params=\{params\} \/>/);
  });
});
