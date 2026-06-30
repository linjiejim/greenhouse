/**
 * Feature Request — Tests
 *
 * Tests the feature_request repository and tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, getDb, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { createFeatureRequestTool } from '../apps/api/src/tools/feature-request.js';

let db: DatabaseProvider;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test' });
  await db.resetSchema();
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

// ─── Repository Tests ────────────────────────────────────

describe('FeatureRequestRepository', () => {
  it('creates a feature request', async () => {
    const request = await db.featureRequests.create({
      title: 'Add PDF export',
      description: 'I need a button to export chat as PDF',
      submitted_by: 'user-123',
      session_id: 'sess-abc',
    });

    expect(request.id).toBeGreaterThan(0);
    expect(request.title).toBe('Add PDF export');
    expect(request.description).toBe('I need a button to export chat as PDF');
    expect(request.submitted_by).toBe('user-123');
    expect(request.status).toBe('pending');
    expect(request.priority).toBe('normal');
    expect(request.session_id).toBe('sess-abc');
  });

  it('gets by ID', async () => {
    const created = await db.featureRequests.create({
      title: 'Test request',
      description: 'Test description',
      submitted_by: 'user-1',
    });

    const fetched = await db.featureRequests.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Test request');
  });

  it('lists with status filter', async () => {
    await db.featureRequests.create({
      title: 'Req 1',
      description: 'Desc 1',
      submitted_by: 'user-1',
    });
    await db.featureRequests.create({
      title: 'Req 2',
      description: 'Desc 2',
      submitted_by: 'user-2',
    });

    // Both should be pending
    const pending = await db.featureRequests.list({ status: 'pending' });
    expect(pending.length).toBe(2);

    // None accepted yet
    const accepted = await db.featureRequests.list({ status: 'accepted' });
    expect(accepted.length).toBe(0);

    // All
    const all = await db.featureRequests.list();
    expect(all.length).toBe(2);
  });

  it('updates status and admin note', async () => {
    const created = await db.featureRequests.create({
      title: 'To update',
      description: 'Will be updated',
      submitted_by: 'user-1',
    });

    const updated = await db.featureRequests.update(created.id, {
      status: 'accepted',
      admin_note: 'Good idea, will implement in v2',
      priority: 'high',
    });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('accepted');
    expect(updated!.admin_note).toBe('Good idea, will implement in v2');
    expect(updated!.priority).toBe('high');
  });

  it('counts by status', async () => {
    await db.featureRequests.create({
      title: 'Req 1',
      description: 'D1',
      submitted_by: 'u1',
    });
    await db.featureRequests.create({
      title: 'Req 2',
      description: 'D2',
      submitted_by: 'u2',
    });

    expect(await db.featureRequests.count()).toBe(2);
    expect(await db.featureRequests.count('pending')).toBe(2);
    expect(await db.featureRequests.count('done')).toBe(0);

    await db.featureRequests.update(1, { status: 'done' });
    expect(await db.featureRequests.count('done')).toBe(1);
    expect(await db.featureRequests.count('pending')).toBe(1);
  });
});

// ─── Tool Tests ──────────────────────────────────────────

describe('FeatureRequestTool', () => {
  it('submits a request via tool', async () => {
    const tool = createFeatureRequestTool(db, {
      userId: 'user-abc',
      userRole: 'member',
      sessionId: 'sess-1',
    });

    const result = await tool.execute({
      action: 'submit',
      title: 'New feature',
      description: 'I want this feature',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).success).toBe(true);
    expect((result as any).request.id).toBeGreaterThan(0);
    expect((result as any).request.status).toBe('pending');
  });

  it('rejects list for non-super users', async () => {
    const tool = createFeatureRequestTool(db, {
      userId: 'user-abc',
      userRole: 'member',
    });

    const result = await tool.execute({
      action: 'list',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).error).toContain('super');
  });

  it('allows list for super users', async () => {
    // Create a request first
    await db.featureRequests.create({
      title: 'Existing',
      description: 'Already here',
      submitted_by: 'someone',
    });

    const tool = createFeatureRequestTool(db, {
      userId: 'admin-1',
      userRole: 'super',
    });

    const result = await tool.execute({
      action: 'list',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).total).toBe(1);
    expect((result as any).requests.length).toBe(1);
  });

  it('allows update for super users', async () => {
    const created = await db.featureRequests.create({
      title: 'To update',
      description: 'Needs update',
      submitted_by: 'user-1',
    });

    const tool = createFeatureRequestTool(db, {
      userId: 'admin-1',
      userRole: 'super',
    });

    const result = await tool.execute({
      action: 'update',
      id: created.id,
      new_status: 'accepted',
      admin_note: 'Approved',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).success).toBe(true);
    expect((result as any).request.status).toBe('accepted');
    expect((result as any).request.admin_note).toBe('Approved');
  });

  it('rejects update for non-super users', async () => {
    const tool = createFeatureRequestTool(db, {
      userId: 'user-abc',
      userRole: 'admin',
    });

    const result = await tool.execute({
      action: 'update',
      id: 1,
      new_status: 'accepted',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).error).toContain('super');
  });

  it('requires title and description for submit', async () => {
    const tool = createFeatureRequestTool(db, {
      userId: 'user-1',
      userRole: 'member',
    });

    const result = await tool.execute({
      action: 'submit',
    }, { toolCallId: 'test', messages: [] });

    expect((result as any).error).toContain('required');
  });
});
