/**
 * The process of a reply (CONV-18; a form sheet from its folded process row): every tool step
 * with its one-line summary, how long it took, and whether it failed. While the reply is being
 * written the list follows it live (its stream). `?c=<conversation>&m=<message>`.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useReplyContent } from '../../src/chat/message';
import { useT } from '../../src/lib/i18n';
import type { MessageItem } from '../../src/shared/contract';
import { useThreads } from '../../src/store/threads';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { Icon, Spinner } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function StepsPeek() {
  const { c = '', m = '' } = useLocalSearchParams<{ c?: string; m?: string }>();
  const t = useT();
  const message = useThreads((s) => s.threads[c]?.messages.find((item) => item.id === m));
  return (
    <>
      <Stack.Screen options={{ title: t('conversation.process') }} />
      <SheetClose />
      {message ? <Steps message={message} /> : <EmptyState icon="wrench" title={t('conversation.expired')} />}
    </>
  );
}

function Steps({ message }: { message: MessageItem }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { steps, live } = useReplyContent(message);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <ListSection footer={live ? t('conversation.processLive') : undefined}>
        {steps.length ? (
          steps.map((step) => (
            <View key={step.id} style={styles.step}>
              {step.status === 'running' ? (
                <Spinner style={styles.spinner} />
              ) : (
                <Icon
                  name={step.status === 'failed' ? 'alert' : 'checkCircle'}
                  size={15}
                  color={step.status === 'failed' ? c.red : c.secondaryLabel}
                />
              )}
              <View style={styles.texts}>
                <Text style={styles.summary}>{step.summary || step.tool}</Text>
                {step.summary && step.summary !== step.tool ? <Text style={styles.tool}>{step.tool}</Text> : null}
              </View>
              {step.duration_ms !== undefined ? (
                <Text style={styles.time}>{(step.duration_ms / 1000).toFixed(1)}s</Text>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.none}>{t('conversation.noSteps')}</Text>
        )}
      </ListSection>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.margin, paddingVertical: space.sm + 2 },
  spinner: { transform: [{ scale: 0.8 }] },
  texts: { flex: 1, gap: 2 },
  summary: { ...typo.subheadline, color: c.label },
  tool: { ...typo.caption1, color: c.tertiaryLabel },
  time: { ...typo.caption1, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  none: { ...typo.footnote, color: c.tertiaryLabel, padding: space.margin },
}));

