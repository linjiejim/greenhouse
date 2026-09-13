/**
 * Tool friction aggregation + the miner's evidence query (real PostgreSQL).
 *
 * Two things here have no other safety net:
 *
 *   • `record()` is an upsert on a unique fingerprint, and the occurrence count
 *     it maintains IS the priority signal the review queue sorts by. It used to
 *     read-then-insert, which loses the race between the nightly miner and a
 *     live `log_friction` call with a 23505 that both callers swallow — the
 *     stumble would just disappear.
 *   • `scanToolErrors` is hand-written SQL with a runtime `::jsonb` cast. If it
 *     silently returns nothing, that is indistinguishable from "the agent had a
 *     good week", so it has to be exercised against real rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { PipelineStep } from '@greenhouse/types/session';

let db: DatabaseProvider;

const base = {
  kind: 'tool_error' as const,
  summary: 'crm_query rejected a call that omitted the required type argument',
};

function samplesOf(row: { sample_sessions: string }): string[] {
  return JSON.parse(row.sample_sessions) as string[];
}

describe('Tool frictions', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── record(): the aggregation contract ────────────────

  it('creates one row per fingerprint and accumulates the count on re-record', async () => {
    const fingerprint = `fp-count-${Date.now()}`;

    const first = await db.toolFrictions.record({ ...base, fingerprint, tool_id: 'crm_query' });
    expect(first.occurrence_count).toBe(1);
    expect(first.status).toBe('new');

    const second = await db.toolFrictions.record({ ...base, fingerprint, tool_id: 'crm_query' });
    expect(second.id).toBe(first.id);
    expect(second.occurrence_count).toBe(2);

    // The miner batches, so an increment can represent many occurrences.
    const third = await db.toolFrictions.record({ ...base, fingerprint, increment: 12 });
    expect(third.occurrence_count).toBe(14);

    expect(await db.toolFrictions.count({ tool_id: 'crm_query' })).toBe(1);
  });

  it('keeps first_seen_at while moving last_seen_at', async () => {
    const fingerprint = `fp-seen-${Date.now()}`;
    const first = await db.toolFrictions.record({ ...base, fingerprint });
    await new Promise((r) => setTimeout(r, 10));
    const again = await db.toolFrictions.record({ ...base, fingerprint });

    expect(again.first_seen_at).toBe(first.first_seen_at);
    expect(Date.parse(again.last_seen_at)).toBeGreaterThanOrEqual(Date.parse(first.last_seen_at));
  });

  it('samples distinct sessions, newest first, capped', async () => {
    const fingerprint = `fp-samples-${Date.now()}`;

    for (const session_id of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      await db.toolFrictions.record({ ...base, fingerprint, session_id });
    }
    const row = (await db.toolFrictions.list({ tool_id: undefined })).find((r) => r.fingerprint === fingerprint)!;

    const samples = samplesOf(row);
    expect(samples).toHaveLength(5);
    expect(samples[0]).toBe('s6'); // newest first
    expect(samples).not.toContain('s1'); // oldest fell off the cap
    expect(row.occurrence_count).toBe(6); // every occurrence still counted
  });

  it('does not re-add a session id it already sampled', async () => {
    const fingerprint = `fp-dupe-${Date.now()}`;
    await db.toolFrictions.record({ ...base, fingerprint, session_id: 'same' });
    const row = await db.toolFrictions.record({ ...base, fingerprint, session_id: 'same' });

    expect(samplesOf(row)).toEqual(['same']);
    expect(row.occurrence_count).toBe(2);
  });

  it('leaves the samples alone when a record carries no session', async () => {
    const fingerprint = `fp-nosession-${Date.now()}`;
    await db.toolFrictions.record({ ...base, fingerprint, session_id: 'kept' });
    const row = await db.toolFrictions.record({ ...base, fingerprint });

    expect(samplesOf(row)).toEqual(['kept']);
  });

  it('reopens a resolved friction that happens again, but leaves other statuses alone', async () => {
    const resolved = `fp-resolved-${Date.now()}`;
    const acked = `fp-acked-${Date.now()}`;

    const a = await db.toolFrictions.record({ ...base, fingerprint: resolved });
    await db.toolFrictions.update(a.id, { status: 'resolved', resolution_note: 'clarified the description' });
    const reopened = await db.toolFrictions.record({ ...base, fingerprint: resolved });
    expect(reopened.status).toBe('new');
    // The note stays: it explains what was tried last time.
    expect(reopened.resolution_note).toBe('clarified the description');

    const b = await db.toolFrictions.record({ ...base, fingerprint: acked });
    await db.toolFrictions.update(b.id, { status: 'acknowledged' });
    const stillAcked = await db.toolFrictions.record({ ...base, fingerprint: acked });
    expect(stillAcked.status).toBe('acknowledged');
  });

  it('keeps an existing detail when the new record has none', async () => {
    const fingerprint = `fp-detail-${Date.now()}`;
    await db.toolFrictions.record({ ...base, fingerprint, detail: 'id and type required' });
    const row = await db.toolFrictions.record({ ...base, fingerprint });
    expect(row.detail).toBe('id and type required');

    const updated = await db.toolFrictions.record({ ...base, fingerprint, detail: 'a better sample' });
    expect(updated.detail).toBe('a better sample');
  });

  it('survives concurrent records of the same fingerprint without losing one', async () => {
    // The regression: two writers both saw no row, both inserted, and the loser
    // took a 23505 that its caller swallowed. Nothing here may be dropped.
    const fingerprint = `fp-race-${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => db.toolFrictions.record({ ...base, fingerprint, session_id: `race-${i}` })),
    );

    expect(results).toHaveLength(8);
    const rows = await db.toolFrictions.list({});
    const mine = rows.filter((r) => r.fingerprint === fingerprint);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.occurrence_count).toBe(8);
    expect(samplesOf(mine[0]!)).toHaveLength(5);
  });

  // ─── the review queue ──────────────────────────────────

  it('orders the queue by how often each friction bites', async () => {
    const stamp = Date.now();
    const rare = await db.toolFrictions.record({ ...base, fingerprint: `fp-rare-${stamp}`, summary: 'rare' });
    const common = await db.toolFrictions.record({ ...base, fingerprint: `fp-common-${stamp}`, summary: 'common' });
    await db.toolFrictions.record({ ...base, fingerprint: `fp-common-${stamp}`, increment: 20 });

    const queue = await db.toolFrictions.list({ status: ['new', 'acknowledged'] });
    const ids = queue.map((r) => r.id);
    expect(ids.indexOf(common.id)).toBeLessThan(ids.indexOf(rare.id));
  });

  it('filters the queue by status', async () => {
    const fingerprint = `fp-status-${Date.now()}`;
    const row = await db.toolFrictions.record({ ...base, fingerprint });
    await db.toolFrictions.update(row.id, { status: 'archived' });

    const open = await db.toolFrictions.list({ status: ['new', 'acknowledged'] });
    expect(open.map((r) => r.id)).not.toContain(row.id);

    const archived = await db.toolFrictions.list({ status: 'archived' });
    expect(archived.map((r) => r.id)).toContain(row.id);
  });

  it('deletes a friction outright — a false positive should leave no trace', async () => {
    const row = await db.toolFrictions.record({ ...base, fingerprint: `fp-del-${Date.now()}` });
    expect(await db.toolFrictions.delete(row.id)).toBe(true);
    expect(await db.toolFrictions.getById(row.id)).toBeUndefined();
    expect(await db.toolFrictions.delete(row.id)).toBe(false);
  });
});

// ─── the miner's evidence query ──────────────────────────

describe('scanToolErrors', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  function step(overrides: Partial<PipelineStep>): PipelineStep {
    return { step: 1, tool: 'crm_query', input: {}, output: {}, duration_ms: 5, ...overrides };
  }

  async function assistantMessage(sessionId: string, pipeline: PipelineStep[]) {
    await db.sessions.addMessage({
      session_id: sessionId,
      role: 'assistant',
      content: 'answer',
      pipeline,
    });
  }

  it('extracts failed tool calls out of the pipeline column', async () => {
    const session = await db.sessions.create('miner evidence', 'team', 'user-miner');
    await assistantMessage(session.id, [
      step({ tool: 'crm_query', input: { type: 'company' }, output: { error: 'id and type required' } }),
      step({ step: 2, tool: 'knowledge_query', input: { q: 'x' }, output: { results: [] } }),
    ]);

    const since = new Date(Date.now() - 60_000).toISOString();
    const samples = await db.sessions.scanToolErrors(since);
    const mine = samples.filter((s) => s.session_id === session.id);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.tool).toBe('crm_query');
    expect(mine[0]!.error).toBe('id and type required');
    expect(mine[0]!.input).toContain('company');
  });

  it('ignores turns that used no tool, succeeded, or answered with a non-object', async () => {
    const session = await db.sessions.create('miner noise', 'team', 'user-miner');
    await assistantMessage(session.id, []);
    await assistantMessage(session.id, [step({ tool: 'ok_tool', output: { results: [1] } })]);
    // `jsonb_typeof(... ) = 'object'` is what keeps this one out of the results.
    await assistantMessage(session.id, [step({ tool: 'weird', output: 'a string, not an object' })]);

    const since = new Date(Date.now() - 60_000).toISOString();
    const samples = await db.sessions.scanToolErrors(since);
    expect(samples.filter((s) => s.session_id === session.id)).toHaveLength(0);
  });

  it('survives a pipeline that serialised a NUL character, and still mines the rest', async () => {
    // The incident this pins: a UTF-16 CSV decoded as UTF-8 put NULs into a
    // tool output; JSON.stringify wrote them as escape sequences the ::jsonb
    // cast rejects ("unsupported Unicode escape sequence"), and that ONE row
    // aborted the entire sweep. The poisoned row may be skipped; the healthy
    // row in the same window must still come back.
    const session = await db.sessions.create('miner nul', 'team', 'user-miner');
    await assistantMessage(session.id, [
      step({ tool: 'read_attachment', output: { text: `garbage${String.fromCharCode(0)}text` } }),
    ]);
    await assistantMessage(session.id, [step({ tool: 'crm_query', output: { error: 'still minable' } })]);

    const since = new Date(Date.now() - 60_000).toISOString();
    const samples = await db.sessions.scanToolErrors(since);
    const mine = samples.filter((s) => s.session_id === session.id);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.error).toBe('still minable');
  });

  it('honours the time window and the row cap', async () => {
    const session = await db.sessions.create('miner window', 'team', 'user-miner');
    await assistantMessage(session.id, [
      step({ output: { error: 'boom' } }),
      step({ step: 2, output: { error: 'boom' } }),
    ]);

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await db.sessions.scanToolErrors(future)).toHaveLength(0);

    const since = new Date(Date.now() - 60_000).toISOString();
    expect((await db.sessions.scanToolErrors(since, 1)).length).toBeLessThanOrEqual(1);
  });
});

/**
 * `scanEmptyResults` is the second miner lane: retrieval that ran fine and
 * found nothing. It has the same "silently returns nothing is
 * indistinguishable from a good week" hazard as scanToolErrors, so it gets the
 * same real-rows treatment. The tool allowlist that decides which empty results
 * are worth reviewing lives in the caller (friction-center), not here.
 */
describe('scanEmptyResults', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  function step(overrides: Partial<PipelineStep>): PipelineStep {
    return { step: 1, tool: 'knowledge_query', input: {}, output: {}, duration_ms: 5, ...overrides };
  }

  async function assistantMessage(sessionId: string, pipeline: PipelineStep[]) {
    await db.sessions.addMessage({ session_id: sessionId, role: 'assistant', content: 'answer', pipeline });
  }

  it('finds searches that succeeded with nothing, and keeps the query as evidence', async () => {
    const session = await db.sessions.create('empty search', 'team', 'user-miner');
    await assistantMessage(session.id, [
      step({ tool: 'knowledge_query', input: { action: 'search', query: '退货政策' }, output: { found: 0 } }),
    ]);

    const since = new Date(Date.now() - 60_000).toISOString();
    const mine = (await db.sessions.scanEmptyResults(since)).filter((s) => s.session_id === session.id);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.tool).toBe('knowledge_query');
    expect(mine[0]!.input).toContain('退货政策');
  });

  it('ignores non-empty results and anything that already errored', async () => {
    const session = await db.sessions.create('empty search noise', 'team', 'user-miner');
    await assistantMessage(session.id, [step({ output: { found: 3 } })]);
    // An error is the OTHER miner's business; counting it twice would double the queue.
    await assistantMessage(session.id, [step({ step: 2, output: { found: 0, error: 'boom' } })]);
    await assistantMessage(session.id, [step({ step: 3, output: { results: [] } })]);

    const since = new Date(Date.now() - 60_000).toISOString();
    expect((await db.sessions.scanEmptyResults(since)).filter((s) => s.session_id === session.id)).toHaveLength(0);
  });
});
