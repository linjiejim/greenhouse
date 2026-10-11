/**
 * Record drawer · header actions slot. Owned by slice Au (automation buttons
 * from `listRecordButtons`): replace `null` with a component; it renders under
 * the drawer header, inside the sticky block.
 */

import type { ComponentType } from 'react';
import type { RecordDrawerSlotProps } from './slots';

export const RecordActionsSlot: ComponentType<RecordDrawerSlotProps> | null = null;
