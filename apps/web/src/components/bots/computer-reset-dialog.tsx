/**
 * Reset confirmation for a computer — the member's own (pane) or anyone's
 * (Administration → Bot computers). Resetting always recreates the container;
 * "also delete files and sign-ins" additionally wipes its home volume, which is
 * the one irreversible part, so it is opt-in and spelled out.
 */

import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Spinner } from '../ui';
import { useT } from '../../lib/i18n';

interface ComputerResetDialogProps {
  open: boolean;
  title: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (wipeData: boolean) => void;
}

export function ComputerResetDialog({ open, title, busy = false, onClose, onConfirm }: ComputerResetDialogProps) {
  const t = useT();
  const [wipe, setWipe] = useState(false);

  useEffect(() => {
    if (open) setWipe(false);
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-4" data-testid="computer-reset-dialog">
        <p className="text-sm text-fg-secondary">{t('botsComputer.resetDesc')}</p>
        <div className="rounded-lg border border-edge bg-surface-card p-3">
          <Checkbox
            checked={wipe}
            onChange={(event) => setWipe(event.target.checked)}
            label={t('botsComputer.resetWipe')}
            data-testid="computer-reset-wipe"
          />
          <p className="mt-1 pl-6 text-[11px] leading-4 text-fg-faint">{t('botsComputer.resetWipeDesc')}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onConfirm(wipe)}
            disabled={busy}
            data-testid="computer-reset-confirm"
          >
            {busy && <Spinner className="mr-1" />}
            {wipe ? t('botsComputer.resetAndWipe') : t('botsComputer.resetConfirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
