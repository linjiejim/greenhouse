/**
 * The live screen: the viewer page (./viewer-html.ts) in the WebView the app
 * already ships, with the connection's states drawn over it. The connection
 * itself is `useComputerScreen` (./use-computer-screen.ts), owned by the page
 * so the control bar can reach the same keys and zoom.
 *
 * The WebView is locked down like the html-preview viewer: an ephemeral
 * context, no navigation, no windows — it only ever opens the screen socket.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useT } from '../lib/i18n';
import { getApiBase } from '../store/stations';
import { makeStyles, radius, space, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner } from '../ui/core';
import type { ComputerScreenState } from './use-computer-screen';
import { viewerHtml } from './viewer-html';

const HINT_MS = 3000;

export function ComputerScreenView({
  screen,
  hintAt,
  onTakeOver,
}: {
  screen: ComputerScreenState;
  /** When the member last tapped the picture while watching (shows "view only" for a moment). */
  hintAt: number;
  onTakeOver?: () => void;
}) {
  const t = useT();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  // The API checks the socket Origin. Local HTML needs the active station as its base.
  const baseUrl = getApiBase();
  const source = useMemo(
    () => ({ html: viewerHtml(hex.secondaryBackground), baseUrl }),
    [hex.secondaryBackground, baseUrl],
  );
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!hintAt) return undefined;
    setHint(true);
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hintAt]);

  const { connection } = screen;
  const overlay =
    connection === 'connected' ? null : connection === 'failed' ? (
      <View style={styles.center}>
        <Icon name="alertCircle" size={22} color={c.secondaryLabel} />
        <Text style={styles.overlayText}>{t('computer.connectFailed')}</Text>
        <NativeButton label={t('computer.reconnect')} onPress={screen.reconnect} />
      </View>
    ) : connection === 'paused' ? (
      <Text style={styles.overlayText}>{t('computer.paused')}</Text>
    ) : (
      <View style={styles.row}>
        <Spinner />
        <Text style={styles.overlayText}>
          {t(connection === 'reconnecting' ? 'computer.reconnecting' : 'computer.connecting')}
        </Text>
      </View>
    );

  return (
    <View style={styles.root} testID="computer-screen" accessibilityLabel={t('computer.tabScreen')}>
      <WebView
        ref={screen.webRef}
        source={source}
        originWhitelist={['about:blank', baseUrl]}
        onShouldStartLoadWithRequest={(req) =>
          req.url === 'about:blank' || req.url === baseUrl || req.url === `${baseUrl}/`
        }
        onMessage={screen.onMessage}
        onContentProcessDidTerminate={() => screen.webRef.current?.reload()}
        incognito
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowsLinkPreview={false}
        dataDetectorTypes={['none']}
        style={styles.web}
        containerStyle={styles.web}
      />
      {overlay ? <View style={styles.overlay}>{overlay}</View> : null}
      {hint ? (
        <View style={styles.hint} accessibilityRole="alert">
          <Text style={styles.hintText} numberOfLines={2}>
            {t('computer.viewOnlyHint')}
          </Text>
          {onTakeOver ? (
            <NativeButton label={t('computer.takeOver')} size="small" variant="prominent" onPress={onTakeOver} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.secondaryBackground, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: c.secondaryBackground },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: c.secondaryBackground,
  },
  center: { alignItems: 'center', gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  overlayText: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  hint: {
    position: 'absolute',
    left: space.margin,
    right: space.margin,
    bottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryBackground,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  hintText: { ...typo.footnote, color: c.label, flex: 1 },
}));
