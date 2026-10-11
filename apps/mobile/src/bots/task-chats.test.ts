/**
 * Task chats on the phone (./task-chats.ts — spec docs/specs/20261011-agent-first-class.md §5a):
 * who can reply, titles, the new chat's Agent, how a failed create reads, the first-send handoff,
 * what edit / answer again go back to, and lines that link to another chat. Root vitest, no React
 * Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotMessage, BotView } from '../shared/bots';
import {
  chatBotId,
  clearFirstSends,
  conversationCanReply,
  editedContent,
  isAgentChatRow,
  isTaskChat,
  linkedChat,
  noteTaskChatsUnsupported,
  putFirstSend,
  rewindRefusalKey,
  rewindTarget,
  takeFirstSend,
  taskChatFailure,
  taskChatsSupported,
  threadTitle,
  transcriptKind,
} from './task-chats';
import { bot, conversation, message } from './thread/test-fakes';

const COPY = {
  unknownBot: 'Deleted Agent',
  group: 'Group',
  archived: (name: string) => `${name} (archived)`,
  chat: 'New chat',
  room: { me: 'u_me', untitled: 'Just You' },
};

const summary = (partial: Partial<BotConversationSummary>): BotConversationSummary => conversation('s1', partial);
const directory = (...bots: BotView[]) => new Map(bots.map((b) => [b.id, b]));

describe('replying and titles', () => {
  it('a task chat is replyable while its Agent is active; DMs and old groups keep the web’s rule', () => {
    const active = new Set(['bot_a']);
    expect(conversationCanReply(summary({ kind: 'task', owner_bot_id: 'bot_a' }), active)).toBe(true);
    expect(conversationCanReply(summary({ kind: 'task', owner_bot_id: 'bot_gone' }), active)).toBe(false);
    expect(conversationCanReply(summary({ kind: 'task', owner_bot_id: null }), active)).toBe(false);
    expect(conversationCanReply(summary({ kind: 'direct', owner_bot_id: 'bot_a' }), active)).toBe(true);
    expect(conversationCanReply(summary({ kind: 'group', owner_bot_id: 'bot_a' }), active)).toBe(false);
    // a room (P5) is people talking: open for as long as the member is in it
    expect(conversationCanReply(summary({ kind: 'room', owner_bot_id: null }), active)).toBe(true);
    expect(isTaskChat(summary({ kind: 'task' }))).toBe(true);
    expect(isTaskChat(null)).toBe(false);
  });

  it('reads like a DM in the transcript (its Agent speaks under the title)', () => {
    expect(transcriptKind('task')).toBe('direct');
    expect(transcriptKind('direct')).toBe('direct');
    expect(transcriptKind('group')).toBe('group');
    // a room names every speaker and puts other people on their side
    expect(transcriptKind('room')).toBe('room');
  });

  it('is called by its own title, else "New chat" — never by its Agent’s name', () => {
    const bots = directory(bot('bot_a', { name: 'Sage' }));
    expect(threadTitle(summary({ kind: 'task', title: '  Q3 plan ' }), bots, COPY)).toBe('Q3 plan');
    expect(threadTitle(summary({ kind: 'task', title: null }), bots, COPY)).toBe('New chat');
    expect(threadTitle(summary({ kind: 'task', title: '   ' }), bots, COPY)).toBe('New chat');
    // a DM still goes by its Agent
    expect(threadTitle(summary({ kind: 'direct', title: null }), bots, COPY)).toBe('Sage');
    // a room: its title, else everyone but the reader
    const people = [
      { user_id: 'u_me', nickname: 'Me', role: 'owner' as const, joined_at: '' },
      { user_id: 'u_ana', nickname: 'Ana', role: 'member' as const, joined_at: '' },
    ];
    const room = summary({ kind: 'room', owner_bot_id: null, members: [], participants: people });
    expect(threadTitle(room, bots, COPY)).toBe('Ana');
    expect(threadTitle({ ...room, title: 'Launch' }, bots, COPY)).toBe('Launch');
    expect(threadTitle({ ...room, participants: people.slice(0, 1) }, bots, COPY)).toBe('Just You');
  });
});

describe('starting one', () => {
  it('takes the Agent from the new chat’s profile (pinned versions too); Sprouty is the server’s default', () => {
    expect(chatBotId('bot:bot_a')).toBe('bot_a');
    expect(chatBotId('bot:bot_a@3')).toBe('bot_a');
    expect(chatBotId('sprouty')).toBeNull();
    expect(chatBotId('')).toBeNull();
    expect(chatBotId(undefined)).toBeNull();
    expect(chatBotId('bot:')).toBeNull();
  });

  it('tells an older server (400, no code) from a gone Agent and a plain failure', () => {
    expect(taskChatFailure({ status: 400, code: null })).toBe('unsupported');
    expect(taskChatFailure({ status: 404, code: 'bot_not_found' })).toBe('agent_gone');
    expect(taskChatFailure({ status: 400, code: 'bot_archived' })).toBe('agent_gone');
    expect(taskChatFailure({ status: 400, code: 'something_else' })).toBe('failed');
    expect(taskChatFailure({ status: 0, code: null })).toBe('failed');
    expect(taskChatFailure({ status: 500, code: null })).toBe('failed');
  });

  it('remembers a station without task chats for the app run — others keep them', () => {
    expect(taskChatsSupported('st-old')).toBe(true);
    noteTaskChatsUnsupported('st-old');
    expect(taskChatsSupported('st-old')).toBe(false);
    expect(taskChatsSupported('st-new')).toBe(true);
  });

  it('hands the first message to its thread once', () => {
    const first = {
      input: { text: 'Plan Q3', images: [{ id: 'i1', url: '/api/upload/i1' }], mentions: [] },
      images: [],
    };
    putFirstSend('t1', first);
    expect(takeFirstSend('t2')).toBeNull();
    expect(takeFirstSend('t1')).toEqual(first);
    expect(takeFirstSend('t1')).toBeNull();
    putFirstSend('t3', first);
    clearFirstSends();
    expect(takeFirstSend('t3')).toBeNull();
  });
});

describe('edit / answer again', () => {
  const user = (seq: number, partial: Partial<BotMessage> = {}) =>
    message(seq, { id: `u${seq}`, role: 'user', bot_id: null, content: `ask ${seq}`, ...partial });
  const reply = (seq: number, partial: Partial<BotMessage> = {}) => message(seq, { id: `r${seq}`, ...partial });
  const at = (
    messages: BotMessage[],
    o: { kind?: 'task' | 'direct' | 'group'; readOnly?: boolean; busy?: boolean } = {},
  ) => rewindTarget({ kind: o.kind ?? 'task', messages, readOnly: o.readOnly ?? false, busy: o.busy ?? false });

  it('goes back to the last member message; Regenerate sits on the last reply after it', () => {
    const rows = [
      user(1),
      reply(2),
      user(3),
      reply(4),
      message(5, { id: 'e5', role: 'system', bot_event: { kind: 'stopped', bot_id: 'bot_a' } }),
      reply(6),
    ];
    expect(at(rows)).toEqual({ memberId: 'u3', editable: true, replyId: 'r6' });
  });

  it('skips event rows and greetings when looking for the reply; none → only the edit', () => {
    const greeting = reply(1, { bot_event: { kind: 'greeting', bot_id: 'bot_a' } });
    expect(at([greeting, user(2)])).toEqual({ memberId: 'u2', editable: true, replyId: null });
    const line = message(3, {
      id: 'e3',
      role: 'system',
      bot_event: { kind: 'turn_error', bot_id: 'bot_a', error: 'x' },
    });
    expect(at([user(2), line])).toEqual({ memberId: 'u2', editable: true, replyId: null });
  });

  it('a member row carrying an event is answered again but not edited (it is no bubble)', () => {
    const event = user(2, { bot_event: { kind: 'stopped', bot_id: 'bot_a' } });
    expect(at([user(1), event, reply(3)])).toEqual({ memberId: 'u2', editable: false, replyId: 'r3' });
  });

  it('only in a task chat, only from rest, only where someone can reply', () => {
    const rows = [user(1), reply(2)];
    expect(at(rows, { kind: 'direct' })).toBeNull();
    expect(at(rows, { kind: 'group' })).toBeNull();
    expect(at(rows, { busy: true })).toBeNull();
    expect(at(rows, { readOnly: true })).toBeNull();
    expect(rewindTarget({ kind: null, messages: rows, readOnly: false, busy: false })).toBeNull();
    expect(at([reply(1)])).toBeNull();
  });

  it('keeps the message’s file fences under an edit', () => {
    const fence = '```attachments\n[{"id":"f1","name":"q3.xlsx"}]\n```';
    expect(editedContent(`Summarize this\n\n${fence}`, '  Summarize this, briefly ')).toBe(
      `Summarize this, briefly\n\n${fence}`,
    );
    expect(editedContent('plain', 'new text')).toBe('new text');
    const legacy = '```mission-attachments\n[]\n```';
    expect(editedContent(`a\n${fence}\n${legacy}`, 'b')).toBe(`b\n\n${fence}\n\n${legacy}`);
  });

  it('explains a refused rewind by the server’s code', () => {
    expect(rewindRefusalKey('busy')).toBe('bots.thread.rewindBusy');
    expect(rewindRefusalKey('not_last')).toBe('bots.thread.rewindNotLast');
    expect(rewindRefusalKey('requests_pending')).toBe('bots.thread.rewindCards');
    expect(rewindRefusalKey('not_task_chat')).toBeNull();
    expect(rewindRefusalKey(null)).toBeNull();
  });
});

describe('links between chats', () => {
  it('chat_opened → the new chat; chat_origin → where it came from; anything else → none', () => {
    expect(linkedChat({ kind: 'chat_opened', session_id: 't9', bot_id: 'bot_a', title: 'Q3' })).toEqual({
      c: 't9',
      title: 'Q3',
    });
    expect(linkedChat({ kind: 'chat_origin', from_session_id: 'dm1', bot_id: 'bot_a' })).toEqual({
      c: 'dm1',
      title: '',
    });
    expect(linkedChat({ kind: 'stopped', bot_id: 'bot_a' })).toBeNull();
    expect(linkedChat(null)).toBeNull();
  });

  it('a chats-list row with channel bots (or agent_chat) is a task chat', () => {
    expect(isAgentChatRow({ channel: 'bots', agent_chat: { bot_id: 'bot_a' } })).toBe(true);
    expect(isAgentChatRow({ channel: 'web' })).toBe(false);
    expect(isAgentChatRow({})).toBe(false);
  });
});
