/**
 * Record drawer · Activity tab slot. Owned by slice C (comments + change
 * history): replace `null` with the tab. The drawer shows its tab strip only
 * once a second tab exists.
 */

import type { RecordDrawerTab } from './slots';

export const RECORD_ACTIVITY_TAB: RecordDrawerTab | null = null;
