/**
 * Writes the generated token files from packages/ui/src/tokens/tokens.ts:
 *   apps/client/src/theme/tokens.generated.ts    (mobile copy)
 *   packages/ui-tokens/src/tokens.generated.ts   (standalone plugin themes)
 * Run with `pnpm tokens:build` after editing the token module; packages/ui/src/tokens/tokens.test.ts
 * fails while either file is stale.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_TS_PATH, EMBED_TS_PATH, renderEmbedTs, renderMobileTs } from '../packages/ui/src/tokens/render';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

writeFileSync(resolve(root, MOBILE_TS_PATH), renderMobileTs());
console.log(`wrote ${MOBILE_TS_PATH}`);
writeFileSync(resolve(root, EMBED_TS_PATH), renderEmbedTs());
console.log(`wrote ${EMBED_TS_PATH}`);
