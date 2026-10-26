import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { initDatabase } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { sql } from 'drizzle-orm';
it('retains receipts for seven days through the plugin retention contribution', async () => {
  const db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const oldId = randomUUID();
  const newId = randomUUID();
  await db.executeRaw(
    sql`INSERT INTO feishu_receipts (message_id,received_at) VALUES (${oldId},'2026-10-01'),(${newId},'2026-10-26')`,
  );
  const report = await db.retention.run({ now: new Date('2026-10-27T00:00:00Z') });
  expect(report.feishu_receipts).toBeGreaterThanOrEqual(1);
  expect(
    await db.executeRaw(sql`SELECT message_id FROM feishu_receipts WHERE message_id IN (${oldId},${newId})`),
  ).toEqual([{ message_id: newId }]);
});
