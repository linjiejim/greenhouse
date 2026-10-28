/** How an automation's last result looks: icon, tile tint and badge tone (./model.ts `RunResult`). */

import type { ThemeColors } from '../theme';
import type { IconName } from '../ui/core';
import type { BadgeTone } from '../ui/list';
import type { RunResult } from './model';

export function resultIcon(result: RunResult, enabled = true): IconName {
  if (!enabled) return 'sleep';
  switch (result) {
    case 'ok':
      return 'checkCircleFill';
    case 'failed':
      return 'alertCircle';
    case 'running':
      return 'hourglass';
    case 'quiet':
      return 'checkCircle';
    default:
      return 'clock';
  }
}

export function resultTint(result: RunResult, c: ThemeColors, enabled = true) {
  if (!enabled) return c.gray;
  switch (result) {
    case 'ok':
    case 'quiet':
      return c.greenTile;
    case 'failed':
      return c.redTile;
    case 'running':
      return c.blueTile;
    default:
      return c.gray;
  }
}

export function resultTone(result: RunResult): BadgeTone {
  switch (result) {
    case 'ok':
      return 'green';
    case 'failed':
      return 'red';
    case 'running':
      return 'blue';
    default:
      return 'neutral';
  }
}
