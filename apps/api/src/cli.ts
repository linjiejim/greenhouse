/** Local engineering CLI. Export never starts workers or reaches provider services. */
import { createDbClient, setDb, assertNotV1Database } from '@greenhouse/db';
import { loadConfig } from './config/index.js';
import { exportFixture } from './engine/eval.js';
import { logger } from '@greenhouse/utils/logger';

const [command, action, id] = process.argv.slice(2);
if (command !== 'eval' || action !== 'export' || !id) throw new Error('Usage: pnpm cli eval export <run|message id>');
const config = loadConfig();
const client = createDbClient(config.DATABASE_URL);
try {
  await assertNotV1Database(client.sql);
  setDb(client.db);
  logger.info('Eval fixture exported', { path: await exportFixture(id) });
} finally {
  await client.sql.end();
}
