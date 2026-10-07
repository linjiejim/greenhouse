/**
 * Full-screen Mermaid diagram — a modal page opened from an inline diagram
 * (src/chat/markdown/blocks/mermaid.tsx): native header (title, ✕ close) over
 * the drawing fitted to the width, scrollable and pinch-zoomable. The source
 * arrives in memory through the handoff store (`?k=`, kind `diagram`).
 */

import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { CodeBlock } from '../../src/chat/markdown/blocks/code';
import { mermaidHtml } from '../../src/chat/markdown/blocks/mermaid';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { useHeaderInset } from '../../src/ui/header-inset';
import { EmptyState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function DiagramViewer() {
  const { colors: c, hex, isDark } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const top = useHeaderInset();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const code = getHandoff<string>(k);
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => (code ? { html: mermaidHtml(code, hex, isDark, true) } : null), [code, hex, isDark]);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('chat.diagram') }} />
      <SheetClose />
      {!source ? (
        <View style={styles.center}>
          <EmptyState icon="diagram" title={t('chat.expired')} message={t('chat.expiredHint')} />
        </View>
      ) : failed ? (
        <View style={[styles.code, { paddingTop: top + space.sm }]}>
          <CodeBlock lang="mermaid" code={code!} />
        </View>
      ) : (
        <WebView
          source={source}
          originWhitelist={['*']}
          onMessage={(e) => {
            if (e.nativeEvent.data.includes('"error"')) setFailed(true);
          }}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustContentInsets
          scalesPageToFit
          style={styles.web}
          containerStyle={styles.web}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, justifyContent: 'center' },
  code: { paddingHorizontal: space.margin },
  web: { flex: 1, backgroundColor: 'transparent' },
}));

