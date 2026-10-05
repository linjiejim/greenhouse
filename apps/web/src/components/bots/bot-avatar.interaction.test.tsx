/**
 * @vitest-environment happy-dom
 *
 * A Bot's avatar is its plant on every surface: resolved from its own identity
 * (stored plant → template → id-seeded legacy mapping), static in lists, and
 * moving only while it speaks — then morphing back to idle before going still.
 */

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotView } from '@greenhouse/types/bots';
import { legacyToPlant } from '@greenhouse/types';
import { PLANT_SETTLE_MS } from '@greenhouse/ui/components/plant-avatar';
import { BotAvatar, BotAvatarStack } from './bot-avatar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = (el: ReactElement) => act(() => root.render(el));
const svg = () => host.querySelector('svg')!;
const classes = () => svg().getAttribute('class') ?? '';

function bot(id: string, extra: Partial<BotView> = {}): BotView {
  return {
    id,
    name: id,
    role: '',
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    ...extra,
  };
}

describe('<BotAvatar/>', () => {
  it("resolves the Bot's plant from its own identity", () => {
    render(createElement(BotAvatar, { bot: bot('bot_a', { avatar: { plant: 'maple' } }) }));
    expect(classes()).toContain('pa-maple');

    // A template Bot whose stored avatar predates `plant` still wears its template plant.
    render(createElement(BotAvatar, { bot: bot('bot_b', { template_key: 'researcher', avatar: { color: 'ocean' } }) }));
    expect(classes()).toContain('pa-sage');

    // Legacy forest with no cue: the family pick is seeded by the Bot id (same as everywhere else).
    const legacy = bot('bot_c7', { avatar: { color: 'forest' } });
    render(createElement(BotAvatar, { bot: legacy }));
    expect(classes()).toContain(`pa-${legacyToPlant(legacy.avatar, null, legacy.id)}`);
  });

  it('is decorative and static in rows; a hero size may idle', () => {
    render(createElement(BotAvatar, { bot: bot('bot_a'), size: 'xs' }));
    expect(host.querySelector('.pa-root')!.getAttribute('aria-hidden')).toBe('true');
    expect(svg().querySelector('.pa-mo')).toBeNull();
    render(createElement(BotAvatar, { bot: bot('bot_a'), size: 'lg', animate: false }));
    expect(svg().querySelector('.pa-mo')).toBeNull();
    render(createElement(BotAvatar, { bot: bot('bot_a'), size: 'lg' }));
    expect(svg().querySelector('.pa-mo')).not.toBeNull();
  });

  it('animates only while speaking, then morphs back to idle in place before going static', () => {
    vi.useFakeTimers();
    const ivy = bot('bot_ivy', { template_key: 'chief' });
    render(createElement(BotAvatar, { bot: ivy, speaking: true }));
    const speaking = svg();
    expect(speaking.getAttribute('data-state')).toBe('speaking');
    expect(speaking.querySelector('.pa-mo')).not.toBeNull();

    // Speaking stops: the same node morphs to idle (no rebuild into the static string yet).
    render(createElement(BotAvatar, { bot: ivy, speaking: false }));
    expect(svg()).toBe(speaking);
    expect(speaking.getAttribute('data-state')).toBe('idle');
    expect(classes()).toContain('pa-morph');

    // Once the morph has had time to land, the list avatar goes static.
    act(() => vi.advanceTimersByTime(PLANT_SETTLE_MS + 10));
    expect(svg()).not.toBe(speaking);
    expect(svg().querySelector('.pa-mo')).toBeNull();
    expect(classes()).toContain('pa-s-idle');
  });
});

describe('<BotAvatarStack/>', () => {
  it('overlaps compact 24px chips by 6px, keeps the speaking Bot first and sizes the +N chip', () => {
    const bots = [
      bot('bot_1', { template_key: 'chief' }),
      bot('bot_2', { template_key: 'writer' }),
      bot('bot_3', { template_key: 'analyst' }),
    ];
    render(createElement(BotAvatarStack, { bots, max: 2, size: 'xs', speakingId: 'bot_3' }));
    const stack = host.querySelector('[data-testid="plant-avatar-stack"]')!;
    const chips = [...stack.children] as HTMLElement[];
    expect(chips).toHaveLength(3);
    // The speaking Bot moves first (never covered) and is the only one moving.
    expect(chips[0]!.querySelector('svg')!.getAttribute('class')).toContain('pa-clover');
    expect(chips[0]!.querySelector('.pa-mo')).not.toBeNull();
    expect(chips[1]!.querySelector('.pa-mo')).toBeNull();
    expect(chips[1]!.style.marginLeft).toBe('-6px');
    expect(chips[1]!.querySelector('svg')!.getAttribute('class')).toContain('pa-lod-glyph');
    // +1, as tall as the avatars (the old chip was a fixed h-5).
    expect(chips[2]!.textContent).toBe('+1');
    expect(chips[2]!.style.height).toBe('24px');
  });
});
