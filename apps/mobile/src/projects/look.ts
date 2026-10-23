/** How task statuses and due dates look: icon, tint and badge tone. */

import type { TaskStatus } from '../shared/greenhouse-types';
import type { ThemeColors } from '../theme';
import type { IconName } from '../ui/core';
import type { BadgeTone } from '../ui/list';
import type { DueBucket } from '../data/tasks';

export function statusIcon(status: TaskStatus): IconName {
  switch (status) {
    case 'in_progress':
      return 'statusProgress';
    case 'in_review':
      return 'hourglass';
    case 'done':
      return 'checkCircleFill';
    case 'cancelled':
      return 'statusCancelled';
    default:
      return 'circle';
  }
}

export function statusTint(status: TaskStatus, c: ThemeColors) {
  switch (status) {
    case 'in_progress':
      return c.blueTile;
    case 'in_review':
      return c.orangeTile;
    case 'done':
      return c.greenTile;
    default:
      return c.gray;
  }
}

export function dueTone(bucket: DueBucket): BadgeTone {
  return bucket === 'overdue' ? 'red' : bucket === 'today' ? 'orange' : 'neutral';
}
