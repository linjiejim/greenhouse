/**
 * Record drawer · header actions slot (slice Au): the record's automation
 * buttons. Only members who can update the record get any (`listRecordButtons`
 * answers an empty list otherwise, and leaks no rule configuration); a press
 * queues one run (a fresh request id per press, so a double click is one run)
 * and the change arrives through `tables:records_changed` like any other write.
 */

import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { TableRecordButton } from '@greenhouse/types/tables';
import { Button, toast } from '../../../components/ui';
import { isTablesConflict, listTableRecordButtons, triggerTableAutomation } from '../../../lib/api/tables';
import { MousePointerClick } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import type { RecordDrawerSlotProps } from './slots';

function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function AutomationButtons({ table, record, canEdit, onRecordChanged }: RecordDrawerSlotProps) {
  const t = useT();
  const [buttons, setButtons] = useState<TableRecordButton[]>([]);
  const [pressing, setPressing] = useState<number | null>(null);
  const pressed = useRef(new Map<number, string>());

  useEffect(() => {
    if (!canEdit) {
      setButtons([]);
      return;
    }
    let cancelled = false;
    listTableRecordButtons(table.id, record.id)
      .then((next) => !cancelled && setButtons(next))
      .catch(() => !cancelled && setButtons([]));
    return () => {
      cancelled = true;
    };
    // A new revision may change which buttons apply (their conditions).
  }, [table.id, record.id, record.revision, canEdit]);

  if (buttons.length === 0) return null;

  const press = async (button: TableRecordButton) => {
    // One request id per press, reused if the same press is retried before it lands.
    const requestId = pressed.current.get(button.ruleId) ?? newRequestId();
    pressed.current.set(button.ruleId, requestId);
    setPressing(button.ruleId);
    try {
      await triggerTableAutomation(button.ruleId, record.id, requestId);
      toast(t('tables.automations.buttons.started', { label: button.label }), 'success');
      onRecordChanged();
    } catch (error) {
      toast(
        isTablesConflict(error)
          ? t('tables.automations.buttons.stale')
          : t('tables.automations.buttons.failed', { label: button.label }),
        'error',
      );
    } finally {
      pressed.current.delete(button.ruleId);
      setPressing(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('tables.automations.buttons.label')}>
      {buttons.map((button) => (
        <Button
          key={button.ruleId}
          size="sm"
          variant="outline"
          disabled={pressing !== null}
          onClick={() => void press(button)}
          data-testid={`record-automation-button-${button.ruleId}`}
        >
          <MousePointerClick size={13} className="mr-1.5" />
          {button.label}
        </Button>
      ))}
    </div>
  );
}

export const RecordActionsSlot: ComponentType<RecordDrawerSlotProps> | null = AutomationButtons;
