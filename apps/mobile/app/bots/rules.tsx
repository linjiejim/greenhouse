/**
 * `/bots/rules?c=` — a group's rules: one text every Bot in the group reads
 * before it replies, at most 2000 characters (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). A SwiftUI Form sheet with the
 * shared `FormChrome` (✓ saves — `PATCH … { description }` — ✕ confirms
 * discarding edits); Android: ./rules.android.tsx. Opened from the info
 * sheet, which re-reads when this closes. Behaviour:
 * src/bots/manage/use-rules-form.ts.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../src/lib/i18n';
import { useConversationInfo } from '../../src/bots/manage/use-conversation-info';
import { useRulesForm } from '../../src/bots/manage/use-rules-form';
import { useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';

export default function GroupRulesSheet() {
  const t = useT();
  const { c = '' } = useLocalSearchParams<{ c?: string }>();
  const info = useConversationInfo(c);

  if (info.detail) {
    // Mounted once with the rules as they were: the native field owns the text from here.
    return <RulesForm key={c} c={c} initial={info.detail.description} />;
  }
  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.rules') }} />
      <SheetClose />
      <View style={{ flex: 1, justifyContent: 'center' }}>
        {info.load === 'loading' ? (
          <LoadingState />
        ) : info.load === 'not_found' || info.load === 'forbidden' ? (
          <EmptyState icon="msgs" title={t('bots.manage.conversationMissing')} />
        ) : (
          <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={() => void info.reload()} />
        )}
      </View>
    </>
  );
}

function RulesForm({ c, initial }: { c: string; initial: string }) {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const form = useRulesForm(c, initial);
  const text = useNativeState(initial);

  const save = async () => {
    if (await form.save(text.get())) router.back();
  };

  return (
    <>
      <FormChrome
        title={t('bots.manage.rules')}
        dirty={form.dirty}
        canSave={form.canSave}
        saving={form.saving}
        onSave={() => void save()}
      />
      <NativeForm>
        <Section
          footer={
            <Text modifiers={form.tooLong ? [foregroundStyle(hex.red)] : []}>
              {t('bots.manage.rulesFooter', { max: form.max })}
            </Text>
          }
        >
          <TextField
            text={text}
            axis="vertical"
            autoFocus
            maxLength={form.max}
            placeholder={t('bots.manage.rulesPlaceholder')}
            onTextChange={form.setText}
            modifiers={[lineLimit({ min: 6, max: 16 })]}
          />
        </Section>
      </NativeForm>
    </>
  );
}
