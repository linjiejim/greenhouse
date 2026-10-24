/**
 * Runtime on the 3.0 schema (real PostgreSQL): artifacts live in `files`
 * (source = 'run') and event allocation survives retention.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, newId, type DatabaseProvider } from '../index.js';
import { TEST_DATABASE_URL } from '../test-config.js';

let db: DatabaseProvider;

async function createRun() {
  const owner = newId('user');
  return db.runtime.createRun({
    kind: 'mission',
    owner_user_id: owner,
    initiated_by_user_id: owner,
    source_kind: 'test',
    source_id: newId('run'),
    input: { exact: true },
  });
}

describe('runtime on files and retention', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('stores artifacts as run files and maps them back to the artifact shape', async () => {
    const run = await createRun();
    const artifact = await db.runtime.createArtifact({
      run_id: run.id,
      direction: 'output',
      kind: 'report',
      name: 'brief.md',
      path: 'out/brief.md',
      source: 'test',
    });
    expect(artifact).toMatchObject({
      run_id: run.id,
      status: 'pending',
      size_bytes: null,
      direction: 'output',
      kind: 'report',
      path: 'out/brief.md',
    });
    expect(artifact.id).toMatch(/^fil_/);
    const [file] = (await db.executeRaw(
      sql`SELECT source, run_id, status, size, meta FROM files WHERE id = ${artifact.id}`,
    )) as Array<Record<string, unknown>>;
    expect(file).toMatchObject({ source: 'run', run_id: run.id, status: 'pending' });
    expect(Number(file!.size)).toBe(0);
    expect(file!.meta).toMatchObject({ direction: 'output', kind: 'report', path: 'out/brief.md', source: 'test' });

    const available = await db.runtime.transitionArtifact({
      id: artifact.id,
      expected_status: 'pending',
      to_status: 'available',
      idempotency_key: 'artifact-ready',
      storage_key: `runtime/${artifact.id}`,
      size_bytes: 42,
    });
    expect(available).toMatchObject({ status: 'available', size_bytes: 42, storage_key: `runtime/${artifact.id}` });
    const [after] = (await db.executeRaw(sql`SELECT status FROM files WHERE id = ${artifact.id}`)) as Array<{
      status: string;
    }>;
    expect(after!.status).toBe('active');
    expect(await db.runtime.listArtifacts(run.id)).toEqual([available]);
    expect(await db.runtime.getArtifact(artifact.id)).toEqual(available);
  });

  it("keeps allocating event sequence numbers after retention removed a settled run's old events", async () => {
    const run = await createRun();
    expect((await db.runtime.listAllEvents(run.id)).length).toBeGreaterThan(0);
    // Retention deletes old events of settled runs; such a run may still get a new one (a retry).
    await db.executeRaw(sql`DELETE FROM run_events WHERE run_id = ${run.id}`);
    const next = await db.runtime.appendEvent({ run_id: run.id, type: 'test.after_retention', payload: {} });
    expect(next.seq).toBeGreaterThan(0);
    const detail = await db.runtime.getRunDetail(run.id);
    expect(detail?.events.map((event) => event.id)).toEqual([next.id]);
  });
});
