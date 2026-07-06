/**
 * History screen — the standalone, full-page conversation browser (search + tag
 * filter + infinite scroll + long-press actions). Shares its body with the Home
 * top-bar popup via <HistoryBrowser>; this host wraps it in a ScreenHeader and
 * owns the tag-manager sheet (header tags button).
 */

import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HistoryBrowser, type OpenConversation } from '../../src/chat/history-browser';
import { TagManagerSheet } from '../../src/chat/tag-manager-sheet';
import { useT } from '../../src/lib/i18n';
import { Icon, ScreenHeader, Touchable } from '../../src/ui';
import { makeStyles, useTheme } from '../../src/theme';

export default function HistoryScreen() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [managerOpen, setManagerOpen] = useState(false);

  const openConversation = useCallback(
    (conv: OpenConversation) => {
      router.push({ pathname: '/chat/[id]', params: { id: conv.id, title: conv.title, ro: conv.readOnly ? '1' : '0' } });
    },
    [router],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader
        variant="large"
        title={t('history.title')}
        onLeading={() => router.back()}
        right={
          <Touchable haptic="none" onPress={() => setManagerOpen(true)} style={styles.manageBtn}>
            <Icon name="tags" size={18} color={c.fgMuted} />
          </Touchable>
        }
      />

      <HistoryBrowser
        enabled
        onOpen={openConversation}
        onManageTags={() => setManagerOpen(true)}
        bottomInset={insets.bottom + 24}
      />

      <TagManagerSheet visible={managerOpen} onClose={() => setManagerOpen(false)} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  manageBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
}));
