/** How an agent write's status looks. */

import type { AgentWriteStatus } from '../shared/greenhouse-types';
import type { BadgeTone } from '../ui/list';

export const WRITE_TONE: Record<AgentWriteStatus, BadgeTone> = {
  running: 'blue',
  executed: 'green',
  failed: 'red',
  outcome_unknown: 'orange',
};
