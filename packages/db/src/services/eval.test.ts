/**
 * Eval dataset writers normalize `ground_truth` before it reaches the table.
 * Unit test: a recording stand-in for the two drizzle calls the writers make,
 * no PostgreSQL.
 */

import { describe, expect, it } from 'vitest';
import type { Db } from '../client.js';
import { createEvalService } from './eval.js';

function recordingDb() {
  const inserted: Array<Record<string, unknown>> = [];
  const insert = () => ({
    values: (values: Record<string, unknown>) => {
      inserted.push(values);
      // Awaited directly by importDatasets, `.returning()`-ed by createDataset.
      return Object.assign(Promise.resolve(), {
        returning: async () => [{ id: inserted.length, ...values }],
      });
    },
  });
  const db = { insert, transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ insert }) };
  return { db: db as unknown as Db, inserted };
}

describe('eval dataset ground truth on write', () => {
  it('createDataset stores a plain-string ground truth as a one-fact JSON array', async () => {
    const { db, inserted } = recordingDb();
    const created = await createEvalService(db).createDataset({
      category: 'faq',
      question: 'What is the stipend?',
      ground_truth: 'A one-time $1,000 setup stipend',
    });
    expect(inserted[0]?.ground_truth).toBe('["A one-time $1,000 setup stipend"]');
    expect(created.ground_truth).toBe('["A one-time $1,000 setup stipend"]');
  });

  it('createDataset keeps a JSON array of facts as it is', async () => {
    const { db, inserted } = recordingDb();
    await createEvalService(db).createDataset({ category: 'faq', question: 'Q?', ground_truth: '["Fact A","Fact B"]' });
    expect(inserted[0]?.ground_truth).toBe('["Fact A","Fact B"]');
  });

  it('importDatasets normalizes every item', async () => {
    const { db, inserted } = recordingDb();
    const count = await createEvalService(db).importDatasets([
      { category: 'faq', question: 'Q1?', ground_truth: 'One fact' },
      { category: 'faq', question: 'Q2?', ground_truth: '["Fact A","Fact B"]' },
    ]);
    expect(count).toBe(2);
    expect(inserted.map((row) => row.ground_truth)).toEqual(['["One fact"]', '["Fact A","Fact B"]']);
  });
});
