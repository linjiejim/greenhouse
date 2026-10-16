import { expect, it } from 'vitest';
import { getDb, transaction } from '@greenhouse/db';
import { createTablesWorker } from '../worker.js';

it('starts the tables worker outside the transaction that wakes it', async () => {
  const db = getDb();
  const worker = createTablesWorker();
  worker.register('base_recompute', async () => ({ status: 'succeeded' }));
  let finish: (value: boolean) => void = () => undefined;
  const observed = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  worker.every(async () => {
    finish(getDb() === db);
  });
  try {
    await transaction(async () => {
      worker.start();
      worker.kick();
    });
    expect(await observed).toBe(true);
  } finally {
    await worker.stop();
  }
});
