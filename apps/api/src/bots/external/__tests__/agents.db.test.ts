/**
 * The member's Agents from outside Greenhouse (spec 20261011-agent-first-class P6, D48–D53)
 * against real PostgreSQL with a scripted model: who is reachable, a new task chat (own Agent) or
 * the member's DM (public Agent) opened with a line naming the caller, continuing by conversation
 * id, waiting then handing back a handle, a busy conversation that queues, cards that stay with
 * the member, and the tools existing only for an external caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { buildLazyServerTools } from '../../../agent-runtime/tool-resolution.js';
import type { AgentIdentity } from '../../../agent-runtime/api-auth.js';
import { executeProxyTool } from '../../../agent-runtime/tool-proxy.js';
import { composeMcpContext } from '../../../routes/mcp.js';
import { MUTATING_PROXY_ALLOWLIST, mcpToolIdsForGroups } from '../../../tools/registry.js';
import { chatRunRegistry } from '../../../chat/runs.js';
import { setBotsEngineDepsForTest } from '../../engine/deps.js';
import { _resetInboxStateForTest, setInboxToolRegistry } from '../../engine/inbox.js';
import { claimBotsRun, releaseBotsRun } from '../../engine/run-slot.js';
import { scriptedDeps, type BotScript, type CapturedTurn } from '../../engine/__tests__/scripted-model.js';
import { ensureSproutyBot } from '../../sprouty.js';
import {
  AgentAccessError,
  askAgent,
  callerLabel,
  listReachableAgents,
  matchAgentByName,
  readAgentConversation,
} from '../agents.js';
import { AGENT_ACCESS_TOOL_IDS } from '../meta.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let ivy: BotRow;
let helpdesk: BotRow;
let restoreDeps: (() => void) | null = null;
const caller = { label: 'Claude Code' };

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `ext-jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `ext-ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  ivy = await db.bots.createBot({ user_id: jim.id, name: 'Ivy', role: 'Researcher' });
  helpdesk = await db.bots.createBot({ user_id: ana.id, name: 'Helpdesk', role: 'IT support' });
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  setInboxToolRegistry(null);
  _resetInboxStateForTest();
  vi.restoreAllMocks();
});

function useScript(script: BotScript, captured: CapturedTurn[] = []) {
  restoreDeps = setBotsEngineDepsForTest({
    ...scriptedDeps(script, captured),
    generateTitle: async (message) => `Title: ${message.slice(0, 20)}`,
  });
}

async function publishHelpdeskToJim() {
  await db.bots.setPublication(ana.id, helpdesk.id, {
    visibility: 'public',
    published_version: 1,
    publication: JSON.stringify({ audience: { everyone: false, user_ids: [jim.id], group_ids: [] } }),
  });
}

async function settled(sessionId: string) {
  for (let i = 0; i < 100; i += 1) {
    if (!chatRunRegistry.getActive(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the run never ended');
}

describe('who is reachable', () => {
  it('lists the main Agent first, then own Agents, then public ones offered to the member', async () => {
    const before = await listReachableAgents(db, jim.id);
    expect(before.map((a) => [a.name, a.kind])).toEqual([
      [(await ensureSproutyBot(db, jim.id)).name, 'main'],
      ['Ivy', 'own'],
    ]);
    await publishHelpdeskToJim();
    const after = await listReachableAgents(db, jim.id);
    expect(after.at(-1)).toMatchObject({ id: helpdesk.id, name: 'Helpdesk', kind: 'public', owner: 'Ana' });
    // Ana is not in her own Agent's audience list as a "public" entry: it is simply hers.
    expect((await listReachableAgents(db, ana.id)).find((a) => a.id === helpdesk.id)?.kind).toBe('own');
  });

  it('matches an Agent by the start of a message: whole names only, the longest one wins', async () => {
    await db.bots.createBot({ user_id: jim.id, name: 'Ivy Pro', role: '' });
    expect(await matchAgentByName(db, jim.id, 'Ivy Pro, check this')).toMatchObject({
      agent: { name: 'Ivy Pro' },
      rest: 'check this',
    });
    expect(await matchAgentByName(db, jim.id, 'ivy：look')).toMatchObject({ agent: { name: 'Ivy' }, rest: 'look' });
    expect(await matchAgentByName(db, jim.id, 'Ivyleague')).toBeNull();
  });
});

describe('asking an Agent from outside', () => {
  it('opens a task chat named after the caller, answers, and continues by conversation id', async () => {
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'Three vendors fit.' }], [{ text: 'Vendor B is cheapest.' }]] }, captured);
    const first = await askAgent({
      db,
      userId: jim.id,
      agentId: ivy.id,
      message: 'Which vendors fit?',
      caller,
      waitMs: 10_000,
    });
    expect(first).toMatchObject({
      agent: { id: ivy.id, name: 'Ivy' },
      status: 'answered',
      replies: [{ agent_id: ivy.id, agent: 'Ivy', text: 'Three vendors fit.' }],
      needs_you: [],
    });
    const conversation = await db.bots.getConversation(jim.id, first.conversation_id);
    expect(conversation).toMatchObject({ kind: 'task', owner_bot_id: ivy.id });
    const page = await db.sessions.getMessagePage(first.conversation_id, { limit: 10 });
    expect(page.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'Started from Claude Code'],
      ['user', 'Which vendors fit?'],
      ['assistant', 'Three vendors fit.'],
    ]);
    expect(JSON.parse(page.messages[0]!.bot_event!)).toEqual({ kind: 'external_origin', via: 'Claude Code' });
    // Plain text for the other side: no Rich Output blocks taught.
    expect(captured[0]!.input.systemPrompt).not.toContain('mermaid');

    const second = await askAgent({
      db,
      userId: jim.id,
      conversationId: first.conversation_id,
      message: 'And the cheapest?',
      caller,
      waitMs: 10_000,
    });
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(second.replies.map((r) => r.text)).toEqual(['Vendor B is cheapest.']);
    // One origin line, not one per message.
    const all = await db.sessions.getMessagePage(first.conversation_id, { limit: 10 });
    expect(all.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('defaults to the main Agent, and a public Agent answers in the member’s own DM with it', async () => {
    const sprouty = await ensureSproutyBot(db, jim.id);
    await publishHelpdeskToJim();
    useScript({ [sprouty.name]: [[{ text: 'On it.' }]], Helpdesk: [[{ text: 'Restart the router.' }]] });
    const main = await askAgent({ db, userId: jim.id, message: 'Hello', caller, waitMs: 10_000 });
    expect(main.agent.id).toBe(sprouty.id);
    expect((await db.bots.getConversation(jim.id, main.conversation_id))?.kind).toBe('task');

    const shared = await askAgent({
      db,
      userId: jim.id,
      agentId: helpdesk.id,
      message: 'The wifi is down',
      caller,
      waitMs: 10_000,
    });
    expect(shared).toMatchObject({ status: 'answered', replies: [{ text: 'Restart the router.' }] });
    const dm = await db.bots.getConversation(jim.id, shared.conversation_id);
    expect(dm).toMatchObject({ kind: 'direct', owner_bot_id: helpdesk.id, user_id: jim.id });
    // Its greeting is not a reply to the caller.
    expect(shared.replies).toHaveLength(1);
  });

  it('refuses what the member could not reach in the app', async () => {
    const code = async (work: Promise<unknown>) => {
      try {
        await work;
        return 'ok';
      } catch (error) {
        return error instanceof AgentAccessError ? error.code : String(error);
      }
    };
    // Someone else's unpublished Agent, a conversation that is not theirs, a mismatched Agent.
    expect(await code(askAgent({ db, userId: jim.id, agentId: helpdesk.id, message: 'x', caller, waitMs: 0 }))).toBe(
      'not_found',
    );
    const anas = await db.bots.createTaskConversation(ana.id, helpdesk.id);
    expect(
      await code(askAgent({ db, userId: jim.id, conversationId: anas.session_id, message: 'x', caller, waitMs: 0 })),
    ).toBe('not_found');
    expect(await code(readAgentConversation({ db, userId: jim.id, conversationId: anas.session_id }))).toBe(
      'not_found',
    );
    const mine = await db.bots.createTaskConversation(jim.id, ivy.id);
    const sprouty = await ensureSproutyBot(db, jim.id);
    expect(
      await code(
        askAgent({
          db,
          userId: jim.id,
          agentId: sprouty.id,
          conversationId: mine.session_id,
          message: 'x',
          caller,
          waitMs: 0,
        }),
      ),
    ).toBe('invalid');
    await db.bots.archiveBot(jim.id, ivy.id);
    expect(await code(askAgent({ db, userId: jim.id, agentId: ivy.id, message: 'x', caller, waitMs: 0 }))).toBe(
      'unavailable',
    );
  });

  it('hands back a handle when the reply takes longer than the wait, readable once it lands', async () => {
    useScript({ Ivy: [[{ text: 'Done reading.' }]] });
    const started = await askAgent({ db, userId: jim.id, agentId: ivy.id, message: 'Read it all', caller, waitMs: 0 });
    expect(started.status).toBe('working');
    await settled(started.conversation_id);
    const read = await readAgentConversation({ db, userId: jim.id, conversationId: started.conversation_id });
    expect(read).toMatchObject({ status: 'answered', replies: [{ text: 'Done reading.' }] });
    // after_message_id pages past what the caller already has.
    const later = await readAgentConversation({
      db,
      userId: jim.id,
      conversationId: started.conversation_id,
      afterMessageId: read.replies[0]!.message_id,
    });
    expect(later.replies).toEqual([]);
  });

  it('queues behind a running conversation instead of starting a second run', async () => {
    const chat = await db.bots.createTaskConversation(jim.id, ivy.id);
    const held = (await claimBotsRun(db, chat.session_id, jim.id))!;
    try {
      const queued = await askAgent({
        db,
        userId: jim.id,
        conversationId: chat.session_id,
        message: 'Also this',
        caller,
        waitMs: 0,
      });
      expect(queued.status).toBe('working');
      const inbox = await db.bots.listPendingInbox(chat.session_id);
      expect(inbox.map((row) => row.kind)).toEqual(['user_message']);
    } finally {
      await releaseBotsRun(db, held);
    }
  });

  it('reports cards waiting for the member instead of acting on them', async () => {
    const chat = await db.bots.createTaskConversation(jim.id, ivy.id);
    await db.bots.createRequest({
      user_id: jim.id,
      session_id: chat.session_id,
      bot_id: ivy.id,
      kind: 'approval',
      payload: { action: 'tool_call', title: 'Edit the handbook', summary: 'edit the knowledge base', fields: [] },
    });
    const read = await readAgentConversation({ db, userId: jim.id, conversationId: chat.session_id });
    expect(read).toMatchObject({
      status: 'needs_you',
      needs_you: [{ kind: 'approval', summary: 'edit the knowledge base' }],
    });
  });
});

describe('the caller label', () => {
  it('is one short plain line: a client cannot put markdown into the member’s transcript', () => {
    expect(callerLabel('Claude Code')).toBe('Claude Code');
    expect(callerLabel('[Click me](https://evil.example)\n**now**')).toBe('Click mehttps://evil.example now');
    expect(callerLabel('   ')).toBe('an outside app');
    expect(callerLabel('x'.repeat(200))).toHaveLength(60);
  });
});

describe('the tools', () => {
  it('exist only for an external caller', async () => {
    const ids = [...AGENT_ACCESS_TOOL_IDS];
    expect(Object.keys(buildLazyServerTools(db, ids, { userId: jim.id, userRole: 'team' }))).toEqual([]);
    const tools = buildLazyServerTools(db, ids, { userId: jim.id, userRole: 'team', externalCaller: caller });
    expect(Object.keys(tools).sort()).toEqual([...ids].sort());
    // An access error is an answer the calling model can act on, not a transport failure.
    const out = await (tools.agent_message as { execute: (input: unknown, opts: unknown) => Promise<unknown> }).execute(
      { agent_id: 'nope', message: 'hi' },
      { toolCallId: 't', messages: [] },
    );
    expect(out).toMatchObject({ code: 'not_found' });
  });
  it('reach an MCP client granted the agents group — messaging only with mcp:write and confirm', async () => {
    useScript({ Ivy: [[{ text: 'Hi from Ivy.' }]] });
    const groupTools = [...mcpToolIdsForGroups(['agents'])];
    const identity: AgentIdentity = {
      userId: jim.id,
      userRole: 'team',
      allowedTools: groupTools.filter((id) => !MUTATING_PROXY_ALLOWLIST.has(id)),
      allowedWriteTools: groupTools.filter((id) => MUTATING_PROXY_ALLOWLIST.has(id)),
      allowedWorkspaces: [],
    };
    const client = { id: `client-${Math.random()}`, name: 'Claude Code' };
    const ctx = await composeMcpContext(identity, {}, client);
    expect([...ctx.toolIds].sort()).toEqual([...AGENT_ACCESS_TOOL_IDS].sort());
    const input = { agent_id: ivy.id, message: 'hi', wait_seconds: 10 };
    await expect(executeProxyTool(ctx.registry, 'agent_message', ctx.toolIds, input)).rejects.toThrow(/confirm/);
    const out = await executeProxyTool(ctx.registry, 'agent_message', ctx.toolIds, input, { confirm: true });
    expect(out).toMatchObject({ status: 'answered', replies: [{ text: 'Hi from Ivy.' }] });

    // A read-only grant lists and reads, never messages.
    const readOnly = await composeMcpContext({ ...identity, allowedWriteTools: [] }, {}, client);
    expect([...readOnly.toolIds].sort()).toEqual(['agent_conversation_get', 'agents_list']);
    // No client named (never the case on a real request): the tools are not offered at all.
    expect((await composeMcpContext(identity, {})).toolIds).toEqual([]);
  });
});
