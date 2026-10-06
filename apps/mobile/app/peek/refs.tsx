/**
 * References peek (form sheet, native header) — what a reply cited, opened
 * from its "N 条引用" row. Two inset-grouped sections: knowledge sources (tap
 * → the source peek, stacked as another sheet) and web pages (tap → the
 * in-app Safari view over the sheet; src/lib/links.ts).
 * Payload `{ sources, web, readOnly? }` arrives via the handoff store (`?k=`,
 * kind `refs`); `readOnly` (a shared conversation — no composer) rides along
 * to the source peek, which then hides "就此提问".
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { Source, WebSource } from '../../src/chat/model';
import { catIcon, catLabel } from '../../src/lib/format';
import { getHandoff, putHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { openLink } from '../../src/lib/links';
import { space, useTheme } from '../../src/theme';
import { Icon } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function RefsPeek() {
  const { colors: c, hex } = useTheme();
  const t = useT();
  const router = useRouter();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const data = getHandoff<{ sources?: Source[]; web?: WebSource[]; readOnly?: boolean }>(k);
  const sources = data?.sources ?? [];
  const web = data?.web ?? [];

  return (
    <>
      <Stack.Screen options={{ title: t('chat.references') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {sources.length ? (
          <ListSection header={t('chat.knowledgeSources')}>
            {sources.map((s, i) => (
              <ListRow
                key={s.slug ?? i}
                icon={catIcon(s.category)}
                title={s.title}
                subtitle={catLabel(s.category)}
                accessory="chevron"
                onPress={() =>
                  router.push({
                    pathname: '/peek/source',
                    params: { k: putHandoff('source', { source: s, readOnly: !!data?.readOnly }) },
                  })
                }
              />
            ))}
          </ListSection>
        ) : null}
        {web.length ? (
          <ListSection header={t('chat.webSources')}>
            {web.map((w, i) => (
              <ListRow
                key={`${w.url ?? w.title}-${i}`}
                icon="globe"
                iconTint={c.blue}
                title={w.title}
                subtitle={w.host}
                titleLines={2}
                accessory={w.url ? <Icon name="open" size={15} color={c.tertiaryLabel} /> : 'none'}
                onPress={
                  w.url
                    ? () => void openLink(w.url!, hex.accent).catch(() => alertError(t('chat.linkFailed')))
                    : undefined
                }
              />
            ))}
          </ListSection>
        ) : null}
        {!sources.length && !web.length ? (
          <EmptyState icon="book" title={t('chat.expired')} message={t('chat.expiredHint')} />
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
});
