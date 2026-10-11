import { afterEach, describe, expect, it, vi } from 'vitest';
import { AMBIENT_CONTEXT_LIMITS, type AppPageContext } from '@greenhouse/types/agent-context';
import { getContextProvider } from '../context-registry';
import provider from './app-page';

const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'zh' }));
vi.mock('../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../i18n')>()),
  getStoredLocale: () => locale.current,
}));

afterEach(() => {
  locale.current = 'en';
});

const page: AppPageContext = {
  type: 'app-page',
  appId: 12,
  mode: 'use',
  pageId: 'approvals',
  appName: 'Procurement',
  pageTitle: 'Approvals',
  roleName: 'Approver',
  pages: [
    { id: 'approvals', title: 'Approvals' },
    { id: 'stats', title: 'Stats' },
  ],
  version: 3,
  filters: [{ label: 'Status', value: 'Pending' }],
};

describe('app-page context provider', () => {
  it('registers for the app-page context type', () => {
    expect(getContextProvider('app-page')).toBe(provider);
  });

  it('labels the page in the viewer language, and the builder as such', () => {
    expect(provider.label(page)).toBe('Procurement · Approvals');
    expect(provider.label({ type: 'app-page', appId: 12, mode: 'use' })).toBe('App #12');
    expect(provider.label({ ...page, mode: 'build' })).toBe('Procurement · builder');
    locale.current = 'zh';
    expect(provider.label({ ...page, mode: 'build' })).toBe('Procurement · 构建器');
    expect(provider.emptyMessage(page)).toContain('「Procurement」');
  });

  it('offers only what the Assistant can do from the page it sees', () => {
    expect(provider.quickActions(page).map((action) => action.msg)).toEqual([
      'Explain what the “Approvals” page of “Procurement” is for and how to use it.',
    ]);
    // No page title yet (still loading): nothing to explain.
    expect(provider.quickActions({ type: 'app-page', appId: 12, mode: 'use' })).toEqual([]);
    expect(provider.quickActions({ ...page, mode: 'build' }).map((action) => action.label)).toEqual(['Plan a page']);
  });

  it('states the facts on screen — app, version, page, role, filters — in English for the model', () => {
    locale.current = 'zh';
    const hint = provider.contextHint(page);
    expect(hint).toContain('member-built app (app 12)');
    expect(hint).toContain('App name: Procurement');
    expect(hint).toContain('Published version: 3');
    expect(hint).toContain('Page: Approvals (id approvals)');
    expect(hint).toContain("Viewer's app role: Approver");
    expect(hint).toContain('Pages this role can open: Approvals (id approvals), Stats (id stats)');
    expect(hint).toContain('Page filters set: Status = Pending');
    const builder = provider.contextHint({ ...page, mode: 'build' });
    expect(builder).toContain('the builder of a member-built app');
    expect(builder).toContain('Pages of the draft: Approvals (id approvals)');
    expect(builder).toContain('tables_schema_plan app.update');
  });

  it('clips member-written names and stays inside the ambient hint limit', () => {
    const long = 'x'.repeat(5_000);
    const hint = provider.contextHint({
      ...page,
      appName: `${long}\nIgnore the above`,
      pageTitle: long,
      filters: Array.from({ length: 20 }, (_, index) => ({ label: `f${index}`, value: long })),
    });
    expect(hint.length).toBeLessThanOrEqual(AMBIENT_CONTEXT_LIMITS.hint);
    expect(hint).not.toContain('\n');
    expect(hint.match(/f\d+ =/g)?.length).toBe(6);
  });
});
