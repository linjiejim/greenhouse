/**
 * controller.enqueueRun — skill preamble + write_user_turn contract.
 *
 * Docker is never touched by enqueueRun (admission is a separate pump), so the
 * controller runs against a real DB and a temp dataRoot. Pinned here:
 *   • a skill run's task statement (original_prompt / runner prompt) carries
 *     the usage preamble, while the user turn keeps only the user's own words;
 *   • write_user_turn writes the brief into an ORDINARY session (the composer
 *     direct-launch path) and backfills an untitled session's title;
 *   • the dispatch-card path (no flag, ordinary chat) still writes NO user
 *     turn — session-modes spec D5;
 *   • a direct launch carries the conversation into `./inputs/` as a file,
 *     while the dispatch-card path does not.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import { createCloudAgentController, type CloudAgentController } from './controller.js';
import { loadCloudAgentConfig } from './config.js';
import type { DockerCli } from './docker.js';
import { runInputsDirFor } from './workspace.js';

let db: DatabaseProvider;
let owner: UserRow;
let controller: CloudAgentController;
let dataRoot: string;

describe('enqueueRun — skill preamble and user turn', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `enqueue-${Date.now()}-${Math.random()}@test.local` });
    dataRoot = mkdtempSync(join(tmpdir(), 'cloud-agent-enqueue-'));
    controller = createCloudAgentController({
      db,
      docker: {} as DockerCli, // enqueueRun never reaches docker
      config: { ...loadCloudAgentConfig(), dataRoot },
      assertUserWorkspaceQuota: async () => {}, // admission-time proof; enqueue never calls it
    });
  });

  afterEach(async () => {
    rmSync(dataRoot, { recursive: true, force: true });
    await db.close();
    _resetProvider();
  });

  const enqueue = (input: Partial<Parameters<CloudAgentController['enqueueRun']>[1]>) =>
    controller.enqueueRun(owner.id, {
      title: 'test run',
      prompt: 'brief',
      model: 'pro',
      fallbackModel: null,
      ...input,
    });

  it('prepends the skill usage preamble to the task statement, not to the user turn', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    const run = await enqueue({
      prompt: 'summarize the quarter',
      skillName: 'pdf-report',
      sessionId: session.id,
      writeUserTurn: true,
    });

    expect(run.original_prompt).toContain('Use the installed agent skill "pdf-report"');
    expect(run.original_prompt).toContain('summarize the quarter');
    expect(run.prompt).toContain('~/.agents/skills/pdf-report/SKILL.md');

    const messages = await db.sessions.getMessages(session.id);
    const userTurns = messages.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(1);
    // The user's own words only — no synthesized preamble in their bubble.
    expect(userTurns[0]!.content).toBe('summarize the quarter');
  });

  it('an empty brief gets the skill-default task statement and writes no user turn', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    const run = await enqueue({ prompt: '', skillName: 'pdf-report', sessionId: session.id, writeUserTurn: true });

    expect(run.original_prompt).toContain('No further brief was given');

    const messages = await db.sessions.getMessages(session.id);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
    // The title backfill still names the conversation.
    expect((await db.sessions.getById(session.id))?.title).toBe('test run');
  });

  it('without write_user_turn an ordinary session gets NO user turn (dispatch-card path)', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    await enqueue({ prompt: 'card-launched brief', sessionId: session.id });

    const messages = await db.sessions.getMessages(session.id);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('a run without a skill keeps the prompt untouched', async () => {
    const run = await enqueue({ prompt: 'plain mission' });
    expect(run.original_prompt).toBe('plain mission');
    expect(run.prompt).toBe('plain mission');
  });

  /** Read whatever enqueue staged for this run under `./inputs/`. */
  const inputsOf = (run: { id: string; workspace_id: number }) => {
    const dir = runInputsDirFor(dataRoot, owner.id, run.workspace_id, run.id);
    return Object.fromEntries(
      readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')] as const),
    ) as Record<string, string>;
  };

  it('hands a direct launch the conversation it was launched from', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'check reddit for hydroponics' });
    await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Read 5 threads — mostly positive, split on QC.',
    });

    const run = await enqueue({ prompt: '输出分析报告', sessionId: session.id, writeUserTurn: true });

    // The pointer is in the runner prompt only; the task statement stays the
    // user's own brief.
    expect(run.prompt).toContain('./inputs/conversation.md');
    expect(run.original_prompt).toBe('输出分析报告');
    const staged = inputsOf(run);
    expect(staged['conversation.md']).toContain('check reddit for hydroponics');
    expect(staged['conversation.md']).toContain('split on QC');
    // It is not an attachment: no chip, so the chat shows no file the user
    // never attached.
    expect(run.input_manifest).toBe('[]');
  });

  it('does not carry the conversation on the dispatch-card path', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'research this for me' });

    const run = await enqueue({ prompt: 'a self-contained brief', sessionId: session.id });

    expect(run.prompt).not.toContain('conversation.md');
    expect(() => inputsOf(run)).toThrow(); // nothing staged at all
  });

  it('stages nothing extra when the conversation has no history yet', async () => {
    const session = await db.sessions.create(undefined, undefined, owner.id);
    const run = await enqueue({ prompt: 'first thing I say', sessionId: session.id, writeUserTurn: true });

    expect(run.prompt).toBe('first thing I say');
    expect(() => inputsOf(run)).toThrow();
  });
});
