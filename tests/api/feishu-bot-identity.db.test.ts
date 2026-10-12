/**
 * A Feishu turn runs as the member's Sprouty Agent (resolveProfileAsync default identity), and its
 * prompt's memory index includes Sprouty's private notes. Its tools must carry the same identity:
 * before 2026-10-11 they were built without it, so the model saw the titles of Sprouty's private
 * memories but could not open them, and "remember" could never land in Sprouty's own notes.
 * Here the generate seam calls the memory tool the way a model would.
 */

import { beforeEach, describe, expect, it } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { ensureSproutyBot } from '../../apps/api/src/bots/sprouty.js';
import { dispatchFeishuMessage } from '../../apps/api/src/feishu/bot/dispatch.js';
import type { AgentGenerateArgs } from '../../apps/api/src/agent-runtime/run-agent.js';

let db: DatabaseProvider;
let owner: UserRow;
let openId: string;

type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;

describe('feishu turn tools run as the member’s Sprouty Agent', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `feishu-identity-${Date.now()}-${Math.random()}@test.local` });
    openId = `ou_identity_${Date.now()}_${Math.random()}`;
    await db.providerTokens.upsert({
      user_id: owner.id,
      provider: 'feishu',
      workspace_id: null,
      provider_user_id: openId,
      access_token: null,
    });
  });

  it('reads Sprouty’s private notes and can write to them', async () => {
    const sprouty = await ensureSproutyBot(db, owner.id);
    const privateNote = await db.userMemories.create({
      user_id: owner.id,
      category: 'fact',
      title: 'Weekly report goes out on Fridays',
      content: 'The member wants the weekly report drafted every Friday morning.',
      source: 'agent',
      bot_id: sprouty.id,
    });

    let recalled: Record<string, unknown> | null = null;
    let remembered: Record<string, unknown> | null = null;
    const generate = async (args: AgentGenerateArgs) => {
      const memory = args.tools?.memory as { execute: Execute } | undefined;
      expect(memory).toBeDefined();
      recalled = await memory!.execute({ action: 'recall', ids: [privateNote.id] }, {});
      remembered = await memory!.execute(
        { action: 'remember', title: 'Prefers bullet summaries', content: 'Keep Feishu answers short.', scope: 'bot' },
        {},
      );
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, steps: [] };
    };

    const reply = await dispatchFeishuMessage(
      {
        message_id: `om_${Date.now()}`,
        root_id: null,
        parent_id: null,
        thread_id: null,
        open_id: openId,
        chat_id: 'oc_identity',
        chat_type: 'p2p',
        text: '周报什么时候发？',
      },
      { db, toolRegistry: {}, generate },
    );
    expect(reply.kind).toBe('markdown');

    expect(recalled).toMatchObject({ count: 1 });
    expect(remembered).toMatchObject({ scope: 'bot' });
    const written = (remembered as unknown as { remembered: { id: number } }).remembered;
    expect((await db.userMemories.getOwnedInScope(written.id, owner.id, { botId: sprouty.id }))?.bot_id).toBe(
      sprouty.id,
    );
  });
});
