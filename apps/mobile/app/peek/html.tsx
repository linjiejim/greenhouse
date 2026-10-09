/**
 * HTML preview — a modal page running an agent-built page (an ```html-preview
 * fence, src/chat/markdown/blocks/html-preview.tsx) in a WebView: native
 * header (the page's <title>, ✕ close, copy source). The page is untrusted
 * model output, so it runs isolated: an ephemeral (incognito) web context, no
 * pop-up windows, and it can't navigate away — a link it opens goes to the
 * in-app Safari view instead.
 *
 * Exactly one bridge back into the app, and only when the reply is the
 * member's own (`bridge` in the handoff): `window.greenhouse.sendPrompt(text)`
 * (spec docs/specs/20261008-html-preview-bridge.md). Its text goes INTO the
 * composer — appended, never sent — and the viewer closes so the member sees
 * it. Nothing else crosses: no data, no tools, no app state.
 * The source arrives in memory through the handoff store (`?k=`, kind `html`).
 *
 * The WebView's native bridge answers every frame in the page, so a
 * third-party iframe the page embeds could post too: the web host rejects
 * those by `event.source`, which a WebView cannot report reliably (Android
 * gives an origin at best). Instead the bridge script (top document only)
 * stamps each message with a per-viewer random token that a cross-origin
 * frame cannot read, and only messages carrying it count.
 */

import React, { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';
import { fillComposer } from '../../src/chat/composer-bridge';
import { htmlBridgeSource, readHtmlBridgeMessage } from '../../src/shared/rich-output';
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

/** 128 random bits as hex: what a message must carry to count (see the header). */
function bridgeToken(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function HtmlViewer() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const router = useRouter();
  const page = getHandoff<{ code: string; title?: string; bridge?: boolean }>(k);
  const source = useMemo(() => (page ? { html: page.code } : null), [page]);
  const handedBack = useRef(false);
  const token = useMemo(bridgeToken, []);

  // The first sendPrompt wins: its text goes into the composer and the viewer
  // closes, so a page cannot queue a stream of messages behind the member's back.
  const onMessage = (event: WebViewMessageEvent) => {
    if (!page?.bridge || handedBack.current) return;
    const message = readHtmlBridgeMessage(event.nativeEvent.data, token);
    if (!message) return;
    handedBack.current = true;
    fillComposer(message.text);
    toast(t(message.truncated ? 'chat.pageTextTruncated' : 'chat.pageFilledComposer'), 'check');
    router.back();
  };

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
          {...(page?.bridge
            ? {
                injectedJavaScriptBeforeContentLoaded: `${htmlBridgeSource('react-native', token)}true;`,
                // The token must never reach a subframe (this is the default; pinned on purpose).
                injectedJavaScriptBeforeContentLoadedForMainFrameOnly: true,
                onMessage,
              }
            : {})}
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
