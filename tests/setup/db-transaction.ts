import { afterAll, beforeEach, onTestFinished } from 'vitest';
import { closeTestConnection, startTestTransaction } from '@greenhouse/db/testing';

// Every test runs in its own transaction, rolled back when it finishes.
beforeEach(async () => {
  const transaction = await startTestTransaction();
  onTestFinished(() => transaction.rollback());
});

afterAll(() => closeTestConnection());
