/** @vitest-environment happy-dom */

/**
 * Which computer a view follows (spec 20261011-agent-first-class P3a): every Agent has its own,
 * the main Agent's (Sprouty's) is named null, and a view never takes another computer's pushes or
 * answers for its own.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComputerStatusView } from '@greenhouse/types/bots';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { computerBotFor, computerEventMatches, useComputerStatus, type ComputerStatusState } from './computer-phase';

const api = vi.hoisted(() => ({ fetchComputerStatus: vi.fn(), startComputer: vi.fn() }));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
const ws = vi.hoisted(() => ({ handlers: new Set<(event: ServerWsEvent) => void>() }));
vi.mock('../../lib/ws', () => ({
  wsClient: {
    onEvent: (handler: (event: ServerWsEvent) => void) => {
      ws.handlers.add(handler);
      return () => ws.handlers.delete(handler);
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function view(overrides: Partial<ComputerStatusView> = {}): ComputerStatusView {
  return {
    runtime: { state: 'ready', reason: null, hardened: true },
    state: 'running',
    state_reason: null,
    controller: 'bot',
    controller_since: null,
    last_active_at: null,
    queue_position: null,
    disk_bytes: null,
    timezone: null,
    lang: 'en-US',
    restored_from: null,
    ...overrides,
  };
}

const SPROUTY = { id: 'bot_sprouty', template_key: 'sprouty' };
const SAGE = { id: 'bot_sage', template_key: null };
const lookup = (id: string) => [SPROUTY, SAGE].find((bot) => bot.id === id);

describe('computerBotFor', () => {
  it('names the main computer null — Sprouty’s, or no Agent — and any other Agent’s by its id', () => {
    expect(computerBotFor(SPROUTY.id, lookup)).toBeNull();
    expect(computerBotFor(null, lookup)).toBeNull();
    expect(computerBotFor(SAGE.id, lookup)).toBe('bot_sage');
    // Not known yet: sent as is (the server maps Sprouty to the main computer itself).
    expect(computerBotFor('bot_new', lookup)).toBe('bot_new');
  });
});

describe('computerEventMatches', () => {
  it('takes pushes about its own computer only', () => {
    const mine = { computer_id: 'u1.bot_sage', bot_id: 'bot_sage' };
    expect(computerEventMatches(mine, 'bot_sage', null)).toBe(true);
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, 'bot_sage', null)).toBe(false);
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, null, null)).toBe(true);
    expect(computerEventMatches(mine, null, null)).toBe(false);
  });

  it('reads a push without ids (an older server) as the main computer’s', () => {
    expect(computerEventMatches({}, null, null)).toBe(true);
    expect(computerEventMatches({}, 'bot_sage', null)).toBe(false);
  });

  it('matches by computer id once the view knows it (asked by Sprouty’s own id)', () => {
    const known = { computer_id: 'u1', bot_id: null };
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, 'bot_sprouty', known)).toBe(true);
    expect(computerEventMatches({ computer_id: 'u1.bot_sage', bot_id: 'bot_sage' }, 'bot_sprouty', known)).toBe(false);
  });
});

describe('useComputerStatus', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let latest: ComputerStatusState | null = null;

  function Probe({ bot }: { bot: string | null }) {
    latest = useComputerStatus(true, bot);
    return createElement('span', { 'data-state': latest.status?.state ?? 'none' });
  }

  async function render(bot: string | null) {
    if (!root) {
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => root?.render(createElement(Probe, { bot })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** A push, and the refetch it may start (settled inside act). */
  async function push(event: Omit<Extract<ServerWsEvent, { type: 'bots:computer' }>, 'type'>) {
    await act(async () => {
      for (const handler of ws.handlers) handler({ type: 'bots:computer', ...event } as ServerWsEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    api.fetchComputerStatus.mockReset();
    ws.handlers.clear();
    latest = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('asks for its Agent’s computer and ignores pushes about the member’s other computers', async () => {
    api.fetchComputerStatus.mockResolvedValue(view({ computer_id: 'u1.bot_sage', bot_id: 'bot_sage' }));
    await render('bot_sage');
    expect(api.fetchComputerStatus).toHaveBeenCalledWith('bot_sage');
    expect(latest?.bot).toBe('bot_sage');
    expect(latest?.status?.state).toBe('running');

    // The main computer went to sleep: not this one.
    await push({ state: 'absent', controller: 'bot', computer_id: 'u1', bot_id: null });
    expect(latest?.status?.state).toBe('running');
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(1);

    // This one did: patched at once, then re-read.
    api.fetchComputerStatus.mockResolvedValue(
      view({ state: 'stopping', computer_id: 'u1.bot_sage', bot_id: 'bot_sage' }),
    );
    await push({ state: 'stopping', controller: 'bot', computer_id: 'u1.bot_sage', bot_id: 'bot_sage' });
    expect(latest?.status?.state).toBe('stopping');
    expect(api.fetchComputerStatus).toHaveBeenCalledTimes(2);
  });

  it('starts over on another computer and drops a late answer about the previous one', async () => {
    let answerMain: (value: ComputerStatusView) => void = () => {};
    api.fetchComputerStatus.mockImplementation((bot: string | null) =>
      bot === null
        ? new Promise<ComputerStatusView>((resolve) => {
            answerMain = resolve;
          })
        : Promise.resolve(view({ state: 'absent', computer_id: `u1.${bot}`, bot_id: bot })),
    );
    await render(null);
    expect(latest?.status).toBeNull();

    await render('bot_sage');
    expect(latest?.bot).toBe('bot_sage');
    expect(latest?.status?.state).toBe('absent');

    // The main computer's answer arrives after the switch: it is not Sage's.
    await act(async () => answerMain(view({ state: 'running', computer_id: 'u1', bot_id: null })));
    expect(latest?.status?.state).toBe('absent');

    // An action's result about another Agent's computer is not applied either.
    act(() => latest?.apply(view({ state: 'running', computer_id: 'u1.bot_fern', bot_id: 'bot_fern' })));
    expect(latest?.status?.state).toBe('absent');
  });
});
