/**
 * The declared actions offered on one record (card faces and the record
 * drawer): one small button each. Inside a clickable card or row, the buttons
 * keep their clicks, drags and keys to themselves — pressing "Approve" never
 * also opens the record or starts a kanban drag.
 */

import type { SyntheticEvent } from 'react';
import type { AppRecordAction } from '@greenhouse/types/apps';
import { Button } from '../ui';

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function AppRecordActionButtons({
  actions,
  onRun,
  testIdPrefix,
  className = '',
}: {
  actions: readonly AppRecordAction[];
  onRun: (action: AppRecordAction) => void;
  /** `data-testid` prefix; each button gets `<prefix>-<actionId>`. */
  testIdPrefix: string;
  className?: string;
}) {
  if (actions.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          size="sm"
          variant={action.do.type === 'delete' ? 'destructive' : 'outline'}
          className="min-h-11 px-2.5 md:min-h-8"
          data-testid={`${testIdPrefix}-${action.id}`}
          onClick={() => onRun(action)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
