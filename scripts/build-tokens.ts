/**
 * Writes the generated token files from packages/ui/src/tokens/tokens.ts:
 *   packages/ui/src/tokens/tokens.css            (web CSS variables, prettier-formatted)
 *   apps/client/src/theme/tokens.generated.ts    (mobile copy)
 *   packages/ui-tokens/src/tokens.generated.ts   (standalone plugin themes)
 * Run with `pnpm tokens:build` after editing the token module; packages/ui/src/tokens/tokens.test.ts
 * fails while either file is stale.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  MOBILE_TS_PATH,
  WEB_CSS_PATH,
  EMBED_TS_PATH,
  renderEmbedTs,
  renderMobileTs,
  renderWebCss,
} from '../packages/ui/src/tokens/render';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const css = await format(renderWebCss(), { parser: 'css', singleQuote: true, printWidth: 120 });
writeFileSync(resolve(root, WEB_CSS_PATH), css);
console.log(`wrote ${WEB_CSS_PATH}`);

writeFileSync(resolve(root, MOBILE_TS_PATH), renderMobileTs());
console.log(`wrote ${MOBILE_TS_PATH}`);
writeFileSync(resolve(root, EMBED_TS_PATH), renderEmbedTs());
console.log(`wrote ${EMBED_TS_PATH}`);
