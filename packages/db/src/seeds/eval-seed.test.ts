/**
 * The starter eval set is only useful if its facts are true: every case tagged
 * `example-kb` must name a published, team-visible doc of the example dataset
 * (`data/examples/knowledge_base.json`) and every number in its facts must
 * appear in that doc. The first seed asked about a 30-day expense deadline and
 * SSO methods that no example document mentions.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGroundTruth } from '@greenhouse/types/eval';
import { SEED_DATASETS } from './eval-seed.js';

interface ExampleDoc {
  doc_id: string;
  content: string;
  status: string;
  visibility: string;
}

/** The example dataset is JSONL: one row per line, blank lines and `//` comments allowed. */
function exampleDocs(): Map<string, ExampleDoc> {
  const raw = readFileSync(new URL('../../../../data/examples/knowledge_base.json', import.meta.url), 'utf8');
  const docs = new Map<string, ExampleDoc>();
  for (const line of raw.split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('//')) continue;
    const doc = JSON.parse(row) as ExampleDoc;
    docs.set(doc.doc_id, doc);
  }
  return docs;
}

describe('eval starter set', () => {
  it('stores every ground truth as a non-empty JSON array of facts', () => {
    for (const item of SEED_DATASETS) {
      const stored = JSON.parse(item.ground_truth) as unknown;
      expect(Array.isArray(stored), item.question).toBe(true);
      expect(stored, item.question).toEqual(parseGroundTruth(item.ground_truth));
      expect(parseGroundTruth(item.ground_truth).length, item.question).toBeGreaterThan(0);
    }
  });

  it('grounds every example-kb case in a published team document of the example dataset', () => {
    const docs = exampleDocs();
    const grounded = SEED_DATASETS.filter((item) => item.tags?.includes('example-kb'));
    expect(grounded.length).toBeGreaterThanOrEqual(4);
    for (const item of grounded) {
      const docId = /`([a-z0-9-]+)`/.exec(item.notes ?? '')?.[1];
      const doc = docId ? docs.get(docId) : undefined;
      expect(doc, `${item.question} → ${docId ?? 'no source doc in notes'}`).toBeDefined();
      expect(doc?.status).toBe('published');
      expect(doc?.visibility).toBe('team');
      for (const fact of parseGroundTruth(item.ground_truth)) {
        for (const match of fact.match(/\d[\d,.:]*/g) ?? []) {
          const number = match.replace(/[,.:]+$/, '');
          expect(doc?.content, `"${number}" in "${fact}" is not in ${docId}`).toContain(number);
        }
      }
    }
  });
});
