/**
 * Tests for Compute tool — isolated-vm sandbox executor.
 */

import { describe, it, expect } from 'vitest';
import { executeCompute } from '../apps/api/src/tools/compute/executor.js';

describe('ComputeExecutor', () => {
  // ── Basic execution ──────────────────────────────────

  it('executes a simple compute function', async () => {
    const code = `function compute(data) { return data.a + data.b; }`;
    const result = await executeCompute(code, { a: 2, b: 3 });

    expect(result.success).toBe(true);
    expect(result.result).toBe(5);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles async compute function', async () => {
    const code = `async function compute(data) { return data.x * 2; }`;
    const result = await executeCompute(code, { x: 21 });

    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
  });

  it('returns complex objects', async () => {
    const code = `
      function compute(data) {
        const sum = data.values.reduce((a, b) => a + b, 0);
        const avg = sum / data.values.length;
        return { sum, avg, count: data.values.length };
      }
    `;
    const result = await executeCompute(code, { values: [10, 20, 30, 40] });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ sum: 100, avg: 25, count: 4 });
  });

  it('handles empty data', async () => {
    const code = `function compute(data) { return { keys: Object.keys(data) }; }`;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ keys: [] });
  });

  it('handles null/undefined data gracefully', async () => {
    const code = `function compute(data) { return data == null ? 'no data' : 'has data'; }`;
    const result = await executeCompute(code, null);

    expect(result.success).toBe(true);
    expect(result.result).toBe('no data');
  });

  // ── Data analysis patterns ───────────────────────────

  it('performs group-by aggregation', async () => {
    const code = `
      function compute(data) {
        const grouped = {};
        for (const item of data.items) {
          grouped[item.category] = (grouped[item.category] || 0) + item.amount;
        }
        return grouped;
      }
    `;
    const data = {
      items: [
        { category: 'A', amount: 10 },
        { category: 'B', amount: 20 },
        { category: 'A', amount: 30 },
        { category: 'B', amount: 5 },
        { category: 'C', amount: 15 },
      ],
    };
    const result = await executeCompute(code, data);

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ A: 40, B: 25, C: 15 });
  });

  it('computes percentile', async () => {
    const code = `
      function compute(data) {
        const sorted = [...data.values].sort((a, b) => a - b);
        const p50Idx = Math.floor(sorted.length * 0.5);
        const p90Idx = Math.floor(sorted.length * 0.9);
        return {
          min: sorted[0],
          max: sorted[sorted.length - 1],
          p50: sorted[p50Idx],
          p90: sorted[p90Idx],
        };
      }
    `;
    const result = await executeCompute(code, { values: [1, 5, 3, 8, 2, 9, 4, 7, 6, 10] });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ min: 1, max: 10 });
  });

  it('handles date calculations', async () => {
    const code = `
      function compute(data) {
        const dates = data.timestamps.map(t => new Date(t));
        const diffs = [];
        for (let i = 1; i < dates.length; i++) {
          diffs.push((dates[i] - dates[i-1]) / (1000 * 60 * 60)); // hours
        }
        const avgHours = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        return { avgHoursBetween: Math.round(avgHours * 10) / 10 };
      }
    `;
    const result = await executeCompute(code, {
      timestamps: ['2026-01-01T00:00:00Z', '2026-01-01T12:00:00Z', '2026-01-02T00:00:00Z'],
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ avgHoursBetween: 12 });
  });

  // ── Console.log ──────────────────────────────────────

  it('captures console.log output', async () => {
    const code = `
      function compute(data) {
        console.log('processing', data.items.length, 'items');
        console.warn('this is a warning');
        return { done: true };
      }
    `;
    const result = await executeCompute(code, { items: [1, 2, 3] });

    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]).toContain('processing');
    expect(result.logs[0]).toContain('3');
    expect(result.logs[1]).toContain('[WARN]');
  });

  it('limits log entries', async () => {
    const code = `
      function compute(data) {
        for (let i = 0; i < 200; i++) console.log('line ' + i);
        return { done: true };
      }
    `;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.logs.length).toBeLessThanOrEqual(100);
  });

  // ── Error handling ───────────────────────────────────

  it('reports missing compute function', async () => {
    const code = `function notCompute(data) { return data; }`;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('compute(data)');
  });

  it('reports runtime errors', async () => {
    const code = `
      function compute(data) {
        return data.nested.deep.value; // TypeError: Cannot read property
      }
    `;
    const result = await executeCompute(code, { nested: null });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('reports syntax errors', async () => {
    const code = `function compute(data { return data; }`; // missing )
    const result = await executeCompute(code, {});

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('handles thrown errors', async () => {
    const code = `
      function compute(data) {
        if (!data.required) throw new Error('required field missing');
        return data;
      }
    `;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('required field missing');
  });

  // ── Security & limits ────────────────────────────────

  it('has no access to require/import', async () => {
    const code = `
      function compute(data) {
        try { const fs = require('fs'); return { hacked: true }; }
        catch (e) { return { blocked: true, error: e.message }; }
      }
    `;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ blocked: true });
  });

  it('has no access to process', async () => {
    const code = `
      function compute(data) {
        return { hasProcess: typeof process !== 'undefined' };
      }
    `;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ hasProcess: false });
  });

  it('has no access to global fetch', async () => {
    const code = `
      function compute(data) {
        return { hasFetch: typeof fetch !== 'undefined' };
      }
    `;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ hasFetch: false });
  });

  it('enforces timeout', async () => {
    const code = `
      function compute(data) {
        while (true) {} // infinite loop
        return { done: true };
      }
    `;
    const result = await executeCompute(code, {}, { timeoutMs: 500 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 10_000);

  it('enforces output size limit', async () => {
    const code = `
      function compute(data) {
        // Generate ~300KB of output
        return { big: 'x'.repeat(300 * 1024) };
      }
    `;
    const result = await executeCompute(code, {}, { maxOutputBytes: 256 * 1024 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('256KB');
  });

  it('handles non-serializable return (undefined)', async () => {
    const code = `function compute(data) { /* no return */ }`;
    const result = await executeCompute(code, {});

    // JSON.stringify(undefined) → undefined (not a string), should be caught
    expect(result.success).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────

  it('handles large dataset', async () => {
    const code = `
      function compute(data) {
        const sum = data.numbers.reduce((a, b) => a + b, 0);
        return { sum, count: data.numbers.length };
      }
    `;
    const numbers = Array.from({ length: 10000 }, (_, i) => i + 1);
    const result = await executeCompute(code, { numbers });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ sum: 50005000, count: 10000 });
  });

  it('handles nested data structures', async () => {
    const code = `
      function compute(data) {
        return data.users.flatMap(u => u.orders).reduce((sum, o) => sum + o.total, 0);
      }
    `;
    const data = {
      users: [
        { name: 'Alice', orders: [{ total: 100 }, { total: 200 }] },
        { name: 'Bob', orders: [{ total: 50 }] },
      ],
    };
    const result = await executeCompute(code, data);

    expect(result.success).toBe(true);
    expect(result.result).toBe(350);
  });

  it('supports array as return value', async () => {
    const code = `
      function compute(data) {
        return data.items.map(i => i * 2).filter(i => i > 5);
      }
    `;
    const result = await executeCompute(code, { items: [1, 2, 3, 4, 5] });

    expect(result.success).toBe(true);
    expect(result.result).toEqual([6, 8, 10]);
  });

  it('supports string as return value', async () => {
    const code = `function compute(data) { return 'hello ' + data.name; }`;
    const result = await executeCompute(code, { name: 'world' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('hello world');
  });

  it('supports numeric return value', async () => {
    const code = `function compute(data) { return Math.PI; }`;
    const result = await executeCompute(code, {});

    expect(result.success).toBe(true);
    expect(result.result).toBeCloseTo(3.14159, 4);
  });

  it('supports boolean return value', async () => {
    const code = `function compute(data) { return data.value > 10; }`;
    const result = await executeCompute(code, { value: 15 });

    expect(result.success).toBe(true);
    expect(result.result).toBe(true);
  });
});
