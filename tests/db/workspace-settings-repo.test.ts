/**
 * Workspace settings service integration tests.
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

describe('Workspace settings service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('upserts plain values into `value` and keeps `value_enc` null', async () => {
    const row = await db.workspaceSettings.set('llm.model', { value: 'gpt-4o-mini' }, 'user-1');
    expect(row.key).toBe('llm.model');
    expect(row.value).toBe('gpt-4o-mini');
    expect(row.value_enc).toBeNull();
    expect(row.updated_by).toBe('user-1');
  });

  it('upserts secrets into `value_enc` and keeps `value` null', async () => {
    const row = await db.workspaceSettings.set('llm.api_key', { value_enc: 'ciphertext' });
    expect(row.value_enc).toBe('ciphertext');
    expect(row.value).toBeNull();
  });

  it('overwrites on conflict — including switching columns', async () => {
    await db.workspaceSettings.set('llm.model', { value: 'a' });
    const updated = await db.workspaceSettings.set('llm.model', { value_enc: 'enc' });
    expect(updated.value).toBeNull();
    expect(updated.value_enc).toBe('enc');
    expect((await db.workspaceSettings.list()).length).toBe(1);
  });

  it('stores structured json values', async () => {
    const avatar = { color: 'ocean', accessories: ['magnifier'], palette: { body: '#112233', leaf: '#445566' } };
    await db.workspaceSettings.set('branding.team_avatar', { value: avatar });
    const row = await db.workspaceSettings.get('branding.team_avatar');
    expect(row?.value).toEqual(avatar);
  });

  it('clear removes the row and reports whether it existed', async () => {
    await db.workspaceSettings.set('llm.model', { value: 'x' });
    expect(await db.workspaceSettings.clear('llm.model')).toBe(true);
    expect(await db.workspaceSettings.clear('llm.model')).toBe(false);
    expect(await db.workspaceSettings.get('llm.model')).toBeUndefined();
  });

  it('lists rows ordered by key', async () => {
    await db.workspaceSettings.set('search.tavily_api_key', { value_enc: 'e' });
    await db.workspaceSettings.set('branding.product_name', { value: 'Acme' });
    const keys = (await db.workspaceSettings.list()).map((r) => r.key);
    expect(keys).toEqual(['branding.product_name', 'search.tavily_api_key']);
  });
});
