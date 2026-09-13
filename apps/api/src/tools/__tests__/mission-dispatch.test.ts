/**
 * mission_dispatch — the draft-only boundary.
 *
 * The whole point of this tool is what it does NOT do: no run row, no
 * container, no queue slot taken. It returns a card and stops. These tests pin
 * that, plus the two things that would otherwise hand the user a card whose
 * Launch button is guaranteed to fail (runtime off, unknown model).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { createMissionDispatchTool } from '../mission-dispatch.js';
import { _setCloudAgentController } from '../../cloud-agent/index.js';

const CTX = { userId: 'u1', sessionId: 'sess-A' };

interface RunRow {
  id: string;
  user_id: string;
  workspace_id: number;
  session_id: string | null;
  created_at: string;
}

interface FileRow {
  id: string;
  session_id: string;
  name: string;
}

function fakeDb(lineage: RunRow[] = [], files: FileRow[] = []) {
  const created: unknown[] = [];
  const db = {
    chatFiles: {
      async listBySessionAndIds(sessionId: string, ids: string[]) {
        return files.filter((f) => f.session_id === sessionId && ids.includes(f.id));
      },
      async listBySession(sessionId: string) {
        return files.filter((f) => f.session_id === sessionId);
      },
    },
    agentRuns: {
      async listRunsBySession(sessionId: string) {
        return lineage.filter((r) => r.session_id === sessionId);
      },
      async createRun(input: unknown) {
        created.push(input);
        throw new Error('mission_dispatch must never create a run');
      },
      async createWorkspace(input: unknown) {
        created.push(input);
        throw new Error('mission_dispatch must never create a workspace');
      },
    },
  } as unknown as DatabaseProvider;
  return { db, created };
}

function dispatch(db: DatabaseProvider, input: Record<string, unknown>) {
  const t = createMissionDispatchTool(db, CTX) as unknown as {
    execute: (i: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute({ prompt: '把 data.csv 转成周报并写入 report.md', ...input });
}

const originalEnabled = process.env.CLOUD_AGENT_ENABLED;
const originalMissionEnabled = process.env.MISSION_ENABLED;

beforeEach(() => {
  process.env.MISSION_ENABLED = '1';
  _setCloudAgentController({} as never);
});

afterEach(() => {
  _setCloudAgentController(null);
  if (originalEnabled === undefined) delete process.env.CLOUD_AGENT_ENABLED;
  else process.env.CLOUD_AGENT_ENABLED = originalEnabled;
  if (originalMissionEnabled === undefined) delete process.env.MISSION_ENABLED;
  else process.env.MISSION_ENABLED = originalMissionEnabled;
});

describe('mission_dispatch', () => {
  it('returns a dispatch artifact and creates nothing', async () => {
    const { db, created } = fakeDb();
    const res = await dispatch(db, {});
    expect(res).toMatchObject({ type: 'mission_dispatch', prompt: '把 data.csv 转成周报并写入 report.md' });
    expect(res.dispatch_id).toMatch(/^cad_[a-f0-9]{16}$/);
    expect(created).toHaveLength(0);
  });

  it('carries the conversation’s existing workspace so a follow-up keeps its context', async () => {
    const { db } = fakeDb([
      { id: 'car_1', user_id: 'u1', workspace_id: 9, session_id: 'sess-A', created_at: '2026-07-31T01:00:00Z' },
      { id: 'car_2', user_id: 'u1', workspace_id: 12, session_id: 'sess-A', created_at: '2026-07-31T02:00:00Z' },
    ]);
    const res = await dispatch(db, {});
    expect(res.workspace_id).toBe(12);
  });

  it('ignores another user’s runs in the lineage', async () => {
    const { db } = fakeDb([
      { id: 'car_1', user_id: 'u2', workspace_id: 9, session_id: 'sess-A', created_at: '2026-07-31T01:00:00Z' },
    ]);
    const res = await dispatch(db, {});
    expect(res.workspace_id).toBeUndefined();
  });

  it('carries conversation attachments the task needs', async () => {
    const { db } = fakeDb([], [{ id: 'f1', session_id: 'sess-A', name: 'data.csv' }]);
    const res = await dispatch(db, { attachment_ids: ['f1'] });
    expect(res.attachments).toEqual([{ file_id: 'f1', name: 'data.csv' }]);
  });

  it('refuses an attachment id from another conversation instead of dropping it', async () => {
    // The model supplies these ids, so a copied one must fail loudly — silently
    // launching without the file would waste a whole sandbox run.
    const { db } = fakeDb([], [{ id: 'f9', session_id: 'sess-OTHER', name: 'secret.csv' }]);
    const res = await dispatch(db, { attachment_ids: ['f9'] });
    expect(String(res.error)).toMatch(/no such attachment/);
    expect(res.attachments).toBeUndefined();
  });

  it('rejects a prompt that references ./inputs/ without attachment_ids, listing the real files', async () => {
    // The observed failure mode: a beautiful brief promising a mounted file,
    // zero ids passed → the sandbox spends its budget hunting for nothing.
    const { db } = fakeDb([], [{ id: 'f1', session_id: 'sess-A', name: 'manual.pdf' }]);
    const res = await dispatch(db, { prompt: '输入文件已挂载在 `./inputs/manual.pdf`，请逐页 OCR。' });
    expect(String(res.error)).toMatch(/attachment_ids is empty/);
    expect(String(res.error)).toContain('f1 (manual.pdf)');
  });

  it('rejects an ./inputs/ prompt when the conversation has no files at all', async () => {
    const { db } = fakeDb();
    const res = await dispatch(db, { prompt: 'Read ./inputs/data.csv and summarize.' });
    expect(String(res.error)).toMatch(/no attached files/);
  });

  it('accepts an ./inputs/ prompt once the attachments are actually passed', async () => {
    const { db } = fakeDb([], [{ id: 'f1', session_id: 'sess-A', name: 'manual.pdf' }]);
    const res = await dispatch(db, {
      prompt: 'OCR `./inputs/manual.pdf` page by page.',
      attachment_ids: ['f1'],
    });
    expect(res.error).toBeUndefined();
    expect(res.attachments).toEqual([{ file_id: 'f1', name: 'manual.pdf' }]);
  });

  it('carries a trimmed title into the artifact', async () => {
    const { db } = fakeDb();
    const res = await dispatch(db, { title: '  ECT 说明书 OCR  ' });
    expect(res.title).toBe('ECT 说明书 OCR');
  });

  it('refuses when the runtime is switched off, instead of handing over a dead card', async () => {
    process.env.MISSION_ENABLED = '0';
    const { db } = fakeDb();
    const res = await dispatch(db, {});
    expect(String(res.error)).toMatch(/not available/);
  });

  it('rejects a model the registry does not know', async () => {
    const { db } = fakeDb();
    const res = await dispatch(db, { model: 'gpt-imaginary' });
    expect(String(res.error)).toMatch(/unknown model/);
  });

  it('rejects a blank prompt', async () => {
    const { db } = fakeDb();
    const res = await dispatch(db, { prompt: '   ' });
    expect(String(res.error)).toMatch(/prompt is required/);
  });
});
