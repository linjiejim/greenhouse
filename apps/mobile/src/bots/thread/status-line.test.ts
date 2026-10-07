/**
 * The thread's status line and title pose (./status-line.ts): every rung of the priority
 * ladder, and what each rung yields to. Root vitest, pure fixtures — no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationDetail, BotRequestView, BotView } from '../../shared/bots';
import type { BotStreamSegment } from '../../shared/bots-wire';
import type { ThreadRun } from '../contract';
import { latestPending, statusLine, talkingSegment, threadReadOnly, titlePose, type StatusInput } from './status-line';

function bot(id: string, partial: Partial<BotView> = {}): BotView {
  return {
    id,
    name: id,
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

const SAGE = bot('b_sage', { name: 'Sage', role: 'Researcher' });
const FERN = bot('b_fern', { name: 'Fern', role: 'Writer' });
const OLD = bot('b_old', { name: 'Old', status: 'archived' });
const BY_ID: Record<string, BotView> = { [SAGE.id]: SAGE, [FERN.id]: FERN, [OLD.id]: OLD };

function conversation(partial: Partial<BotConversationDetail> = {}): BotConversationDetail {
  return {
    session_id: 's1',
    kind: 'direct',
    title: null,
    owner_bot_id: SAGE.id,
    lead_bot_id: SAGE.id,
    members: [{ bot_id: SAGE.id, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T00:00:00.000Z',
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests: [],
    context: { estimated_tokens: 0, threshold: 1 },
    ...partial,
  };
}

const GROUP = conversation({
  kind: 'group',
  owner_bot_id: null,
  lead_bot_id: FERN.id,
  members: [
    { bot_id: FERN.id, role: 'lead', position: 0 },
    { bot_id: SAGE.id, role: 'member', position: 1 },
  ],
});

function request(id: string, partial: Partial<BotRequestView> = {}): BotRequestView {
  return {
    id,
    session_id: 's1',
    bot_id: SAGE.id,
    kind: 'approval',
    status: 'pending',
    payload: { action: 'tool_call', title: 'Send mail', details: [], allow_always: false },
    result: null,
    expires_at: null,
    created_at: '2026-10-08T10:00:00.000Z',
    ...partial,
  };
}

function segment(partial: Partial<BotStreamSegment> = {}): BotStreamSegment {
  return { botId: SAGE.id, reason: 'user', status: 'streaming', text: '', reasoning: '', toolCalls: [], ...partial };
}

function run(segments: BotStreamSegment[], partial: Partial<ThreadRun> = {}): ThreadRun {
  return {
    key: 's1:r1',
    runId: 'r1',
    segments,
    revealing: -1,
    requests: [],
    interrupting: false,
    replaying: false,
    ...partial,
  };
}

function input(snap: Partial<StatusInput['snap']> = {}, kind: 'direct' | 'group' = 'direct'): StatusInput {
  return {
    snap: {
      conversation: kind === 'group' ? GROUP : conversation(),
      readOnly: null,
      requests: new Map(),
      stopPhase: null,
      run: null,
      runActive: false,
      ...snap,
    },
    byId: BY_ID,
    kind,
  };
}

const requests = (...list: BotRequestView[]) => new Map(list.map((r) => [r.id, r]));

describe('statusLine', () => {
  it('idle DM: the Bot’s role, else a neutral line', () => {
    expect(statusLine(input())).toEqual({ key: 'bots.status.role', vars: { role: 'Researcher' } });
    const roleless = { ...BY_ID, [SAGE.id]: { ...SAGE, role: '  ' } };
    expect(statusLine({ ...input(), byId: roleless })).toEqual({ key: 'bots.status.idle' });
    expect(statusLine(input({ conversation: null }))).toEqual({ key: 'bots.status.idle' });
  });

  it('idle group: size and lead (active members only), size alone without a known lead', () => {
    expect(statusLine(input({}, 'group'))).toEqual({ key: 'bots.status.group', vars: { n: 2, name: 'Fern' } });
    const withArchived = conversation({
      ...GROUP,
      lead_bot_id: 'b_unknown',
      members: [...GROUP.members, { bot_id: OLD.id, role: 'member', position: 2 }],
    });
    expect(statusLine(input({ conversation: withArchived }, 'group'))).toEqual({
      key: 'bots.status.groupCount',
      vars: { n: 2 },
    });
  });

  it('busy without a segment: Working…', () => {
    expect(statusLine(input({ runActive: true }))).toEqual({ key: 'bots.status.working' });
  });

  it('a DM owner thinks / replies unnamed; a group (or a DM guest) is named', () => {
    expect(statusLine(input({ run: run([segment()]), runActive: true }))).toEqual({ key: 'bots.status.thinkingDm' });
    expect(statusLine(input({ run: run([segment({ text: 'Hi' })]), runActive: true }))).toEqual({
      key: 'bots.status.replyingDm',
    });
    const guest = segment({ botId: FERN.id, text: 'Hi' });
    expect(statusLine(input({ run: run([guest]), runActive: true }))).toEqual({
      key: 'bots.status.replying',
      vars: { name: 'Fern' },
    });
    expect(statusLine(input({ run: run([segment()]), runActive: true }, 'group'))).toEqual({
      key: 'bots.status.thinking',
      vars: { name: 'Sage' },
    });
  });

  it('a running tool call: browsing a host (complete url only), the computer, a hand-off, other work', () => {
    const call = (name: string, inputText: string) =>
      segment({ text: 'x', toolCalls: [{ id: 'c1', name, input: inputText, status: 'calling' }] });
    const at = (s: BotStreamSegment) => statusLine(input({ run: run([s]), runActive: true }));
    expect(at(call('browser', '{"action":"open","url":"https://github.com/x"}'))).toEqual({
      key: 'bots.status.browsing',
      vars: { host: 'github.com' },
    });
    expect(at(call('browser', '{"action":"open","url":"https://git'))).toEqual({ key: 'bots.status.computer' });
    expect(at(call('computer', '{}'))).toEqual({ key: 'bots.status.computer' });
    expect(at(call('team', '{"action":"ask"}'))).toEqual({ key: 'bots.status.handoff' });
    expect(at(call('knowledge', '{}'))).toEqual({ key: 'bots.status.working' });
    // a finished call is not "working" any more
    const done = segment({ text: 'x', toolCalls: [{ id: 'c1', name: 'browser', input: '{}', status: 'done' }] });
    expect(at(done)).toEqual({ key: 'bots.status.replyingDm' });
  });

  it('the typing front speaks, not a later segment still waiting its turn', () => {
    const first = segment({ text: 'Typing', status: 'completed' });
    const second = segment({ botId: FERN.id, text: '' });
    expect(statusLine(input({ run: run([first, second], { revealing: 0 }), runActive: true }, 'group'))).toEqual({
      key: 'bots.status.replying',
      vars: { name: 'Sage' },
    });
    expect(talkingSegment(run([first, second]))).toBe(second);
    expect(talkingSegment(null)).toBeNull();
  });

  it('a stop on its way beats the speaking segment', () => {
    const live = { run: run([segment({ text: 'x' })]), runActive: true };
    expect(statusLine(input({ ...live, stopPhase: 'soft' }))).toEqual({ key: 'bots.status.stopping' });
    expect(statusLine(input({ ...live, run: run([segment()], { interrupting: true }) }))).toEqual({
      key: 'bots.status.stopping',
    });
    expect(statusLine(input({ ...live, stopPhase: 'hard' }))).toEqual({ key: 'bots.status.stoppingNow' });
  });

  it('the newest pending card beats a stop, by kind', () => {
    const at = (r: BotRequestView) =>
      statusLine(input({ requests: requests(r), stopPhase: 'soft', run: run([segment()]), runActive: true }));
    expect(at(request('a'))).toEqual({ key: 'bots.status.waitApproval' });
    expect(at(request('l', { kind: 'login' }))).toEqual({ key: 'bots.status.waitLogin' });
    expect(at(request('i', { kind: 'takeover', payload: { implicit: true, reason: 'waiting' } }))).toEqual({
      key: 'bots.status.waitHandback',
    });
    expect(at(request('c', { kind: 'takeover', payload: { reason: 'r', kind: 'captcha', url: null } }))).toEqual({
      key: 'bots.status.waitHuman',
    });
    expect(at(request('o', { kind: 'takeover', payload: { reason: 'r', kind: 'other', url: null } }))).toEqual({
      key: 'bots.status.waitConfirm',
    });
    expect(at(request('t', { kind: 'task_start', payload: { title: 'T', brief: 'B' } }))).toEqual({
      key: 'bots.status.waitConfirm',
    });
  });

  it('only pending cards count, and the newest wins', () => {
    const older = request('old', { kind: 'login', created_at: '2026-10-08T09:00:00.000Z' });
    const newer = request('new', { created_at: '2026-10-08T11:00:00.000Z' });
    const settled = request('done', { status: 'resolved', created_at: '2026-10-08T12:00:00.000Z' });
    expect(latestPending(requests(newer, older, settled))).toBe(newer);
    expect(statusLine(input({ requests: requests(settled) }))).toEqual({
      key: 'bots.status.role',
      vars: { role: 'Researcher' },
    });
  });

  it('read-only beats everything', () => {
    const busy = { requests: requests(request('a')), run: run([segment()]), runActive: true };
    expect(statusLine(input({ ...busy, readOnly: 'bot_archived' }))).toEqual({ key: 'bots.status.archived' });
    expect(statusLine(input({ ...busy, readOnly: 'no_active_members' }, 'group'))).toEqual({
      key: 'bots.status.noReplier',
    });
    // the directory says so too
    expect(statusLine(input({ ...busy, conversation: conversation({ owner_bot_id: OLD.id }) }))).toEqual({
      key: 'bots.status.archived',
    });
  });
});

describe('threadReadOnly', () => {
  it('an archived DM owner; a group with nobody active', () => {
    expect(threadReadOnly({ conversation: conversation({ owner_bot_id: OLD.id }), readOnly: null }, BY_ID)).toBe(
      'bot_archived',
    );
    const deadGroup = conversation({ ...GROUP, members: [{ bot_id: OLD.id, role: 'lead', position: 0 }] });
    expect(threadReadOnly({ conversation: deadGroup, readOnly: null }, BY_ID)).toBe('no_active_members');
    expect(threadReadOnly({ conversation: GROUP, readOnly: null }, BY_ID)).toBeNull();
  });

  it('an id the directory has not answered for is "not loaded", never archived', () => {
    expect(threadReadOnly({ conversation: conversation({ owner_bot_id: 'b_new' }), readOnly: null }, BY_ID)).toBeNull();
    const partlyKnown = conversation({
      ...GROUP,
      members: [
        { bot_id: OLD.id, role: 'lead', position: 0 },
        { bot_id: 'b_new', role: 'member', position: 1 },
      ],
    });
    expect(threadReadOnly({ conversation: partlyKnown, readOnly: null }, BY_ID)).toBeNull();
    expect(threadReadOnly({ conversation: null, readOnly: null }, {})).toBeNull();
  });

  it('the server’s answer to a send wins', () => {
    expect(threadReadOnly({ conversation: conversation(), readOnly: 'no_active_members' }, BY_ID)).toBe(
      'no_active_members',
    );
  });
});

describe('titlePose', () => {
  it('follows the same ladder: asleep > waiting > speaking / thinking > busy > idle', () => {
    expect(titlePose(input({ readOnly: 'bot_archived', requests: requests(request('a')) }))).toBe('sleep');
    expect(titlePose(input({ requests: requests(request('a')), run: run([segment({ text: 'x' })]) }))).toBe('waiting');
    expect(titlePose(input({ run: run([segment({ text: 'x' })]), runActive: true }))).toBe('speaking');
    expect(titlePose(input({ run: run([segment()]), runActive: true }))).toBe('thinking');
    expect(titlePose(input({ runActive: true }))).toBe('speaking');
    expect(titlePose(input())).toBe('idle');
  });
});
