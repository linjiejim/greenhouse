import { describe, expect, it } from 'vitest';

import { assertSafeTestDatabase } from './test-config.js';

describe('assertSafeTestDatabase', () => {
  it('accepts a loopback database whose name says it is disposable', () => {
    expect(() => assertSafeTestDatabase('postgresql://u:p@127.0.0.1:55440/lane_test')).not.toThrow();
    expect(() => assertSafeTestDatabase('postgresql://u:p@localhost:5432/greenhouse_e2e')).not.toThrow();
  });

  it('refuses a database that is not clearly a test database', () => {
    expect(() => assertSafeTestDatabase('postgresql://u:p@127.0.0.1:55440/greenhouse', '')).toThrow(/Refusing/);
    expect(() => assertSafeTestDatabase('postgresql://u:p@db.example.com:5432/app_test', '')).toThrow(/Refusing/);
  });

  it('refuses to run when TEST_DATABASE_URL was never set outside CI', () => {
    expect(() =>
      assertSafeTestDatabase(
        'postgresql://unset@invalid.test/set_TEST_DATABASE_URL',
        'I_UNDERSTAND_TEST_DATABASE_IS_DESTRUCTIVE',
      ),
    ).toThrow(/TEST_DATABASE_URL is not set/);
  });
});
