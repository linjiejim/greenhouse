/**
 * CLI: Create (or rotate) an external API client and print its raw key once.
 *
 * Usage:
 *   pnpm tsx apps/api/src/cli/create-api-client.ts [app_id] [app_name]
 *
 * Defaults to app_id="greenhouse-app". If the client exists, its key is rotated.
 * The raw key (gh_sk_…) is printed exactly once — save it.
 */

import { config } from 'dotenv';
import { ENV_FILE } from '../paths.js';

config({ path: ENV_FILE });

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';

import { initDatabase } from '@greenhouse/db';
import { generateApiKey } from '../auth/api-key.js';

async function main() {
  const db = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });

  const appId = process.argv[2] || 'greenhouse-app';
  const appName = process.argv[3] || 'Greenhouse App';

  const { raw, hash } = generateApiKey();

  const existing = await db.apiClients.getByAppId(appId);
  if (existing) {
    await db.apiClients.update(existing.id, { api_key_hash: hash });
    console.log(`[rotated] ${appId} (id=${existing.id})`);
  } else {
    const client = await db.apiClients.create({
      app_id: appId,
      app_name: appName,
      api_key_hash: hash,
      allowed_profiles: ['default'],
    });
    console.log(`[created] ${appId} (id=${client.id})`);
  }

  console.log('API_KEY=' + raw);

  await db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
