/**
 * The one place an agent action gets approved.
 *
 * Mounted once in the app shell and driven by `lib/client-actions/confirm-gate`,
 * so every `safety: 'confirm'` client action — whether it came from a chat turn
 * or from a third-party agent over MCP — is approved in the same place, with the
 * same affordances. Without it the gate's promise never resolves and the agent
 * turn waits forever.
 *
 * It is not `<ConfirmDialog>` because approvals here need one thing a generic
 * yes/no doesn't have: a reason list explaining *why* we stopped.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from '../../lib/icons';
import { Button } from '../ui';
import { OverlayFrame } from '../overlay-frame';
import {
  onConfirmationChange,
  peekConfirmation,
  resolveConfirmation,
  type ConfirmationPrompt,
} from '../../lib/client-actions/confirm-gate';
import { useT } from '../../lib/i18n';

export function ActionConfirmDialog() {
  const t = useT();
  const [prompt, setPrompt] = useState<ConfirmationPrompt | null>(peekConfirmation);

  useEffect(() => onConfirmationChange(setPrompt), []);

  const decline = () => {
    if (prompt) resolveConfirmation(prompt.id, { allowed: false, rememberSite: false });
  };

  if (!prompt) return null;

  const hasReasons = Boolean(prompt.reasons?.length);

  return (
    /* Escape declines — dismissing an approval prompt must never mean "yes". */
    <OverlayFrame
      open
      onClose={decline}
      variant="alert"
      ariaLabel={prompt.title}
      zClassName="z-[60]"
      surfaceClassName="max-w-sm p-4 sm:p-5"
    >
      <>
        <p className="text-sm text-fg-secondary font-medium mb-1">{prompt.title}</p>
        {prompt.description && <p className="text-xs text-fg-muted break-words">{prompt.description}</p>}

        {hasReasons && (
          <div className="mt-3 flex gap-2 rounded-lg bg-warning-subtle p-2.5">
            <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
            <ul className="text-xs text-fg-secondary space-y-0.5">
              {prompt.reasons!.map((reason) => (
                <li key={reason}>{t('actionConfirm.reason', { reason })}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={decline}>
            {t('actionConfirm.deny')}
          </Button>
          <Button
            variant={hasReasons ? 'destructive' : 'default'}
            size="sm"
            onClick={() => resolveConfirmation(prompt.id, { allowed: true, rememberSite: false })}
          >
            {prompt.confirmLabel ?? t('actionConfirm.allow')}
          </Button>
        </div>
      </>
    </OverlayFrame>
  );
}
