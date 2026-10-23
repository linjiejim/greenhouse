/**
 * Automations running as a run profile (custom profile): who may pick which one
 * at save time, how it is pinned, and how a run fails — with the reason, never
 * by falling back — when the owner lost access since.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { createTask, updateTask, type TaskActor } from '../task-center.js';
import { prepareTask, validateTaskExecution } from '../executor.js';

let db: DatabaseProvider;
let maya: UserRow;
let bob: UserRow;
let admin: UserRow;

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const actor = (user: UserRow): TaskActor => ({ userId: user.id, role: user.role, scope: 'any' });

async function runProfile(owner: UserRow, shared: boolean) {
  const profile = await db.customProfiles.create({
    slug: unique('rp'),
    user_id: owner.id,
    name: `${owner.nickname} digest`,
    base_profile_id: 'sprouty',
    model_id: 'flash',
    tools: [],
    system_prompt: 'Write a short digest.',
    max_steps: 8,
    created_by: owner.id,
  });
  // Creating is always private; team availability is switched separately (by a super in the app).
  if (shared) await db.customProfiles.setShared(profile.id, true);
  return profile;
}

function automation(profileId: string) {
  return {
    name: unique('Digest').slice(0, 40),
    task_prompt: 'Summarize what changed in the team knowledge base today, in five bullets.',
    schedule: '0 9 * * 1-5',
    timezone: 'UTC',
    profile_id: profileId,
    enabled: false,
  };
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  maya = await createInternalTestUser(db, { email: `${unique('rp-maya')}@test.local`, nickname: 'Maya' });
  bob = await createInternalTestUser(db, { email: `${unique('rp-bob')}@test.local`, nickname: 'Bob' });
  admin = await createInternalTestUser(db, { email: `${unique('rp-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('automations on a run profile — save', () => {
  it('pins the owner’s own or a team-shared run profile to its current version', async () => {
    const own = await runProfile(maya, false);
    const created = await createTask(db, actor(maya), automation(`custom:${own.id}`));
    expect(created).toMatchObject({ ok: true, task: { profile_id: `custom:${own.id}@1` } });

    const shared = await runProfile(bob, true);
    const onShared = await createTask(db, actor(maya), automation(`custom:${shared.id}`));
    expect(onShared).toMatchObject({ ok: true, task: { profile_id: `custom:${shared.id}@1` } });

    // System profiles stay available.
    expect(await createTask(db, actor(maya), automation('sprouty'))).toMatchObject({ ok: true });
  });

  it('refuses a teammate’s private run profile', async () => {
    const theirs = await runProfile(bob, false);
    const result = await createTask(db, actor(maya), automation(`custom:${theirs.id}`));
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('checks the owner, not the editor: a super cannot hand a member a profile the member may not use', async () => {
    const created = await createTask(db, actor(maya), automation('sprouty'));
    if (!created.ok) throw new Error(created.error);
    const adminsPrivate = await runProfile(admin, false);

    const result = await updateTask(db, actor(admin), created.task.id, { profile_id: `custom:${adminsPrivate.id}` });
    expect(result).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringMatching(/owner/) });

    const mine = await runProfile(maya, false);
    const switched = await updateTask(db, actor(admin), created.task.id, { profile_id: `custom:${mine.id}` });
    expect(switched).toMatchObject({ ok: true, task: { profile_id: `custom:${mine.id}@1` } });
  });

  it('keeps an existing pin when the automation is saved without changing its profile', async () => {
    const own = await runProfile(maya, false);
    const created = await createTask(db, actor(maya), automation(`custom:${own.id}`));
    if (!created.ok) throw new Error(created.error);
    await db.customProfiles.createVersion(own.id, { change_log: 'v2', created_by: maya.id });

    const kept = await updateTask(db, actor(maya), created.task.id, {
      name: 'Renamed digest',
      profile_id: created.task.profile_id,
    });
    expect(kept).toMatchObject({ ok: true, task: { profile_id: `custom:${own.id}@1` } });
    const repinned = await updateTask(db, actor(maya), created.task.id, { profile_id: `custom:${own.id}` });
    expect(repinned).toMatchObject({ ok: true, task: { profile_id: `custom:${own.id}@2` } });
  });
});

describe('automations on a run profile — run', () => {
  it('runs as the pinned run profile while the owner may use it', async () => {
    const shared = await runProfile(bob, true);
    const created = await createTask(db, actor(maya), automation(`custom:${shared.id}`));
    if (!created.ok) throw new Error(created.error);
    const task = (await db.scheduledTasks.getById(created.task.id))!;
    await expect(validateTaskExecution(task, db)).resolves.toBeUndefined();
  });

  it('fails with the reason when the profile is no longer shared, instead of falling back', async () => {
    const shared = await runProfile(bob, true);
    const created = await createTask(db, actor(maya), automation(`custom:${shared.id}`));
    if (!created.ok) throw new Error(created.error);
    const task = (await db.scheduledTasks.getById(created.task.id))!;
    await db.customProfiles.setShared(shared.id, false);

    await expect(validateTaskExecution(task, db)).rejects.toThrow(/run profile "Bob digest" access was revoked/);
    await expect(prepareTask(task, {}, db)).rejects.toThrow(/access was revoked/);
    // Nothing ran: no session was created for the refused occurrence.
    expect(await db.sessions.list({ userId: maya.id, channel: 'task' })).toEqual([]);
  });

  it('fails with the reason when the profile was deleted', async () => {
    const own = await runProfile(maya, false);
    const created = await createTask(db, actor(maya), automation(`custom:${own.id}`));
    if (!created.ok) throw new Error(created.error);
    const task = (await db.scheduledTasks.getById(created.task.id))!;
    await db.customProfiles.delete(own.id);
    await expect(validateTaskExecution(task, db)).rejects.toThrow(/run profile no longer exists/);
  });
});
