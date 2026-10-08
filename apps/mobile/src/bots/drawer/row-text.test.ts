/**
 * Drawer row copy (./row-text.ts): titles through the vendored conversationTitle,
 * previews that say who spoke, and no "Deleted Bot" before the Bot list answers.
 * Root vitest.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotView } from '../../shared/bots';
import { rowPreview, rowTime, rowTitle, type RowCopy, type RowDirectory } from './row-text';

const COPY: RowCopy = {
  deletedBot: 'Deleted Bot',
  untitledGroup: 'Group',
  archivedName: (name) => `${name} (archived)`,
  youSaid: (text) => `You: ${text}`,
  botSaid: (name, text) => `${name}: ${text}`,
  noMessages: 'No messages yet',
};

function bot(id: string, name: string, status: BotView['status'] = 'active'): BotView {
  return {
    id,
    name,
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status,
    dm_session_id: null,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const FERN = bot('b_fern', 'Fern');
const DANDY = bot('b_dandy', 'Dandy');
const SAGE = bot('b_sage', 'Sage', 'archived');
const DIR: RowDirectory = { byId: { b_fern: FERN, b_dandy: DANDY, b_sage: SAGE }, botsLoaded: true };
const NOT_LOADED: RowDirectory = { byId: {}, botsLoaded: false };

function dm(botId: string, last: BotConversationSummary['last_message'] = null): BotConversationSummary {
  return {
    session_id: `s_${botId}`,
    kind: 'direct',
    title: null,
    owner_bot_id: botId,
    lead_bot_id: botId,
    members: [{ bot_id: botId, role: 'owner', position: 0 }],
    last_message: last,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T09:00:00.000Z',
  };
}

function group(title: string | null, botIds: string[], last: BotConversationSummary['last_message'] = null) {
  return {
    ...dm(botIds[0]!, last),
    session_id: 's_group',
    kind: 'group' as const,
    title,
    owner_bot_id: null,
    members: botIds.map((id, position) => ({ bot_id: id, role: 'member' as const, position })),
  };
}

const said = (role: string, preview: string, botId: string | null = null) => ({
  preview,
  bot_id: botId,
  role,
  created_at: '2026-10-08T09:00:00.000Z',
});

describe('rowTitle', () => {
  it("is the DM Bot's name, marked when archived", () => {
    expect(rowTitle(dm('b_fern'), DIR, COPY)).toBe('Fern');
    expect(rowTitle(dm('b_sage'), DIR, COPY)).toBe('Sage (archived)');
  });

  it("is a group's title, else its roster", () => {
    expect(rowTitle(group('Writers', ['b_fern', 'b_dandy']), DIR, COPY)).toBe('Writers');
    expect(rowTitle(group(null, ['b_fern', 'b_dandy']), DIR, COPY)).toBe('Fern, Dandy');
    expect(rowTitle(group(null, ['b_gone']), DIR, COPY)).toBe('Group');
  });

  it('names a Bot missing from a loaded list as deleted', () => {
    expect(rowTitle(dm('b_gone'), DIR, COPY)).toBe('Deleted Bot');
  });

  it('is empty (a skeleton) until the Bot list answers — never "Deleted Bot"', () => {
    expect(rowTitle(dm('b_fern'), NOT_LOADED, COPY)).toBe('');
    expect(rowTitle(group(null, ['b_fern']), NOT_LOADED, COPY)).toBe('');
    // a group's own title needs no directory
    expect(rowTitle(group('Writers', ['b_fern']), NOT_LOADED, COPY)).toBe('Writers');
  });
});

describe('rowPreview', () => {
  it('says when nothing was said yet', () => {
    expect(rowPreview(dm('b_fern'), DIR, COPY)).toBe('No messages yet');
  });

  it("prefixes the member's own messages", () => {
    expect(rowPreview(dm('b_fern', said('user', 'hi there')), DIR, COPY)).toBe('You: hi there');
  });

  it("names the speaker in a group, not in the DM's own thread", () => {
    expect(rowPreview(group(null, ['b_fern', 'b_dandy'], said('assistant', 'draft ready', 'b_dandy')), DIR, COPY)).toBe(
      'Dandy: draft ready',
    );
    expect(rowPreview(dm('b_fern', said('assistant', 'done', 'b_fern')), DIR, COPY)).toBe('done');
  });

  it('marks a deleted speaker only once the list is in', () => {
    const row = group(null, ['b_fern'], said('assistant', 'hello', 'b_gone'));
    expect(rowPreview(row, DIR, COPY)).toBe('Deleted Bot: hello');
    expect(rowPreview(row, NOT_LOADED, COPY)).toBe('hello');
  });

  it('collapses whitespace onto one line', () => {
    expect(rowPreview(dm('b_fern', said('assistant', '  line one\n\nline   two ')), DIR, COPY)).toBe(
      'line one line two',
    );
  });
});

describe('rowTime', () => {
  const now = new Date(2026, 9, 8, 15, 30).getTime();
  const at = (d: number, h = 9, m = 5, y = 2026) => new Date(y, 9, d, h, m).getTime();

  it('today: the time of day; yesterday: the word; this week: the weekday', () => {
    expect(rowTime(at(8, 9, 5), now, 'en-US', 'Yesterday')).toBe('9:05 AM');
    expect(rowTime(at(7, 23, 59), now, 'en-US', 'Yesterday')).toBe('Yesterday');
    expect(rowTime(at(5), now, 'en-US', 'Yesterday')).toBe('Mon');
  });

  it('older: the date, with the year only when it isn’t this year; junk: empty', () => {
    expect(rowTime(at(1), now, 'en-US', 'Yesterday')).toBe('10/1');
    expect(rowTime(new Date(2025, 11, 31, 8).getTime(), now, 'en-US', 'Yesterday')).toBe('12/31/2025');
    expect(rowTime(Number.NaN, now, 'en-US', 'Yesterday')).toBe('');
  });
});
