/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserPrompt } from '@greenhouse/types/api';

function prompt(id: number, title: string): UserPrompt {
  return {
    id: String(id),
    user_id: 'u1',
    title,
    content: 'Do the thing',
    shortcut: null,
    sort_order: id,
    is_global: false,
    description: null,
    variables: [],
    expected_tools: [],
    source_session_id: null,
    created_via: 'manual',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
}

vi.mock('../../lib/api/prompts', () => ({
  fetchPrompts: vi.fn(async () => [prompt(1, 'Weekly review'), prompt(2, 'Translate')]),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
}));

import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { PromptsPanel } from './prompts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useAuthStore.setState({ currentUser: null });
});

async function render(locale: 'en' | 'zh') {
  useAuthStore.setState({ currentUser: { id: 'u1', nickname: 'Maya', role: 'team' } as never });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: locale, children: createElement(PromptsPanel) }));
  });
  // The list loads after mount; wait for its rows.
  for (let i = 0; i < 20 && !container.textContent?.includes('Weekly review'); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return container.textContent ?? '';
}

describe('SkillHub › My prompts', () => {
  it('counts and creates prompts, not tasks', async () => {
    const text = await render('en');
    expect(text).toContain('2 prompts');
    expect(text).toContain('New prompt');
    expect(text).not.toMatch(/Tasks|New task/);
  });

  it('says 提示词 in Chinese', async () => {
    const text = await render('zh');
    expect(text).toContain('2 条提示词');
    expect(text).toContain('新建提示词');
    expect(text).not.toMatch(/Tasks|新建任务/);
  });
});
