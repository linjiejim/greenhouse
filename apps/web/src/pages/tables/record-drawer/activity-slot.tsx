/**
 * Record drawer · Activity tab slot (slice C): comments with @mentions and the
 * record's change history, merged newest first (./activity-panel). The drawer
 * shows its tab strip because this second tab exists; like every history tab
 * it carries no count.
 */

import { RecordActivityPanel } from './activity-panel';
import type { RecordDrawerTab } from './slots';

export const RECORD_ACTIVITY_TAB: RecordDrawerTab | null = {
  key: 'activity',
  labelKey: 'tables.activity.tab',
  Panel: RecordActivityPanel,
};
