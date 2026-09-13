import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Sidebar layout contract', () => {
  it('keeps one persisted sidebar width across application routes', () => {
    const sidebar = readFileSync(new URL('./app-sidebar.tsx', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../../stores/ui-store.ts', import.meta.url), 'utf8');

    expect(sidebar).not.toContain('knowledgeSidebarWidth');
    expect(sidebar).not.toContain('isKnowledgeRoute');
    expect(store).not.toContain('knowledge-sidebar-width');
    expect(store).not.toContain('KNOWLEDGE_SIDEBAR_DEFAULT_WIDTH');
  });

  it('uses the same segmented scope control as Chat in Knowledge', () => {
    const knowledge = readFileSync(new URL('./sidebar-panels/knowledge-nav-panel.tsx', import.meta.url), 'utf8');

    expect(knowledge).toMatch(/<FilterPills[\s\S]{0,240}variant="segment"[\s\S]{0,120}fill/);
  });
});
