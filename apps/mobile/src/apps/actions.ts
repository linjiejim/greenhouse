/**
 * The app action executor (spec §3 "动作执行器（确认 + set_fields 输入 sheet）"):
 * every write an app page makes goes through the gateway's `/actions` with a
 * fresh request id — declared actions (approve, reject, run an automation,
 * delete) and the built-ins (`$move` a kanban lane, `$create` / `$submit` /
 * `$edit` from the write form). A declared action:
 *
 *  1. asks first when the builder wrote a confirmation, and always before a
 *     delete (the builder's words, else ours; red) — as on the web;
 *  2. collects its input fields in the write form (`/apps/form`, mode
 *     `action`) when it has some — the form runs it with them;
 *  3. else runs at the record's revision; the result is a short HUD ("Done",
 *     "Started" for an automation, "Record deleted"), the app's cards refetch;
 *     `run` resolves to it, so a record screen can leave a deleted record.
 *
 * Every write carries the viewer's time zone (src/api/apps.ts `runAction`):
 * `$today` / `$now` in the spec's values and defaults are the viewer's day.
 *
 * A refusal says why in the member's words (`details.reason`: the condition no
 * longer holds, someone changed the record, required input, not for my role,
 * gone) — the server decided; the phone never pre-judges a `when`.
 */

import { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { newRequestId, runAction } from '../api/apps';
import type { Write } from '../api/tables';
import type { AppActionResult, AppCard, AppRecordAction, AppRecordRow } from '../shared/apps';
import { t } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import { actionConfirmation, actionInputs, refusalOf } from './model';
import { useApps } from './store';

/** Say why a write was refused (or that it failed), as a system alert. */
export function reportRefusal(result: Extract<Write<unknown>, { ok: false }>, label?: string): void {
  const reason = refusalOf(result.details, result.status);
  alertError(
    label ? t('apps.actionFailed', { label }) : t('apps.refusal.generic'),
    reason ? t(`apps.refusal.${reason}`) : result.message || undefined,
  );
}

/** The HUD after a write that went through. */
export function reportDone(result: AppActionResult): void {
  if (result.outcome === 'queued') toast(t('apps.actionQueued'), 'sparkle');
  else if (result.outcome === 'created') toast(t('apps.created'), 'checkCircle');
  else if (result.outcome === 'deleted') toast(t('apps.deleted'), 'checkCircle');
  else toast(t('apps.actionDone'), 'checkCircle');
}

export function useAppActions(appId: number, previewRole?: string) {
  const router = useRouter();
  const written = useApps((s) => s.written);

  /**
   * Run a declared action on a record (confirm → inputs → write). Resolves to
   * what the gateway did, or null when nothing ran here (declined, refused, or
   * handed to the write form).
   */
  const run = useCallback(
    async (input: {
      pageId: string;
      card: AppCard;
      action: AppRecordAction;
      record: AppRecordRow;
    }): Promise<AppActionResult | null> => {
      const { pageId, card, action, record } = input;
      const ask = actionConfirmation(action);
      if (ask) {
        const yes = await confirmAction({
          title: ask.message ?? t('apps.confirmDelete'),
          confirmLabel: action.label,
          destructive: ask.destructive,
        });
        if (!yes) return null;
      }
      if (actionInputs(action)) {
        router.push({
          pathname: '/apps/form',
          params: {
            appId: String(appId),
            pageId,
            cardId: card.id,
            mode: 'action',
            actionId: action.id,
            recordId: String(record.id),
            revision: String(record.revision),
          },
        });
        return null;
      }
      const result = await runAction(appId, {
        pageId,
        cardId: card.id,
        actionId: action.id,
        recordId: record.id,
        revision: record.revision,
        requestId: newRequestId(),
        ...(previewRole ? { previewRole } : {}),
      });
      if (!result.ok) {
        reportRefusal(result, action.label);
        written(appId); // the record may have moved on: show what is true now
        return null;
      }
      reportDone(result.value);
      written(appId);
      return result.value;
    },
    [appId, previewRole, router, written],
  );

  /** Move a kanban card's record to another lane (`$move`: the group field only). */
  const move = useCallback(
    async (input: { pageId: string; card: AppCard; record: AppRecordRow; fieldId: number; value: string | null }) => {
      const result = await runAction(appId, {
        pageId: input.pageId,
        cardId: input.card.id,
        actionId: '$move',
        recordId: input.record.id,
        revision: input.record.revision,
        values: [{ fieldId: input.fieldId, value: input.value }],
        requestId: newRequestId(),
        ...(previewRole ? { previewRole } : {}),
      });
      if (!result.ok) reportRefusal(result);
      written(appId);
    },
    [appId, previewRole, written],
  );

  return useMemo(() => ({ run, move }), [run, move]);
}
