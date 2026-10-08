/**
 * Compatibility barrel for the kit's renderers. The platform-free Rich Output
 * protocol, block registry and parser live in @greenhouse/types so the browser
 * extension validates model-authored blocks exactly like the web and mobile
 * clients (spec docs/specs/20261008-rich-output-foundation.md §7).
 */
export * from '@greenhouse/types/rich-output';

import type { ModelFence } from '@greenhouse/types/rich-output';

/**
 * The model-authored blocks this kit draws (RichMarkdown) — what a host built on
 * it declares as `rich_blocks`, so the model never writes one it cannot show.
 */
export const RICH_BLOCKS_DRAWN: readonly ModelFence[] = ['chart', 'datatable', 'confirm'];
