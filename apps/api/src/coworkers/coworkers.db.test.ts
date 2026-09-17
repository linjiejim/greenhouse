import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { createOwnedSession } from '../sessions/creation.js';
import { resolveCoworker } from './identity.js';
import { createAgentChatTool } from '../tools/agent-chat.js';
import { createMemoryTool } from '../tools/memory.js';
import { canWriteSession } from '../sessions/access.js';

let db: DatabaseProvider;
beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});
async function setup() {
  const owner = await createInternalTestUser(db, { email: 'coworker-owner@test.local' });
  const other = await createInternalTestUser(db, { email: 'coworker-other@test.local' });
  const profile = await db.customProfiles.create({
    user_id: owner.id,
    slug: 'analyst',
    name: 'Analyst',
    tools: [],
    system_prompt: 'You review evidence.',
  });
  const actor = { id: owner.id, role: 'team' as const };
  const session = await createOwnedSession(actor, { profileId: 'sprouty' });
  return { owner, other, profile, actor, session };
}

describe('persistent coworkers', () => {
  it('keeps identity across profile versions and separates default coworkers by user', async () => {
    const { other, profile, actor } = await setup();
    const first = await resolveCoworker(actor, `custom:${profile.id}`, db);
    await db.customProfiles.createVersion(profile.id, { name: 'Analyst revised' });
    const second = await resolveCoworker(actor, `custom:${profile.id}`, db);
    expect(second.instance.id).toBe(first.instance.id);
    expect(second.profileId).not.toBe(first.profileId);
    const a = await resolveCoworker(actor, 'sprouty', db);
    const b = await resolveCoworker({ id: other.id, role: 'team' }, 'sprouty', db);
    expect(a.instance.id).not.toBe(b.instance.id);
  });

  it('shares the coworker identity while keeping human conversations and memory private, and rechecks revocation', async () => {
    const { owner, other, profile, actor } = await setup();
    await db.customProfiles.transitionLifecycle(profile.id, { status: 'review', actor_user_id: owner.id });
    await db.customProfiles.transitionLifecycle(profile.id, {
      status: 'verified',
      actor_user_id: owner.id,
      publish_version: 1,
    });
    const theirs = { id: other.id, role: 'team' as const };
    const mine = await createOwnedSession(actor, { profileId: `custom:${profile.id}` });
    const yours = await createOwnedSession(theirs, { profileId: `custom:${profile.id}` });
    expect(mine.agent_instance_id).toBe(yours.agent_instance_id);
    expect(mine.id).not.toBe(yours.id);
    expect(canWriteSession(theirs, mine)).toBe(false);
    const memory = await db.userMemories.create({
      user_id: owner.id,
      agent_instance_id: mine.agent_instance_id,
      category: 'fact',
      title: 'Private working preference',
      content: 'Use a short summary.',
    });
    expect(await db.userMemories.getOwned(memory.id, other.id, yours.agent_instance_id)).toBeUndefined();
    await db.customProfiles.transitionLifecycle(profile.id, { status: 'suspended', actor_user_id: owner.id });
    await expect(resolveCoworker(theirs, yours.profile_id, db)).rejects.toThrow('not executable');
  });

  it('reuses a workspace only for the same coworker and requesting user', async () => {
    const { owner, other, profile, actor } = await setup();
    const { instance } = await resolveCoworker(actor, `custom:${profile.id}`, db);
    const first = await db.coworkers.ensureWorkspace(instance.id, owner.id, 'Workspace');
    expect(await db.coworkers.ensureWorkspace(instance.id, owner.id, 'Again')).toBe(first);
    expect(await db.coworkers.ensureWorkspace(instance.id, other.id, 'Private workspace')).not.toBe(first);
  });

  it('keeps coworker memories private from other coworkers and other users', async () => {
    const { owner, other, profile, actor, session } = await setup();
    const analystSession = await createOwnedSession(actor, { profileId: `custom:${profile.id}` });
    const memory = createMemoryTool(db, { userId: owner.id, sessionId: analystSession.id });
    const saved: any = await memory.execute!(
      { action: 'remember', title: 'Preferred style', content: 'Use concise summaries.' },
      {} as never,
    );
    expect(saved.remembered).toBeTruthy();
    const id = saved.remembered.id;
    expect(await db.userMemories.listForIndex(owner.id)).toHaveLength(0);
    expect(await db.userMemories.listForIndex(owner.id, 100, analystSession.agent_instance_id)).toHaveLength(1);
    const defaultMemory = createMemoryTool(db, { userId: owner.id, sessionId: session.id });
    expect(await defaultMemory.execute!({ action: 'recall', ids: [id] }, {} as never)).toMatchObject({ count: 0 });
    expect(await defaultMemory.execute!({ action: 'forget', id }, {} as never)).toHaveProperty('error');
    expect(await db.userMemories.getOwned(id, other.id, analystSession.agent_instance_id)).toBeUndefined();
    expect(await db.userMemories.listByUser(owner.id)).toHaveLength(1); // human inspection includes all scopes
  });

  it('persists actual bilateral rounds, is idempotent, and never passes the human transcript or memory to the peer', async () => {
    const { owner, profile, actor, session } = await setup();
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'PRIVATE HUMAN TRANSCRIPT' });
    await db.userMemories.create({
      user_id: owner.id,
      category: 'fact',
      title: 'PRIVATE MEMORY',
      content: 'PRIVATE MEMORY',
    });
    const generate = vi.fn(
      async ({ messages, system, tools }: { messages: unknown; system: string; tools?: object }) => {
        expect(JSON.stringify(messages)).not.toContain('PRIVATE HUMAN TRANSCRIPT');
        expect(system).not.toContain('PRIVATE MEMORY');
        expect(tools).not.toHaveProperty('session_query');
        return { text: 'Evidence checked.', usage: { inputTokens: 20, outputTokens: 5 } };
      },
    );
    const tool = createAgentChatTool(db, {
      userId: owner.id,
      userRole: 'team',
      parentSessionId: session.id,
      parentProfileId: session.profile_id,
      generate,
      assembleChildTools: () => ({}),
    });
    const send = (message: string, toolCallId: string, dialogue_id?: string) =>
      tool.execute!(
        { action: 'send', profile_id: `custom:${profile.id}`, message, dialogue_id },
        { toolCallId, messages: [] },
      );
    const first: any = await send('Please check the evidence.', 'first');
    expect(first.type).toBe('agent_dialogue');
    expect(first.rounds[0]).toMatchObject({
      status: 'succeeded',
      message: 'Please check the evidence.',
      reply: 'Evidence checked.',
    });
    const replay = await send('Please check the evidence.', 'first');
    expect(replay).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
    const second: any = await send('What about uncertainty?', 'second', first.dialogue_id);
    expect(second.rounds).toHaveLength(2);
    expect(JSON.stringify(generate.mock.calls[1][0].messages)).toContain('Evidence checked.');
    const child = await db.sessions.getById(first.rounds[0].child_session_id);
    expect(child?.agent_instance_id).toBeTruthy();
    expect(canWriteSession(actor, child!)).toBe(false);
    expect((await db.sessions.list({ userId: owner.id, excludeDialogueRounds: true })).map((s) => s.id)).not.toContain(
      child!.id,
    );
    for (let i = 3; i <= 6; i++) await send(`Question ${i}`, `round-${i}`, first.dialogue_id);
    expect(await send('Too many rounds', 'seventh', first.dialogue_id)).toHaveProperty('error');
    expect(generate).toHaveBeenCalledTimes(6);
  }, 20_000);

  it('rejects inaccessible targets, another user’s dialogue, self-dialogue and nested human impersonation', async () => {
    const { owner, other, profile, actor, session } = await setup();
    const otherSession = await createOwnedSession({ id: other.id, role: 'team' }, {});
    const foreignTool = createAgentChatTool(db, {
      userId: other.id,
      userRole: 'team',
      parentSessionId: otherSession.id,
      assembleChildTools: () => ({}),
    });
    expect(
      await foreignTool.execute!(
        { action: 'send', profile_id: `custom:${profile.id}`, message: 'secret?' },
        { toolCallId: 'foreign', messages: [] },
      ),
    ).toHaveProperty('error');
    expect(
      await foreignTool.execute!(
        { action: 'send', dialogue_id: 'unknown', message: 'secret?' },
        { toolCallId: 'foreign2', messages: [] },
      ),
    ).toHaveProperty('error');
    const tool = createAgentChatTool(db, {
      userId: owner.id,
      userRole: 'team',
      parentSessionId: session.id,
      assembleChildTools: () => ({}),
    });
    expect(
      await tool.execute!(
        { action: 'send', profile_id: 'sprouty', message: 'self?' },
        { toolCallId: 'self', messages: [] },
      ),
    ).toHaveProperty('error');
    const instance = await resolveCoworker(actor, `custom:${profile.id}`, db);
    const parent = await db.sessions.create('Peer', instance.profileId, owner.id, undefined, 'subagent');
    const nested = createAgentChatTool(db, {
      userId: owner.id,
      userRole: 'team',
      parentSessionId: parent.id,
      assembleChildTools: () => ({}),
    });
    expect(await nested.execute!({ action: 'list' }, { toolCallId: 'nested', messages: [] })).toHaveProperty('error');
  });
});
