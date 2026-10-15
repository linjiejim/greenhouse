import { disposeTestServices } from '../../apps/api/src/testing.js';
import { afterAll, beforeEach, onTestFinished } from 'vitest';
import { closeTestConnection, startTestTransaction } from '@greenhouse/db/testing';

// Every test runs in its own transaction, rolled back when it finishes.
beforeEach(async () => {
  const transaction = await startTestTransaction();
  onTestFinished(async () => {
    try {
      await disposeTestServices();
    } finally {
      await transaction.rollback();
    }
  });
});

afterAll(() => closeTestConnection());
