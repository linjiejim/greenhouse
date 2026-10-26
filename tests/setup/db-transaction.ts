import { afterAll, beforeEach, onTestFinished } from 'vitest';
import {
  closeIntegrationTestConnection,
  startIntegrationTestTransaction,
  TEST_DATABASE_URL,
  type TestTransaction,
} from '@greenhouse/db/test-config';

let activeTransaction: TestTransaction | null = null;

beforeEach(async () => {
  // Register active service factories after each file has installed its provider mocks.
  await import('../../apps/api/src/extensions/index.js');
  if (activeTransaction) await activeTransaction.rollback();
  const transaction = await startIntegrationTestTransaction(TEST_DATABASE_URL);
  activeTransaction = transaction;

  onTestFinished(async () => {
    await transaction.rollback();
    if (activeTransaction === transaction) activeTransaction = null;
  });
});

afterAll(async () => {
  await activeTransaction?.rollback();
  activeTransaction = null;
  await closeIntegrationTestConnection();
});
