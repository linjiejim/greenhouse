/**
 * History screen — the standalone, full-page conversation browser (search +
 * infinite scroll + long-press actions). Shares its body with the Home top-bar
 * popup via <HistoryBrowser>; this host wraps it in a ScreenHeader.
 */

import React, { useCallback } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HistoryBrowser, type OpenConversation } from '../../src/chat/history-browser';
import { useT } from '../../src/lib/i18n';
import { ScreenHeader } from '../../src/ui';
import { makeStyles, useTheme } from '../../src/theme';

export default function HistoryScreen() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const openConversation = useCallback(
    (conv: OpenConversation) => {
      router.push({
        pathname: '/chat/[id]',
        params: { id: conv.id, title: conv.title, ro: conv.readOnly ? '1' : '0' },
      });
    },
    [router],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader variant="large" title={t('history.title')} onLeading={() => router.back()} />

      <HistoryBrowser enabled onOpen={openConversation} bottomInset={insets.bottom + 24} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
}));
