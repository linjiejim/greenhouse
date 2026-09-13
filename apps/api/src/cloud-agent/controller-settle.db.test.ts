/**
 * controller.settle — what `settled_at` is allowed to depend on.
 *
 * `settled_at` is the client's "your result is here" cursor: `use-mission-run`
 * reloads the transcript on it and on nothing else. It used to also require
 * journal archiving and workspace byte accounting to succeed, so on 2026-08-13
 * a local object-storage credential error (`SignatureDoesNotMatch`) left a
 * completed run permanently unsettled — the outcome message was written and
 * delivered, the artifacts were stored, and the page still showed a running
 * mission until the user reloaded by hand. Every boot retried and failed the
 * same way.
 *
 * Pinned here: a failing journal archive settles anyway (with the outcome
 * delivered), while a failing outcome delivery does NOT settle — that one is
 * genuinely owed to the user, and staying unsettled is what makes the boot
 * sweep retry it.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { createCloudAgentController, type CloudAgentController } from './controller.js';
import { loadCloudAgentConfig } from './config.js';
import type { DockerCli } from './docker.js';
import { workspaceDirsFor } from './workspace.js';

let db: DatabaseProvider;
let owner: UserRow;
let controller: CloudAgentController;
let dataRoot: string;

/** settle() only reaches removeContainer; nothing else in this file touches Docker. */
const dockerStub = { removeContainer: async () => {} } as unknown as DockerCli;

describe('settle — settled_at tracks delivery, not bookkeeping', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `settle-${Date.now()}-${Math.random()}@test.local` });
    dataRoot = mkdtempSync(join(tmpdir(), 'cloud-agent-settle-'));
    controller = createCloudAgentController({
      db,
      docker: dockerStub,
      config: { ...loadCloudAgentConfig(), dataRoot },
      assertUserWorkspaceQuota: async () => {},
    });
  });

  afterEach(async () => {
    rmSync(dataRoot, { recursive: true, force: true });
    await db.close();
    _resetProvider();
    vi.restoreAllMocks();
  });

  const enqueueWithSession = async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    const run = await controller.enqueueRun(owner.id, {
      title: 'settle test',
      prompt: 'do the thing',
      model: 'pro',
      fallbackModel: null,
      sessionId: session.id,
    });
    return { session, run };
  };

  /**
   * Make `archiveRunJournal` throw the way a broken object store does, without
   * needing one: a directory where it expects a regular file fails its
   * `stat.isFile()` check.
   */
  const breakJournalArchive = (run: { user_id: string; workspace_id: number }) => {
    const { sessionDir } = workspaceDirsFor(dataRoot, run.user_id, run.workspace_id);
    mkdirSync(join(sessionDir, 'journal.jsonl'), { recursive: true });
  };

  it('settles — and delivers the outcome — even when journal archiving fails', async () => {
    const { session, run } = await enqueueWithSession();
    breakJournalArchive(run);

    const canceled = await controller.cancelRun(run.id);
    expect(canceled?.status).toBe('canceled');

    const stored = await db.agentRuns.getRunById(run.id);
    expect(stored?.settled_at, 'a diagnostic failure must not withhold the settle cursor').toBeTruthy();
    // Unsettled runs are what the boot sweep retries; this one owes nothing.
    const unsettled = await db.agentRuns.listUnsettledTerminalRuns();
    expect(unsettled.map((r) => r.id)).not.toContain(run.id);

    const messages = await db.sessions.getMessages(session.id);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('does NOT settle when the outcome could not be delivered', async () => {
    const { run } = await enqueueWithSession();
    vi.spyOn(db.agentRuns, 'enqueueOutcome').mockRejectedValue(new Error('outbox write failed'));

    await controller.cancelRun(run.id);

    const stored = await db.agentRuns.getRunById(run.id);
    expect(stored?.status).toBe('canceled');
    expect(stored?.settled_at, 'the user has no result yet — stay retryable').toBeNull();
    const unsettled = await db.agentRuns.listUnsettledTerminalRuns();
    expect(unsettled.map((r) => r.id)).toContain(run.id);
  });

  it('settles a healthy run', async () => {
    const { session, run } = await enqueueWithSession();

    await controller.cancelRun(run.id);

    expect((await db.agentRuns.getRunById(run.id))?.settled_at).toBeTruthy();
    expect((await db.sessions.getMessages(session.id)).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});
