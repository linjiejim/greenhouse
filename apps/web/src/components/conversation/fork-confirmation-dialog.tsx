import React from 'react';
import { useT } from '../../lib/i18n';
import { ConfirmDialog } from '../ui';

export function ForkConfirmationDialog({
  open,
  fromReply,
  onClose,
  onConfirm,
}: {
  open: boolean;
  fromReply: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('chat.forkConfirmTitle')}
      description={t(fromReply ? 'chat.forkReplyConfirmDescription' : 'chat.forkConfirmDescription')}
      confirmLabel={t('chat.forkConfirmAction')}
    />
  );
}
