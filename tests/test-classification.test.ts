import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TRANSACTION_DB_TEST = /\.db\.test\.[cm]?[jt]sx?$/;
const COMMITTED_DB_TEST = /\.db-commit\.test\.[cm]?[jt]sx?$/;

function collectTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.claude') return [];
      return collectTestFiles(path);
    }
    return TEST_FILE.test(entry.name) ? [path] : [];
  });
}

describe('test suite classification', () => {
  const testFiles = ['apps', 'packages', 'tests'].flatMap(collectTestFiles);

  it('classifies tests that use the real test database as db tests', () => {
    const incorrectlyClassified = testFiles.filter((path) => {
      const source = readFileSync(path, 'utf8');
      const usesRealDatabase = /from\s+['"]@greenhouse\/db\/test-config['"]/.test(source);
      return usesRealDatabase && !TRANSACTION_DB_TEST.test(path) && !COMMITTED_DB_TEST.test(path);
    });

    expect(incorrectlyClassified).toEqual([]);
  });

  it('documents why committed-state database tests cannot use transaction rollback', () => {
    const undocumented = testFiles.filter((path) => {
      if (!COMMITTED_DB_TEST.test(path)) return false;
      return !readFileSync(path, 'utf8').includes('@db-commit-reason');
    });

    expect(undocumented).toEqual([]);
  });

  it('keeps individual database test files free of whole-database resets', () => {
    const destructiveDatabaseTests = testFiles.filter((path) => {
      if (!TRANSACTION_DB_TEST.test(path) && !COMMITTED_DB_TEST.test(path)) return false;
      return readFileSync(path, 'utf8').includes('.resetSchema(');
    });

    expect(destructiveDatabaseTests).toEqual([]);
  });
});
