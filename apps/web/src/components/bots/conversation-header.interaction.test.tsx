/**
 * @vitest-environment happy-dom
 *
 * A Bot's face and name are the way to its profile (who it is, what it
 * remembers): the DM header opens the owner's profile, a group header opens the
 * info panel, and a speaker header in the transcript opens that speaker.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { ConversationHeader } from './conversation-header';
import { SpeakerHeader } from './transcript-rows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bot(id: string, name: string): BotView {
  return {
    id,
    name,
    role: 'Researcher',
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const sage = bot('bot_sage', 'Sage');
const fern = bot('bot_fern', 'Fern');

function conversation(kind: 'direct' | 'group'): BotConversationDetail {
  return {
    session_id: 's1',
    kind,
    title: kind === 'direct' ? null : 'Launch prep',
    owner_bot_id: kind === 'direct' ? sage.id : null,
    lead_bot_id: sage.id,
    description: '',
    allow_bot_chat: true,
    members: [],
    last_activity_at: '2026-10-05T00:00:00.000Z',
    created_at: '2026-10-05T00:00:00.000Z',
  } as unknown as BotConversationDetail;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderHeader(kind: 'direct' | 'group') {
  const onOpenProfile = vi.fn();
  const onOpenInfo = vi.fn();
  act(() =>
    root.render(
      <I18nProvider initialLocale="en">
        <ConversationHeader
          title={kind === 'direct' ? 'Sage' : 'Launch prep'}
          conversation={conversation(kind)}
          owner={kind === 'direct' ? sage : undefined}
          members={[sage, fern]}
          speakingId={null}
          status={{ text: 'Ready when you are', tone: 'idle' }}
          computerPhase={null}
          activePane={null}
          canInvite
          onInvite={vi.fn()}
          onOpenComputer={vi.fn()}
          onOpenInfo={onOpenInfo}
          onOpenProfile={onOpenProfile}
        />
      </I18nProvider>,
    ),
  );
  return { onOpenProfile, onOpenInfo };
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].filter((el) => el.getAttribute('aria-label') === label);

describe('Bot identity entry points', () => {
  it("opens the DM Bot's profile from its face and from its name", () => {
    const { onOpenProfile, onOpenInfo } = renderHeader('direct');
    const [face, name] = button("Open Sage's profile");
    expect(face).toBeDefined();
    expect(name?.closest('h2')).not.toBeNull();
    act(() => face!.click());
    act(() => name!.click());
    expect(onOpenProfile).toHaveBeenCalledTimes(2);
    expect(onOpenProfile).toHaveBeenCalledWith(sage.id);
    expect(onOpenInfo).not.toHaveBeenCalled();
  });

  it('opens the info panel from a group header', () => {
    const { onOpenProfile, onOpenInfo } = renderHeader('group');
    act(() => button('Conversation info')[0]!.click());
    expect(onOpenInfo).toHaveBeenCalledTimes(1);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('opens a speaker from its transcript header, and stays plain text for an unknown Bot', () => {
    const onOpenProfile = vi.fn();
    act(() =>
      root.render(
        <I18nProvider initialLocale="en">
          <SpeakerHeader bot={fern} fallbackName="Fern" onOpenProfile={onOpenProfile} />
          <SpeakerHeader bot={undefined} fallbackName="Deleted Bot" onOpenProfile={onOpenProfile} />
        </I18nProvider>,
      ),
    );
    act(() => button("Open Fern's profile")[0]!.click());
    expect(onOpenProfile).toHaveBeenCalledWith(fern.id);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
});
