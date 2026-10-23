/**
 * History sheet — the full conversation list as a bottom-sheet popup, opened
 * from the Home top-bar history icon. Wraps the shared <HistoryBrowser> (search
 * + infinite-scroll list + long-press actions) in an 88% sheet. The standalone
 * /history screen reuses the same browser body.
 */

import React from 'react';
import { useT } from '../lib/i18n';
import { Sheet } from '../ui';
import { HistoryBrowser, type OpenConversation } from './history-browser';

export type { OpenConversation } from './history-browser';

export function HistorySheet({
  visible,
  onClose,
  onOpen,
}: {
  visible: boolean;
  onClose: () => void;
  onOpen: (c: OpenConversation) => void;
}) {
  const t = useT();

  return (
    <Sheet visible={visible} onClose={onClose} title={t('history.title')} heightPct={88} nativeScroll>
      <HistoryBrowser enabled={visible} onOpen={onOpen} inSheet />
    </Sheet>
  );
}
