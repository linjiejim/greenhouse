import { afterAll, beforeEach, onTestFinished } from 'vitest';
import {
  closeIntegrationTestConnection,
  startIntegrationTestTransaction,
  TEST_DATABASE_URL,
  type TestTransaction,
} from '@greenhouse/db/test-config';

let activeTransaction: TestTransaction | null = null;

beforeEach(async () => {
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
