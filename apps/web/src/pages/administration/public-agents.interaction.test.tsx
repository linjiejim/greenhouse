/** @vitest-environment happy-dom */

/**
 * Administration → Public Agents (spec 20261011-agent-first-class P4, D40): every published Agent
 * with its owner, audience and people; pause (after confirming) and resume — nothing else.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPublicAgentRow } from '../../lib/api/bots';
import { I18nProvider, translate } from '../../lib/i18n';
import { audienceLabel, PublicAgentsPanel } from './public-agents';

const api = vi.hoisted(() => ({
  fetchAdminPublicAgents: vi.fn(),
  setAdminPublicAgentPaused: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS: AdminPublicAgentRow[] = [
  {
    id: 'bot_oracle',
    name: 'Oracle',
    owner: { id: 'u2', nickname: 'Alice' },
    published_version: 3,
    available: true,
    paused: false,
    audience: { everyone: true, user_count: 0, group_count: 0 },
    users: 12,
  },
  {
    id: 'bot_scribe',
    name: 'Scribe',
    owner: { id: 'u3', nickname: 'Bo' },
    published_version: 1,
    available: false,
    paused: true,
    audience: { everyone: false, user_count: 2, group_count: 1 },
    users: 0,
  },
];

let root: ReturnType<typeof createRoot> | null = null;

async function settle(ms = 260) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle(50);
}

function rowOf(name: string): HTMLTableRowElement {
  const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(name));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

beforeEach(async () => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminPublicAgents.mockResolvedValue(ROWS);
  api.setAdminPublicAgentPaused.mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(PublicAgentsPanel) }));
  });
  await settle();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PublicAgentsPanel', () => {
  it('lists each public Agent with its owner, version, audience, people and state', () => {
    const oracle = rowOf('Oracle').textContent ?? '';
    expect(oracle).toContain('Alice');
    expect(oracle).toContain('v3');
    expect(oracle).toContain('Everyone');
    expect(oracle).toContain('12');
    expect(oracle).toContain('Available');
    const scribe = rowOf('Scribe').textContent ?? '';
    expect(scribe).toContain('2 people · 1 groups');
    expect(scribe).toContain('Paused');
  });

  it('pauses only after confirming, and resumes in one click', async () => {
    // A paused one offers Resume, an available one Pause.
    expect(rowOf('Scribe').querySelector('button[title="Pause"]')).toBeNull();
    expect(rowOf('Oracle').querySelector('button[title="Resume"]')).toBeNull();

    await click(rowOf('Oracle').querySelector('button[title="Pause"]'));
    expect(api.setAdminPublicAgentPaused).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Pause Oracle?');
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(api.setAdminPublicAgentPaused).toHaveBeenCalledWith('bot_oracle', true);

    await click(rowOf('Scribe').querySelector('button[title="Resume"]'));
    expect(api.setAdminPublicAgentPaused).toHaveBeenCalledWith('bot_scribe', false);
  });
});

describe('audienceLabel', () => {
  const t = ((key: string, params?: Record<string, string | number>) =>
    translate('zh', key as never, params)) as unknown as Parameters<typeof audienceLabel>[1];
  it("reads the server's structured audience in the reader's language", () => {
    expect(audienceLabel({ everyone: true, user_count: 0, group_count: 0 }, t)).toBe('所有人');
    // Everyone wins over any lists the settings still carry.
    expect(audienceLabel({ everyone: true, user_count: 4, group_count: 2 }, t)).toBe('所有人');
    expect(audienceLabel({ everyone: false, user_count: 3, group_count: 0 }, t)).toBe('3 人 · 0 个小组');
  });
});
