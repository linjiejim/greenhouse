import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ModulePageContract {
  file: string;
  moduleId: string;
  layout: 'form' | 'list' | 'canvas';
}

const MODULE_PAGES: ModulePageContract[] = [
  { file: './preferences.tsx', moduleId: 'settings.preferences', layout: 'form' },
  { file: './groups.tsx', moduleId: 'settings.groups', layout: 'list' },
  { file: './oauth-grants.tsx', moduleId: 'settings.agent-connections', layout: 'list' },
  { file: './provider-bindings.tsx', moduleId: 'settings.provider-bindings', layout: 'form' },
  { file: './email-accounts.tsx', moduleId: 'settings.email-accounts', layout: 'list' },
  { file: './memory.tsx', moduleId: 'settings.memory', layout: 'list' },
  { file: '../administration/users.tsx', moduleId: 'admin.users', layout: 'list' },
  { file: '../administration/usage.tsx', moduleId: 'admin.usage', layout: 'list' },
  { file: '../administration/feature-requests.tsx', moduleId: 'admin.feature-requests', layout: 'list' },
  { file: '../administration/frictions.tsx', moduleId: 'admin.frictions', layout: 'list' },
  { file: '../eval/index.tsx', moduleId: 'admin.eval', layout: 'canvas' },
  { file: '../administration/llm-gateway.tsx', moduleId: 'admin.llm-gateway', layout: 'list' },
  { file: '../administration/mcp-keys.tsx', moduleId: 'admin.mcp-keys', layout: 'list' },
  { file: '../administration/runtime-config.tsx', moduleId: 'admin.runtime-config', layout: 'form' },
  { file: '../administration/branding-studio.tsx', moduleId: 'admin.branding', layout: 'canvas' },
  { file: '../tasks.tsx', moduleId: 'workspace.tasks', layout: 'list' },
  { file: '../automations.tsx', moduleId: 'workspace.automations', layout: 'list' },
  { file: '../agents.tsx', moduleId: 'workspace.agents', layout: 'list' },
  { file: '../tables/index.tsx', moduleId: 'workspace.tables', layout: 'list' },
  { file: '../projects.tsx', moduleId: 'workspace.projects', layout: 'canvas' },
  { file: '../executions/task-center.tsx', moduleId: 'workspace.executions', layout: 'list' },
  { file: '../skillhub/index.tsx', moduleId: 'workspace.skillhub', layout: 'canvas' },
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

  it('keeps scrolling and page padding out of the route-level shells', () => {
    for (const file of ['./index.tsx', '../administration/index.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).not.toContain('overflow-y-auto');
      expect(source).not.toMatch(/px-(?:3|4|5|6|8)/);
    }
  });

  it('keeps standalone workspace route wrappers out of App', () => {
    const source = readFileSync(new URL('../../app.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(/route === 'automations' && <AutomationsPage \/>/);
    expect(source).toMatch(/route === 'tasks' && <PersonalTasksPage \/>/);
    expect(source).toMatch(/route === 'agents' && <AgentsPage \/>/);
  });

  it('keeps Evaluation confirmations on the shared dialog primitive', () => {
    for (const file of ['../eval/runs.tsx', '../eval/run-detail.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');

      expect(source).toContain('<ConfirmDialog');
      expect(source).not.toMatch(/(^|[^.A-Za-z])confirm\(/m);
    }
  });
});
