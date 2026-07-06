/**
 * History sheet — the full conversation list as a bottom-sheet popup, opened
 * from the Home top-bar history icon. Wraps the shared <HistoryBrowser> (search
 * + tag filter + infinite-scroll list + long-press actions) in an 88% sheet and
 * owns the tag-manager sheet (opened from the header's tags button or a row's
 * "指派标签"). The standalone /history screen reuses the same browser body.
 */

import React, { useState } from 'react';
import { useT } from '../lib/i18n';
import { makeStyles, useTheme } from '../theme';
import { Icon, Sheet, Touchable } from '../ui';
import { HistoryBrowser, type OpenConversation } from './history-browser';
import { TagManagerSheet } from './tag-manager-sheet';

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
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <>
      <Sheet
        visible={visible}
        onClose={onClose}
        title={t('history.title')}
        heightPct={88}
        nativeScroll
        headerRight={
          <Touchable haptic="none" onPress={() => setManagerOpen(true)} style={styles.manageBtn}>
            <Icon name="tags" size={18} color={c.fgMuted} />
          </Touchable>
        }
      >
        <HistoryBrowser enabled={visible} onOpen={onOpen} onManageTags={() => setManagerOpen(true)} inSheet />
      </Sheet>

      <TagManagerSheet visible={managerOpen} onClose={() => setManagerOpen(false)} />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  manageBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
}));
