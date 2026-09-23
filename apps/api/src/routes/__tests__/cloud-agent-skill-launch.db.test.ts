/**
 * POST /api/cloud-agent/runs — skill launch + write_user_turn contract.
 *
 * The controller is stubbed (Docker never runs in tests); what these pin is
 * the ROUTE's validation surface: a `skill` must be mission-ready at launch
 * time (quarantined-after-listing skills are refused), an empty prompt is
 * only legal with a skill, the title falls back to the skill's display name,
 * and write_user_turn requires a bound session.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, SkillRow, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import type { AppEnv } from '../../app-env.js';
import { createCloudAgentRoutes } from '../cloud-agent.js';
import { _setCloudAgentController } from '../../cloud-agent/index.js';
import type { CloudAgentController } from '../../cloud-agent/controller.js';
import type { EnqueueRunInput } from '../../cloud-agent/controller.js';
import { _setFirstPartyGroupsForTests, resetFirstPartyCache } from '../../skills/first-party.js';

let db: DatabaseProvider;
let owner: UserRow;
let captured: EnqueueRunInput | null;
let enqueueError: Error | null;

function stubController(): CloudAgentController {
  return {
    async enqueueRun(userId: string, input: EnqueueRunInput) {
      captured = input;
      if (enqueueError) throw enqueueError;
      const workspace = await db.agentRuns.createWorkspace({ user_id: userId, name: input.title });
      return db.agentRuns.createRun({
        user_id: userId,
        workspace_id: workspace.id,
        title: input.title,
        prompt: input.prompt || 'skill run',
        model: input.model,
        session_id: input.sessionId ?? null,
      });
    },
    async pump() {},
  } as unknown as CloudAgentController;
}

async function createSkill(name: string, displayName: string): Promise<SkillRow> {
  return db.skills.create(
    { name, display_name: displayName, description: 'test skill', owner_user_id: owner.id },
    {
      version: '0.1.0',
      changelog: '',
      file_count: 1,
      size_bytes: 10,
      content_hash: `hash-${name}`,
      storage_key: `skills/${name}/0.1.0.json`,
      created_by: owner.id,
    },
  );
}

async function markMissionReady(skill: SkillRow): Promise<void> {
  await db.skills.setScanResult(skill.id, { status: 'clean', findings: [], version: skill.latest_version });
  await db.skills.setScanDecision(skill.id, { status: 'clean', reviewed_by: owner.id });
}

function app() {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: owner.id, role: owner.role });
      await next();
    })
    .route('/', createCloudAgentRoutes());
}

function postRun(body: Record<string, unknown>) {
  return app().request('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /runs — skill launch', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `skill-launch-${Date.now()}-${Math.random()}@test.local` });
    captured = null;
    enqueueError = null;
    _setCloudAgentController(stubController());
    _setFirstPartyGroupsForTests(
      new Map([
        ['pdf-report', 'branding'],
        ['report-two', 'business'],
        ['new-chat-report', 'branding'],
        ['failed-new-chat', 'business'],
      ]),
    );
  });

  afterEach(async () => {
    _setCloudAgentController(null);
    resetFirstPartyCache();
    await db.close();
    _resetProvider();
  });

  it('rejects an unknown skill and a skill that is not mission-ready', async () => {
    expect((await postRun({ prompt: 'go', model: 'pro', skill: 'nope' })).status).toBe(400);

    // Exists, but pending scan — quarantine semantics say launch must refuse.
    await createSkill('pending-skill', 'Pending Skill');
    const res = await postRun({ prompt: 'go', model: 'pro', skill: 'pending-skill' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not available');
    expect(captured).toBeNull();
  });

  it('launches a mission-ready skill, allowing an empty prompt with the title falling back to the display name', async () => {
    const skill = await createSkill('pdf-report', 'PDF Report');
    await markMissionReady(skill);

    const res = await postRun({ model: 'pro', skill: 'pdf-report' });
    expect(res.status).toBe(201);
    expect(captured?.skillName).toBe('pdf-report');
    expect(captured?.prompt).toBe('');
    expect(captured?.title).toBe('PDF Report');
    expect(captured?.writeUserTurn).toBe(false);
  });

  // A reviewed third-party skill is safe to mount in a sandbox but must not be
  // launchable from `/` — the surviving gap between the two predicates now that
  // every repository group is slash-selectable (core/apps retired 2026-08-17).
  it('rejects a mission-ready skill that has no repository group', async () => {
    const skill = await createSkill('app-helper', 'App Helper');
    await markMissionReady(skill);

    const res = await postRun({ model: 'pro', skill: 'app-helper' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('direct launch');
    expect(captured).toBeNull();
  });

  // A browser that last picked a since-retired model keeps sending it; the
  // picker no longer lists it, so a 400 would leave no way out.
  it('runs on the deployment default when the requested model is no longer available', async () => {
    const res = await postRun({ prompt: 'go', model: 'kimi-k3' });
    expect(res.status).toBe(201);
    expect(captured?.model).toBe('flash');
  });

  it('still requires a prompt when no skill is given', async () => {
    expect((await postRun({ model: 'pro' })).status).toBe(400);
  });

  it('write_user_turn requires a bound session and passes through to the controller', async () => {
    const skill = await createSkill('report-two', 'Report Two');
    await markMissionReady(skill);

    expect((await postRun({ model: 'pro', skill: 'report-two', write_user_turn: true })).status).toBe(400);

    const session = await db.sessions.create(undefined, undefined, owner.id);
    const res = await postRun({
      model: 'pro',
      skill: 'report-two',
      prompt: 'summarize the quarter',
      session_id: session.id,
      write_user_turn: true,
    });
    expect(res.status).toBe(201);
    expect(captured?.writeUserTurn).toBe(true);
    expect(captured?.sessionId).toBe(session.id);
    expect(captured?.prompt).toBe('summarize the quarter');
  });

  it('creates a new ordinary session inside admission and binds the accepted run to it', async () => {
    const skill = await createSkill('new-chat-report', 'New Chat Report');
    await markMissionReady(skill);

    const res = await postRun({
      model: 'pro',
      skill: 'new-chat-report',
      prompt: 'prepare the report',
      create_session_profile_id: 'sprouty',
      write_user_turn: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { run: { session_id: string | null } };
    expect(body.run.session_id).toBeTruthy();
    expect(captured?.sessionId).toBe(body.run.session_id);
    const session = await db.sessions.getById(body.run.session_id!);
    expect(session).toMatchObject({ user_id: owner.id, profile_id: 'sprouty', channel: 'web' });
  });

  it('removes a newly-created session when admission fails before a run exists', async () => {
    const skill = await createSkill('failed-new-chat', 'Failed New Chat');
    await markMissionReady(skill);
    enqueueError = new Error('synthetic admission failure');

    const res = await postRun({
      model: 'pro',
      skill: 'failed-new-chat',
      prompt: 'do not leave an empty chat',
      create_session_profile_id: 'sprouty',
      write_user_turn: true,
    });
    expect(res.status).toBe(500);

    const sessions = await db.sessions.list({ userId: owner.id });
    expect(sessions).toHaveLength(0);
  });
});
