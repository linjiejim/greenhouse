/**
 * E2E Tests — Evaluation System
 *
 * Tests /api/eval/ dataset CRUD and run management:
 * - Dataset create, list, update, delete
 * - Eval runs listing
 * - Auth requirements (admin-only)
 * - Input validation
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL } from './helpers.js';

let teamToken: string;
let legacyRoleToken: string;
const datasetsToClean: number[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  teamToken = createSuperToken();
  // Legacy role vocabulary — must fail closed.
  legacyRoleToken = createTestToken('e2e-eval-member', 'member');
});

afterAll(async () => {
  for (const id of datasetsToClean) {
    await fetch(`${BASE_URL}/api/eval/datasets/${id}`, {
      method: 'DELETE',
      headers: h(teamToken),
    }).catch(() => {});
  }
});

// ─── Dataset CRUD ────────────────────────────────────────

describe('E2E: Eval Dataset CRUD', () => {
  it('creates a dataset entry', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        question: `E2E test question ${UNIQUE}`,
        ground_truth: 'Expected answer',
        category: 'e2e-test',
        difficulty: 'easy',
        language: 'en',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty('id');
    expect(data.question).toContain(UNIQUE);
    datasetsToClean.push(data.id);
  });

  it('lists datasets', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      headers: h(teamToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.datasets)).toBe(true);
  });

  it('filters datasets by category', async () => {
    // Create a dataset with known category
    const createRes = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        question: `Filter test ${UNIQUE}`,
        ground_truth: 'Answer',
        category: `e2e-filter-${UNIQUE}`,
      }),
    });
    const created = await createRes.json();
    datasetsToClean.push(created.id);

    const res = await fetch(`${BASE_URL}/api/eval/datasets?category=e2e-filter-${UNIQUE}`, {
      headers: h(teamToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.datasets.length).toBeGreaterThanOrEqual(1);
    for (const d of data.datasets) {
      expect(d.category).toBe(`e2e-filter-${UNIQUE}`);
    }
  });

  it('updates a dataset entry', async () => {
    const createRes = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        question: `Update test ${UNIQUE}`,
        ground_truth: 'Original',
        category: 'e2e-test',
      }),
    });
    const created = await createRes.json();
    datasetsToClean.push(created.id);

    const updateRes = await fetch(`${BASE_URL}/api/eval/datasets/${created.id}`, {
      method: 'PUT',
      headers: h(teamToken),
      body: JSON.stringify({ ground_truth: 'Updated answer' }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.ground_truth).toBe('Updated answer');
  });

  it('deletes a dataset entry', async () => {
    const createRes = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        question: `Delete test ${UNIQUE}`,
        ground_truth: 'To delete',
        category: 'e2e-test',
      }),
    });
    const created = await createRes.json();

    const delRes = await fetch(`${BASE_URL}/api/eval/datasets/${created.id}`, {
      method: 'DELETE',
      headers: h(teamToken),
    });
    expect(delRes.status).toBe(200);
    const data = await delRes.json();
    expect(data.ok).toBe(true);
  });

  it('returns 404 for non-existent dataset', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets/999999`, {
      method: 'PUT',
      headers: h(teamToken),
      body: JSON.stringify({ ground_truth: 'No such entry' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects creation with missing question field', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        ground_truth: 'An answer without a question',
        category: 'e2e-test',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('question');
  });

  it('rejects creation with missing ground_truth field', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      method: 'POST',
      headers: h(teamToken),
      body: JSON.stringify({
        question: 'A question without ground truth',
        category: 'e2e-test',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('ground_truth');
  });
});

// ─── Eval Runs ───────────────────────────────────────────

describe('E2E: Eval Runs', () => {
  it('lists eval runs', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/runs`, {
      headers: h(teamToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.runs)).toBe(true);
  });

  it('returns 404 for non-existent run', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/runs/999999`, {
      headers: h(teamToken),
    });
    expect(res.status).toBe(404);
  });
});

// ─── Auth Requirements ───────────────────────────────────

describe('E2E: Eval Auth Requirements', () => {
  it('eval rejects tokens with unknown/legacy roles as invalid credentials', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      headers: h(legacyRoleToken),
    });
    expect(res.status).toBe(401);
  });

  it('eval rejects unauthenticated callers', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`);
    expect(res.status).toBe(401);
  });
});
