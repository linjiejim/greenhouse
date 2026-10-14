/**
 * 出处 (CONV-19; a form sheet from a reply's row of sources): what the reply used. A web page
 * opens in the in-app Safari view; a document of the knowledge base opens natively. 「就此追问」 quotes a source in the composer.
 * Payload `{ citations, readOnly }` arrives via the handoff store (`?k=`).
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { quoteInComposer } from '../../src/chat/composer-bridge';
import { sourceLabel } from '../../src/chat/message';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { openLink } from '../../src/lib/links';
import type { Message } from '../../src/shared/contract';
import { space, useTheme } from '../../src/theme';
import { Icon } from '../../src/ui/core';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { SheetClose, useLeaveSheetTo } from '../../src/ui/sheet-chrome';

type Citation = Message['citations'][number];

const isWeb = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

export default function SourcesPeek() {
  const { colors: c, hex } = useTheme();
  const t = useT();
  const router = useRouter();
  const leaveTo = useLeaveSheetTo();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const data = getHandoff<{ citations: Citation[]; readOnly?: boolean }>(k, 'sources');
  const citations = data?.citations ?? [];

  const ask = (source: Citation) => {
    quoteInComposer(`${source.title}${source.url ? ` — ${source.url}` : ''}`);
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: t('conversation.sources') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {citations.length ? (
          <ListSection footer={data?.readOnly ? undefined : t('sources.askHint')}>
            {citations.map((source) => {
              const web = isWeb(source.url);
              const row = (
                <ListRow
                  key={`${source.kind}:${source.id}`}
                  icon={source.kind === 'doc' ? 'book' : 'globe'}
                  iconTint={source.kind === 'doc' ? c.green : c.blue}
                  title={source.title}
                  subtitle={web ? sourceLabel(source) : t('sources.knowledge')}
                  titleLines={2}
                  accessory={web ? <Icon name="open" size={15} color={c.tertiaryLabel} /> : 'none'}
                  onPress={() =>
                    web
                      ? void openLink(source.url!, hex.accent).catch(() => alertError(t('conversation.linkFailed')))
                      : leaveTo({ pathname: '/knowledge/doc', params: { id: source.id } })
                  }
                  accessibilityActions={data?.readOnly ? undefined : [{ name: 'ask', label: t('sources.ask') }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'ask') ask(source);
                  }}
                />
              );
              return data?.readOnly ? (
                row
              ) : (
                <NativeMenu
                  key={`${source.kind}:${source.id}`}
                  trigger="longPress"
                  items={[{ id: 'ask', title: t('sources.ask'), icon: 'quote' }]}
                  onSelect={() => ask(source)}
                >
                  {row}
                </NativeMenu>
              );
            })}
          </ListSection>
        ) : (
          <EmptyState icon="book" title={t('conversation.expired')} />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
});
