/**
 * Task (prompt) route integration tests.
 *
 * The interesting rule is the cross-check between declared variables and the
 * `{{placeholders}}` in the body: a variable with no placeholder renders a form
 * field that changes nothing, and the user cannot see that from the card.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

// The router reads the caller through getAuthUser; the central middleware that
// normally populates it is not mounted here (hono itself is not resolvable from
// the repo-root test dir), so the identity is injected at that seam instead.
let actor: UserRow | null = null;
vi.mock('../../apps/api/src/auth/middleware.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAuthUser: () => actor,
}));

import prompts from '../../apps/api/src/routes/prompts.js';

let db: DatabaseProvider;
let user: UserRow;

async function post(body: unknown): Promise<Response> {
  return prompts.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Task routes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `task-${Date.now()}-${Math.random()}@test.local` });
    actor = user;
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('creates a plain task, defaulting the new columns', async () => {
    const res = await post({ title: 'Weekly report', content: 'Write the weekly report.' });
    expect(res.status).toBe(201);

    const row = (await res.json()) as Record<string, unknown>;
    expect(row).toMatchObject({
      title: 'Weekly report',
      variables: '[]',
      expected_tools: '[]',
      created_via: 'manual',
      description: null,
    });
  });

  it('stores variables that match placeholders in the body', async () => {
    const res = await post({
      title: 'Sales',
      content: 'Summarise {{month}} sales for {{region}}.',
      variables: [
        { key: 'month', label: 'Month', required: true },
        { key: 'region', label: 'Region' },
      ],
      expected_tools: ['crm_query', 'crm_query', 'export_data'],
      created_via: 'capture',
      source_session_id: 'sess-1',
    });
    expect(res.status).toBe(201);

    const row = (await res.json()) as Record<string, unknown>;
    expect(JSON.parse(row.variables as string)).toHaveLength(2);
    // Deduped, so a repeated call in the captured run does not double-list.
    expect(JSON.parse(row.expected_tools as string)).toEqual(['crm_query', 'export_data']);
    expect(row.created_via).toBe('capture');
    expect(row.source_session_id).toBe('sess-1');
  });

  it('rejects a variable with no placeholder in the body', async () => {
    const res = await post({
      title: 'Sales',
      content: 'Summarise sales.',
      variables: [{ key: 'month', label: 'Month' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('{{month}}');
  });

  it('rejects duplicate and malformed variable keys', async () => {
    const dup = await post({
      title: 'T',
      content: '{{a}}',
      variables: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'A again' },
      ],
    });
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toContain('duplicate');

    const bad = await post({ title: 'T', content: '{{a}}', variables: [{ key: '1a', label: 'A' }] });
    expect(bad.status).toBe(400);
  });

  it('keeps is_global a super-only field', async () => {
    const res = await post({ title: 'T', content: 'x', is_global: true });
    expect(res.status).toBe(403);
  });

  it('keeps Mine and Shared disjoint and rejects Team for members', async () => {
    const other = await createInternalTestUser(db, {
      email: `task-other-${Date.now()}-${Math.random()}@test.local`,
      nickname: 'Other owner',
    });
    const mine = await db.userPrompts.create({ user_id: user.id, title: 'Mine private', content: 'mine' });
    const mineShared = await db.userPrompts.create({
      user_id: user.id,
      title: 'Mine shared',
      content: 'mine shared',
      is_global: true,
    });
    const shared = await db.userPrompts.create({
      user_id: other.id,
      title: 'Shared by other',
      content: 'shared',
      is_global: true,
    });
    const privateOther = await db.userPrompts.create({
      user_id: other.id,
      title: 'Private other',
      content: 'private',
    });

    const mineResponse = await prompts.request('/?scope=mine');
    const mineIds = ((await mineResponse.json()) as { prompts: Array<{ id: number }> }).prompts.map((row) => row.id);
    expect(mineIds).toEqual(expect.arrayContaining([mine.id, mineShared.id]));
    expect(mineIds).not.toContain(shared.id);

    const sharedResponse = await prompts.request('/?scope=shared');
    const sharedRows = (await sharedResponse.json()) as {
      prompts: Array<{ id: number; owner_nickname?: string }>;
    };
    expect(sharedRows.prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: shared.id, owner_nickname: 'Other owner' })]),
    );
    expect(sharedRows.prompts.map((row) => row.id)).not.toContain(mineShared.id);
    expect(sharedRows.prompts.map((row) => row.id)).not.toContain(privateOther.id);

    expect((await prompts.request('/?scope=team')).status).toBe(403);
  });

  it('lets super inspect only other users private Tasks in Team scope', async () => {
    const superUser = await createInternalTestUser(db, {
      email: `task-super-${Date.now()}-${Math.random()}@test.local`,
      nickname: 'Admin',
      role: 'super',
    });
    const other = await createInternalTestUser(db, {
      email: `task-team-${Date.now()}-${Math.random()}@test.local`,
      nickname: 'Team owner',
    });
    const privateOther = await db.userPrompts.create({ user_id: other.id, title: 'Team private', content: 'private' });
    const sharedOther = await db.userPrompts.create({
      user_id: other.id,
      title: 'Team shared',
      content: 'shared',
      is_global: true,
    });
    const own = await db.userPrompts.create({ user_id: superUser.id, title: 'Admin private', content: 'own' });
    actor = superUser;

    const response = await prompts.request('/?scope=team');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { prompts: Array<{ id: number; owner_nickname?: string }> };
    expect(body.prompts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: privateOther.id, owner_nickname: 'Team owner' })]),
    );
    expect(body.prompts.map((row) => row.id)).not.toContain(sharedOther.id);
    expect(body.prompts.map((row) => row.id)).not.toContain(own.id);
  });

  it('validates updated variables against the body being saved in the same request', async () => {
    const created = await post({ title: 'T', content: 'Report {{a}}.', variables: [{ key: 'a', label: 'A' }] });
    const id = ((await created.json()) as { id: number }).id;

    // Renaming the placeholder and the variable together must pass — checking
    // the new variables against the STORED body would reject this forever.
    const ok = await prompts.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Report {{b}}.', variables: [{ key: 'b', label: 'B' }] }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(((await ok.json()) as { variables: string }).variables)[0].key).toBe('b');
  });

  it('rejects a content-only edit that would orphan a stored variable', async () => {
    const created = await post({ title: 'T', content: 'Report {{a}}.', variables: [{ key: 'a', label: 'A' }] });
    const id = ((await created.json()) as { id: number }).id;

    // The Settings form edits content without a variables editor — removing
    // the placeholder must not leave the stored variable rendering a form
    // field that substitutes into nothing.
    const res = await prompts.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Report, no placeholders.' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('{{a}}');

    // The stored row is untouched by the rejected edit.
    const row = await db.userPrompts.getById(id);
    expect(row!.content).toBe('Report {{a}}.');
  });

  it('accepts a content-only edit that keeps every stored placeholder', async () => {
    const created = await post({ title: 'T', content: 'Report {{a}}.', variables: [{ key: 'a', label: 'A' }] });
    const id = ((await created.json()) as { id: number }).id;

    const res = await prompts.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Extended report about {{a}} with more words.' }),
    });
    expect(res.status).toBe(200);

    // And a placeholder removal passes when the caller prunes the variable in
    // the same request — the path the Settings form takes.
    const pruned = await prompts.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Report, no placeholders.', variables: [] }),
    });
    expect(pruned.status).toBe(200);
    expect(((await pruned.json()) as { variables: string }).variables).toBe('[]');
  });
});
