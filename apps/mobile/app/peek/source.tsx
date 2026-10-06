/**
 * Source peek (form sheet, native header) — one knowledge citation: category
 * badge, title, the excerpt the agent read, and the primary action
 * "就此提问", which attaches the source to the conversation composer (through
 * the composer bridge store — sheets never call back) and closes the sheets.
 * Knowledge docs also offer the full-document preview (toolbar `doc.text` →
 * `/peek/doc/<slug>`).
 *
 * Payload `{ source, readOnly? }` arrives via the handoff store (`?k=`, kind
 * `source`). Citations hydrated from history carry no body (only live turns
 * see the tool result), so for those the doc is fetched by slug and its
 * opening shown instead of an empty placeholder. A shared (read-only)
 * conversation has no composer, so "就此提问" is hidden there.
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getDoc } from '../../src/api/knowledge';
import { attachToComposer } from '../../src/chat/composer-bridge';
import { plainText, type Source } from '../../src/chat/model';
import { catIcon, catLabel } from '../../src/lib/format';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { Badge } from '../../src/ui/list';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** How much of a fetched doc to show (the full read is one tap away). */
const EXCERPT_CHARS = 1200;

export default function SourcePeek() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const payload = getHandoff<{ source: Source; readOnly?: boolean }>(k);
  const source = payload?.source;
  const slug = source?.slug;

  // History citations have no body — fetch the doc's opening (undefined = loading).
  const [fetched, setFetched] = useState<string | null | undefined>(source?.body || !slug ? null : undefined);
  useEffect(() => {
    if (!slug || source?.body) return;
    let alive = true;
    void getDoc(slug).then((d) => {
      if (!alive) return;
      if (typeof d !== 'object') return setFetched(null);
      // The doc usually opens with its own title as an H1 — already the header here.
      const plain = plainText(d.content_markdown || d.summary || '')
        .replace(/^(.*)\n+/, (line, first: string) => (first.trim() === d.title.trim() ? '' : line))
        .trim();
      setFetched(plain.length > EXCERPT_CHARS ? `${plain.slice(0, EXCERPT_CHARS)}…` : plain || null);
    });
    return () => {
      alive = false;
    };
  }, [slug, source?.body]);
  const body = source?.body || fetched;

  const ask = () => {
    if (!source) return;
    attachToComposer(source.title);
    // Close every sheet back to the conversation (this one may sit on the refs sheet).
    router.dismissAll();
  };

  return (
    <>
      <Stack.Screen options={{ title: t('chat.sourceDetail') }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="doc.text"
          hidden={!slug}
          accessibilityLabel={t('common.open')}
          onPress={() => slug && router.replace({ pathname: '/peek/doc/[slug]', params: { slug } })}
        />
      </Stack.Toolbar>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {source ? (
          <>
            <Badge label={catLabel(source.category)} icon={catIcon(source.category)} tone="accent" style={styles.badge} />
            <Text style={styles.title} accessibilityRole="header">
              {source.title}
            </Text>
            {body === undefined ? (
              <LoadingState style={styles.loading} />
            ) : (
              <Text style={[styles.body, !body && styles.bodyEmpty]} selectable>
                {body || t('chat.sourceEmpty')}
              </Text>
            )}
            {/* the sheet's one primary action (glass prominent on iOS 26) */}
            {payload?.readOnly ? null : (
              <NativeButton
                label={t('chat.askAboutSource')}
                icon="sparkle"
                variant="prominent"
                size="large"
                fullWidth
                onPress={ask}
                style={styles.ask}
              />
            )}
          </>
        ) : (
          <EmptyState icon="book" title={t('chat.expired')} message={t('chat.expiredHint')} />
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { padding: space.xl, paddingBottom: space.xxxl },
  badge: { alignSelf: 'flex-start' },
  title: { ...typo.title2, color: c.label, marginTop: space.md },
  body: { ...typo.body, lineHeight: 24, color: c.label, marginTop: space.md },
  bodyEmpty: { color: c.secondaryLabel },
  loading: { flexGrow: 0, paddingVertical: space.xxl },
  ask: { marginTop: space.xxl, alignSelf: 'stretch' },
}));
