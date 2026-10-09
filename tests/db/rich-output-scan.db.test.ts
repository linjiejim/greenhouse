/**
 * `scanFencedAssistantMessages` — the read behind `pnpm cli rich-output stats`.
 *
 * Keyset pagination on (created_at, id) is hand-written SQL; if the cursor
 * comparison were wrong the CLI would either loop forever or silently skip
 * pages, and "no failures" would look exactly like a healthy month.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

describe('scanFencedAssistantMessages', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('returns only assistant messages with a fence, oldest first, page by page', async () => {
    const session = await db.sessions.create('rich stats', 'team', 'user-rich-stats');
    const model = `rich-scan-${Date.now()}`;
    const fenced = (n: number) => `Answer ${n}\n\n\`\`\`chart\n{"labels":["a"],"values":[${n}]}\n\`\`\``;
    for (const n of [1, 2, 3]) {
      await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: fenced(n), model });
    }
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'plain prose', model });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: '```chart\n{}\n```' });

    const since = new Date(Date.now() - 60_000).toISOString();
    const first = await db.sessions.scanFencedAssistantMessages({ sinceIso: since, model, limit: 2 });
    expect(first.map((row) => row.content)).toEqual([fenced(1), fenced(2)]);
    expect(first.every((row) => row.model === model)).toBe(true);

    const last = first.at(-1)!;
    const second = await db.sessions.scanFencedAssistantMessages({
      sinceIso: since,
      model,
      limit: 2,
      after: { createdAt: last.created_at, id: last.id },
    });
    expect(second.map((row) => row.content)).toEqual([fenced(3)]);
  });

  it('respects the time window', async () => {
    const session = await db.sessions.create('rich stats window', 'team', 'user-rich-stats');
    const model = `rich-window-${Date.now()}`;
    await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: '```mermaid\nA-->B\n```',
      model,
    });

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await db.sessions.scanFencedAssistantMessages({ sinceIso: future, model })).toEqual([]);
  });
});
