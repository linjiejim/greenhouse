import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { conversations, getDb } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { resolveHistoryBudget } from '@greenhouse/agent-core';
import {
  chooseCut,
  digestTrigger,
  DIGEST_MIN_KEPT_EXCHANGES,
  parseDigestAnswer,
  renderDigest,
  type DigestRow,
} from '../digest.js';
import { scriptedModel, systemText, text } from './model.js';

const row = (seq: number, role: DigestRow['role'], size: number): DigestRow => ({
  seq,
  role,
  content: 'x'.repeat(size * 4),
  speaker: role,
});

describe('the summary cut', () => {
  it('cuts before a member message and keeps the last exchanges', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(index + 1, index % 2 ? 'assistant' : 'user', 2000));
    const folded = chooseCut(rows)!;
    expect(folded.at(-1)!.role).toBe('assistant');
    const kept = rows.slice(folded.length);
    expect(kept[0]!.role).toBe('user');
    expect(kept.filter((r) => r.role === 'user').length).toBeGreaterThanOrEqual(DIGEST_MIN_KEPT_EXCHANGES);
    expect(chooseCut(rows.slice(0, 4))).toBeNull();
  });

  it('folds at a quarter of the model’s context window, long before the history budget drops anything', () => {
    expect(digestTrigger()).toBe(24_000);
    expect(digestTrigger(200_000)).toBe(50_000);
    for (const window of [32_000, 128_000, 1_000_000]) {
      expect(digestTrigger(window)).toBeLessThan(resolveHistoryBudget(window) / 1.5);
    }
  });

  it('reads the model answer and renders it within the cap', () => {
    const doc = parseDigestAnswer(
      '```json\n{"goals":["Plan the Kyoto trip"],"decisions":[{"text":"Go in April","seq":3}],"facts":[],"open_items":[{"text":"Book the hotel","owner_agent_id":"agt_1"}],"artifacts":[]}\n```',
    )!;
    expect(renderDigest(doc, 'en', new Map([['agt_1', 'Greeny']]))).toBe(
      'Goals:\nPlan the Kyoto trip\nDecisions:\nGo in April (#3)\nItems:\nPending: Book the hotel, Greeny',
    );
    expect(parseDigestAnswer('no json here')).toBeNull();
  });
});

describe('summarising a long conversation', () => {
  it('folds older messages once the thread grows long and the prompt carries the summary', async () => {
    const summary = JSON.stringify({
      goals: ['Plan the Kyoto trip'],
      decisions: [],
      facts: [],
      open_items: [],
      artifacts: [],
    });
    const model = scriptedModel([text('ok')], { summary });
    const app = createTestApp({}, { languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
    // A long history, written directly.
    for (let index = 0; index < 8; index++) {
      await app.services.conversations.append(main.id, {
        role: 'user',
        authorMemberId: lin.id,
        content: `q${index} ${'word '.repeat(4000)}`,
      });
      await app.services.conversations.append(main.id, {
        role: 'assistant',
        agentId: agent.id,
        content: `a${index} ${'word '.repeat(4000)}`,
      });
    }
    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'and now?' },
    });
    await app.services.engine.idle();
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, main.id));
    expect(row!.digestUptoSeq).toBeGreaterThan(1);
    expect(JSON.parse(row!.digest).goals).toEqual(['Plan the Kyoto trip']);
    const detail = await app.call('GET', `/api/conversations/${main.id}`, { token: lin.token });
    expect(detail.body.digest).toBe('目标：\nPlan the Kyoto trip');

    await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: 'remind me' },
    });
    await app.services.engine.idle();
    const prompt = model.prompts.at(-1);
    expect(systemText(prompt)).toContain('Plan the Kyoto trip');
    // The folded messages are no longer sent verbatim.
    expect(JSON.stringify(prompt)).not.toContain('q0 word');
  });

  it('folds sooner for a model with a small context window', async () => {
    const summary = JSON.stringify({ goals: ['Small talk'], decisions: [], facts: [], open_items: [], artifacts: [] });
    const scripted = scriptedModel([text('ok')], { summary });
    // About 7k tokens of history: under the default trigger, over a quarter of a 20k window.
    const run = async (contextWindow?: number) => {
      const app = createTestApp(
        {},
        { languageModel: async () => ({ ...(await scripted.languageModel()), contextWindow }) },
      );
      const lin = await app.member();
      const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
      const agent = (await app.call('GET', '/api/agents/main', { token: lin.token })).body;
      for (let index = 0; index < 4; index++) {
        await app.services.conversations.append(main.id, {
          role: 'user',
          authorMemberId: lin.id,
          content: `q${index} ${'word '.repeat(700)}`,
        });
        await app.services.conversations.append(main.id, {
          role: 'assistant',
          agentId: agent.id,
          content: `a${index} ${'word '.repeat(700)}`,
        });
      }
      await app.call('POST', `/api/conversations/${main.id}/messages`, { token: lin.token, body: { content: 'next' } });
      await app.services.engine.idle();
      const [row] = await getDb().select().from(conversations).where(eq(conversations.id, main.id));
      return row!.digestUptoSeq;
    };
    expect(await run()).toBe(0);
    expect(await run(20_000)).toBeGreaterThan(1);
  });
});
