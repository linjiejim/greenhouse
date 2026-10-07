/**
 * `/bots/rules?c=` — a group's rules: one text every Bot in the group reads
 * before it replies, at most 2000 characters (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). A SwiftUI Form sheet with the
 * shared `FormChrome` (✓ saves — `PATCH … { description }` — ✕ confirms
 * discarding edits); Android: ./rules.android.tsx. Opened from the info
 * sheet, which re-reads when this closes. Behaviour:
 * src/bots/manage/use-rules-form.ts.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HStack, ProgressView, Section, Spacer, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../src/lib/i18n';
import { useConversationInfo } from '../../src/bots/manage/use-conversation-info';
import { useRulesForm } from '../../src/bots/manage/use-rules-form';
import { useTheme } from '../../src/theme';
import { EmptyState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';

type Chrome = React.ComponentProps<typeof FormChrome>;

export default function GroupRulesSheet() {
  const t = useT();
  const { c = '' } = useLocalSearchParams<{ c?: string }>();
  const info = useConversationInfo(c);
  // ✕ / ✓ for the rules once they are in (handed up by RulesSection: nav chrome can't sit among the
  // Form's SwiftUI children).
  const [chrome, setChrome] = useState<Chrome | null>(null);

  // The Form is mounted from the first frame, loading included: a SwiftUI Form that
  // only mounts once the sheet is up doesn't get the nav bar's top inset, and its
  // first (untitled) section slides under the bar.
  const failed = !info.detail && info.load !== 'loading';
  return (
    <>
      {chrome && info.detail ? (
        <FormChrome {...chrome} />
      ) : (
        <>
          <Stack.Screen options={{ title: t('bots.manage.rules') }} />
          <SheetClose />
        </>
      )}
      {failed ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          {info.load === 'not_found' || info.load === 'forbidden' ? (
            <EmptyState icon="msgs" title={t('bots.manage.conversationMissing')} />
          ) : (
            <EmptyState icon="alert" title={t('bots.manage.loadFailed')} onRetry={() => void info.reload()} />
          )}
        </View>
      ) : (
        <NativeForm>
          {info.detail ? (
            // Mounted once with the rules as they were: the native field owns the text from here.
            <RulesSection key={c} c={c} initial={info.detail.description} onChrome={setChrome} />
          ) : (
            <Section>
              <HStack>
                <Spacer />
                <ProgressView />
                <Spacer />
              </HStack>
            </Section>
          )}
        </NativeForm>
      )}
    </>
  );
}

function RulesSection({
  c,
  initial,
  onChrome,
}: {
  c: string;
  initial: string;
  /** The sheet draws ✕ / ✓ outside the Form: this form's state for them (null once it is gone). */
  onChrome: (chrome: Chrome | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const form = useRulesForm(c, initial);
  const text = useNativeState(initial);

  const save = async () => {
    if (await form.save(text.get())) router.back();
  };

  // ✓ runs the latest `save` (it reads this render's form and field).
  const latestSave = useRef(save);
  useLayoutEffect(() => {
    latestSave.current = save;
  });
  const title = t('bots.manage.rules');
  const { dirty, canSave, saving } = form;
  useLayoutEffect(() => {
    onChrome({ title, dirty, canSave, saving, onSave: () => void latestSave.current() });
    return () => onChrome(null);
  }, [onChrome, title, dirty, canSave, saving]);

  return (
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
  );
}
