/**
 * HTML preview — a modal page running an agent-built page (an ```html-preview
 * fence, src/chat/markdown/blocks/html-preview.tsx) in a WebView: native
 * header (the page's <title>, ✕ close, copy source). The page is untrusted
 * model output, so it runs isolated: an ephemeral (incognito) web context, no
 * bridge into the app (no `onMessage`), no pop-up windows, and it can't
 * navigate away — a link it opens goes to the in-app Safari view instead.
 * The source arrives in memory through the handoff store (`?k=`, kind `html`).
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { openLink } from '../../src/lib/links';
import { makeStyles, useTheme } from '../../src/theme';
import { EmptyState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

/** The document itself (and in-page anchors / frames) may load; nothing else navigates the page. */
const INITIAL = /^(about:blank|about:srcdoc|data:)/;

export default function HtmlViewer() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const page = getHandoff<{ code: string; title?: string }>(k);
  const source = useMemo(() => (page ? { html: page.code } : null), [page]);

  const onNavigate = (req: WebViewNavigation & { isTopFrame?: boolean }) => {
    if (INITIAL.test(req.url) || req.isTopFrame === false) return true;
    if (/^https?:\/\//i.test(req.url)) void openLink(req.url, hex.accent).catch(() => {});
    return false;
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: page?.title || t('chat.htmlPreview') }} />
      <SheetClose />
      {page ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('copy')}
            accessibilityLabel={t('chat.copySource')}
            onPress={() => {
              void Clipboard.setStringAsync(page.code).catch(() => {});
              toast(t('common.copied'), 'copy');
            }}
          />
        </Stack.Toolbar>
      ) : null}
      {source ? (
        <WebView
          source={source}
          originWhitelist={['*']}
          incognito
          onShouldStartLoadWithRequest={onNavigate}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustContentInsets
          style={styles.web}
        />
      ) : (
        <View style={styles.center}>
          <EmptyState icon="code" title={t('chat.expired')} message={t('chat.expiredHint')} />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center' },
  web: { flex: 1, backgroundColor: c.background },
}));
