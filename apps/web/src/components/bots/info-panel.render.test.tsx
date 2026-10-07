/** @vitest-environment happy-dom */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BotConversationDetail, BotView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { InfoPanel } from './info-panel';

function bot(id: string, name: string): BotView {
  return {
    id,
    name,
    role: '',
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    description: '',
    tools: null,
    max_steps: null,
    lifecycle_status: 'draft',
    lifecycle_note: null,
    is_shared: false,
    current_version: 1,
    published_version: null,
    next_review_at: null,
    forked_from: null,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const FERN = bot('bot_fern', 'Fern');
const IVY = bot('bot_ivy', 'Ivy');

function group(lead: string | null): BotConversationDetail {
  return {
    session_id: 'grp-1',
    kind: 'group',
    title: 'Launch',
    owner_bot_id: null,
    lead_bot_id: lead,
    members: [
      { bot_id: FERN.id, role: 'member', position: 1 },
      { bot_id: IVY.id, role: 'member', position: 2 },
    ],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-05T00:00:00.000Z',
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
  };
}

function render(conversation: BotConversationDetail) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InfoPanel
        conversation={conversation}
        onConversationChange={vi.fn()}
        members={[FERN, IVY]}
        lookup={(id) => [FERN, IVY].find((candidate) => candidate.id === id)}
        busy={false}
        onOpenProfile={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('InfoPanel lead picker', () => {
  it('says there is no lead (instead of faking the first member) after the lead was archived', () => {
    const html = render(group('bot_archived'));
    expect(html).toMatch(/<option value="" disabled="" selected="">No lead yet — pick one<\/option>/);
    // Every member is a real choice, so picking Fern fires a change.
    expect(html).toContain('<option value="bot_fern">Fern</option>');
  });

  it('shows the actual lead without the placeholder', () => {
    const html = render(group(IVY.id));
    expect(html).not.toContain('No lead yet');
    expect(html).toContain('<option value="bot_ivy" selected="">Ivy</option>');
  });
});

describe('InfoPanel row actions', () => {
  it('reveal on keyboard focus, not only on hover', () => {
    const conversation = group(IVY.id);
    // Three members: a non-lead one can be removed, so its row has the action.
    conversation.members.push({ bot_id: 'bot_sage', role: 'member', position: 3 });
    const html = render(conversation);
    expect(html).toContain('aria-label="Remove from conversation"');
    expect(html).toContain('group-focus-within:opacity-100');
    expect(html).toContain('focus-within:opacity-100');
  });
});
