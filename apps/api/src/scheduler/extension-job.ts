/** Share one scheduled occurrence across replicas, retaining the existing durable claim. */
import { getDb } from '@greenhouse/db';
export async function runExtensionJob(id: string, run: () => Promise<void> | void, at = new Date()): Promise<void> {
  const db = getDb();
  await db.withAdvisoryLock(`extension-job:${id}`, async () => {
    const minute = Math.floor(at.getTime() / 60_000);
    const claimed = await db.rateLimits.hit(
      `extension-job:${id}:${minute}`,
      new Date(Date.now() + 120_000).toISOString(),
    );
    if (claimed === 1) await run();
  });
}
