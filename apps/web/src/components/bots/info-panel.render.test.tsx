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
    connectors: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

const FERN = bot('bot_fern', 'Fern');
const IVY = bot('bot_ivy', 'Ivy');
const SAGE = bot('bot_sage', 'Sage');
const ALL = [FERN, IVY, SAGE];

function conversation(overrides: Partial<BotConversationDetail>): BotConversationDetail {
  return {
    session_id: 'dm-ivy',
    kind: 'direct',
    title: null,
    owner_bot_id: IVY.id,
    lead_bot_id: IVY.id,
    members: [
      { bot_id: IVY.id, role: 'owner', position: 0 },
      { bot_id: FERN.id, role: 'guest', position: 1 },
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
    ...overrides,
  };
}

/** A retired group chat — history only. */
const GROUP = conversation({
  session_id: 'grp-1',
  kind: 'group',
  title: 'Launch',
  owner_bot_id: null,
  description: 'Reply in English.',
  members: [
    { bot_id: IVY.id, role: 'lead', position: 0 },
    { bot_id: FERN.id, role: 'member', position: 1 },
    { bot_id: SAGE.id, role: 'member', position: 2 },
  ],
});

function render(value: BotConversationDetail) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InfoPanel
        conversation={value}
        onConversationChange={vi.fn()}
        lookup={(id) => ALL.find((candidate) => candidate.id === id)}
        busy={false}
        onOpenProfile={vi.fn()}
      />
    </I18nProvider>,
  );
}

/** One `<li>` per member, by name. */
function memberRows(html: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const [row] of html.matchAll(/<li[^>]*>.*?<\/li>/g)) {
    const name = ALL.find((candidate) => row.includes(`>${candidate.name}<`))?.name;
    if (name) rows[name] = row;
  }
  return rows;
}

/** Nothing about a conversation is configured any more: no switch, no group name / rules / lead. */
function expectNothingToConfigure(html: string) {
  expect(html).not.toContain('role="switch"');
  expect(html).not.toContain('Let Bots ask each other');
  expect(html).not.toMatch(/<(input|textarea|select)\b/);
  expect(html).not.toContain('Group rules');
  expect(html).not.toContain('Group name');
  expect(html).not.toContain('No lead yet');
  expect(html).not.toContain('Answers when nobody is @-mentioned');
}

describe('InfoPanel on a DM', () => {
  it('lists the Bot and its guests, tagged, and offers to send away only a guest', () => {
    const html = render(conversation({}));
    const rows = memberRows(html);
    expect(Object.keys(rows)).toEqual(['Ivy', 'Fern']);
    expect(rows.Ivy).toContain('>Owner<');
    expect(rows.Ivy).not.toContain('aria-label="Remove from conversation"');
    expect(rows.Fern).toContain('>Guest<');
    expect(rows.Fern).toContain('aria-label="Remove from conversation"');
  });

  it('has no Bot-to-Bot switch and no group sections — hand-offs are always allowed', () => {
    expectNothingToConfigure(render(conversation({})));
  });

  it('reveals row actions on keyboard focus, not only on hover', () => {
    const html = render(conversation({}));
    expect(html).toContain('group-focus-within:opacity-100');
    expect(html).toContain('focus-within:opacity-100');
  });
});

describe('InfoPanel on a retired group chat', () => {
  it('lists who was in it, read-only: no group sections, no switch, nobody to remove', () => {
    const html = render(GROUP);
    const rows = memberRows(html);
    expect(Object.keys(rows)).toEqual(['Ivy', 'Fern', 'Sage']);
    expect(rows.Ivy).toContain('>Lead<'); // the record says who led it — nothing to pick
    expect(rows.Fern).toContain('>Member<');
    expectNothingToConfigure(html);
    expect(html).not.toContain('Reply in English.');
    expect(html).not.toContain('aria-label="Remove from conversation"');
  });
});
