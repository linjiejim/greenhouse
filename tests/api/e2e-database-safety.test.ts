import { describe, expect, it } from 'vitest';
import { assertSafeE2eDatabase } from '../e2e/database-safety.js';

describe('E2E database safety gate', () => {
  it.each([
    'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test',
    'postgresql://greenhouse:greenhouse@127.0.0.1:5439/greenhouse_e2e',
    'postgresql://greenhouse:greenhouse@[::1]:5432/test_database',
  ])('allows an unmistakably local disposable database: %s', (url) => {
    expect(() => assertSafeE2eDatabase(url)).not.toThrow();
  });

  it.each([
    'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse',
    'postgresql://greenhouse:greenhouse@db.internal:5432/greenhouse_test',
    'postgresql://greenhouse:greenhouse@prod.internal:5432/greenhouse',
  ])('rejects a database that could be shared or persistent: %s', (url) => {
    expect(() => assertSafeE2eDatabase(url)).toThrow(/Refusing destructive E2E/);
  });

  it('requires the exact explicit override for an exceptional target', () => {
    const url = 'postgresql://greenhouse:greenhouse@ci-postgres:5432/isolated_job_db';
    expect(() => assertSafeE2eDatabase(url, 'yes')).toThrow();
    expect(() => assertSafeE2eDatabase(url, 'I_UNDERSTAND_E2E_IS_DESTRUCTIVE')).not.toThrow();
  });
});
