/**
 * IM gateway — dispatcher behavior (pairing, commands, agent turn).
 *
 * Exercises the channel-agnostic brain end-to-end with an in-memory fake
 * DatabaseProvider and a stubbed LLM (the `generate` seam), so no Postgres or
 * model key is required.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Auth env is read by some transitive imports; set before importing app code.
process.env.ACCESS_PASSWORD = 'test-secret-password-123';
process.env.TOKEN_SIGNING_KEY = 'dedicated-signing-key-for-tests-xyz';

import { dispatchInbound } from '../../apps/api/src/im/dispatch.js';
import type { AgentGenerate } from '../../apps/api/src/agent-runtime/run-agent.js';
import type { InboundMessage } from '../../apps/api/src/im/types.js';
import type { ImBotRow } from '@greenhouse/db';

const BOT: ImBotRow = {
  id: 'imbot-test',
  channel: 'telegram',
  name: 'Test Bot',
  token_enc: 'x',
  bot_username: 'testbot',
  default_profile_id: 'default',
  status: 'active',
  poll_offset: 0,
  created_by: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
};

function inbound(over: Partial<InboundMessage>): InboundMessage {
  return { channel: 'telegram', extUserId: '42', extChatId: '42', text: '', displayName: 'Alice', ...over };
}

/** Minimal in-memory DatabaseProvider slice — only what dispatch touches. */
function makeFakeDb() {
  const identityByKey = new Map<string, any>();
  const identityById = new Map<string, any>();
  const pairing = new Map<string, any>();
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  const users = new Map<string, any>([['u1', { id: 'u1', nickname: 'Alice', email: 'a@b.c' }]]);
  let seq = 0;
  const key = (botId: string, ext: string) => `${botId}:${ext}`;

  const im = {
    async getIdentity(botId: string, ext: string) {
      return identityByKey.get(key(botId, ext));
    },
    async getIdentityById(id: string) {
      return identityById.get(id);
    },
    async upsertLink(input: any) {
      const k = key(input.bot_id, input.ext_user_id);
      let row = identityByKey.get(k);
      if (row) {
        Object.assign(row, {
          user_id: input.user_id,
          ext_chat_id: input.ext_chat_id,
          display_name: input.display_name ?? row.display_name,
        });
      } else {
        row = { id: `imid-${++seq}`, session_id: null, ...input };
        identityByKey.set(k, row);
        identityById.set(row.id, row);
      }
      return row;
    },
    async setIdentitySession(id: string, sessionId: string | null) {
      const r = identityById.get(id);
      if (r) r.session_id = sessionId;
    },
    async getPairingCode(code: string) {
      return pairing.get(code);
    },
    async deletePairingCode(code: string) {
      pairing.delete(code);
    },
  };
  const sessionsSvc = {
    async getById(id: string) {
      return sessions.get(id);
    },
    async create(title: string, profileId: string, userId: string, _appId: unknown, channel: string) {
      const id = `sess-${++seq}`;
      const s = { id, title, profile_id: profileId, user_id: userId, channel };
      sessions.set(id, s);
      return s;
    },
    async buildChatMessages(sessionId: string) {
      return messages
        .filter((m) => m.session_id === sessionId && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: m.content }));
    },
    async addMessage(input: any) {
      const m = { id: `msg-${++seq}`, ...input };
      messages.push(m);
      return m;
    },
    async touch() {},
  };
  const usersSvc = {
    async getById(id: string) {
      return users.get(id);
    },
  };

  const db = { im, sessions: sessionsSvc, users: usersSvc } as any;
  return {
    db,
    seedPairingCode: (code: string, userId: string, ttlMs = 60_000) =>
      pairing.set(code, {
        code,
        bot_id: BOT.id,
        user_id: userId,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      }),
    hasPairingCode: (code: string) => pairing.has(code),
    messages,
    sessions,
  };
}

const stubGenerate =
  (text: string): AgentGenerate =>
  async () => ({ text, usage: {}, steps: [] });

describe('dispatchInbound', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => {
    fake = makeFakeDb();
  });

  it('prompts an unlinked user to pair and does not run the agent', async () => {
    let generateCalled = false;
    const generate: AgentGenerate = async () => {
      generateCalled = true;
      return { text: 'should not run', usage: {}, steps: [] };
    };
    const { reply } = await dispatchInbound(BOT, inbound({ text: 'hello' }), {
      toolRegistry: {},
      db: fake.db,
      generate,
    });
    expect(reply).toContain("not linked");
    expect(generateCalled).toBe(false);
    expect(fake.messages).toHaveLength(0);
  });

  it('links the identity on /start <valid code> and consumes the code', async () => {
    fake.seedPairingCode('CODE1', 'u1');
    const { reply } = await dispatchInbound(BOT, inbound({ command: 'start', commandArg: 'CODE1' }), {
      toolRegistry: {},
      db: fake.db,
    });
    expect(reply).toContain('Linked to Greenhouse as Alice');
    expect(fake.hasPairingCode('CODE1')).toBe(false); // single-use
    expect(await fake.db.im.getIdentity(BOT.id, '42')).toBeTruthy();
  });

  it('rejects an unknown / expired pairing code', async () => {
    fake.seedPairingCode('OLD', 'u1', -1000); // already expired
    const bad = await dispatchInbound(BOT, inbound({ command: 'start', commandArg: 'nope' }), {
      toolRegistry: {},
      db: fake.db,
    });
    expect(bad.reply).toContain('invalid or has expired');
    const expired = await dispatchInbound(BOT, inbound({ command: 'start', commandArg: 'OLD' }), {
      toolRegistry: {},
      db: fake.db,
    });
    expect(expired.reply).toContain('invalid or has expired');
  });

  it('runs an agent turn for a linked user, with memory, persisting both turns', async () => {
    await fake.db.im.upsertLink({
      bot_id: BOT.id,
      channel: 'telegram',
      ext_user_id: '42',
      ext_chat_id: '42',
      user_id: 'u1',
      display_name: 'Alice',
    });
    const { reply } = await dispatchInbound(BOT, inbound({ text: 'what is 2+2?' }), {
      toolRegistry: {},
      db: fake.db,
      generate: stubGenerate('4'),
    });
    expect(reply).toBe('4');
    // A session was created + bound, and both user and assistant turns persisted.
    const identity = await fake.db.im.getIdentity(BOT.id, '42');
    expect(identity.session_id).toBeTruthy();
    const roles = fake.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('/new clears the bound session', async () => {
    const identity = await fake.db.im.upsertLink({
      bot_id: BOT.id,
      channel: 'telegram',
      ext_user_id: '42',
      ext_chat_id: '42',
      user_id: 'u1',
      display_name: 'Alice',
    });
    await fake.db.im.setIdentitySession(identity.id, 'sess-existing');
    const { reply } = await dispatchInbound(BOT, inbound({ command: 'new' }), { toolRegistry: {}, db: fake.db });
    expect(reply).toContain('new conversation');
    expect((await fake.db.im.getIdentityById(identity.id)).session_id).toBeNull();
  });

  it('/help lists the commands', async () => {
    const { reply } = await dispatchInbound(BOT, inbound({ command: 'help' }), { toolRegistry: {}, db: fake.db });
    expect(reply).toContain('/new');
    expect(reply).toContain('/whoami');
  });
});
