/**
 * Tool-call peek (form sheet, native header) — the pipeline behind a reply,
 * opened from its "调用了 N 个工具" row. One inset-grouped row per call: tool
 * icon, friendly name, a one-line preview of the input, duration and status;
 * tap to expand the full input / output as pretty-printed JSON in the
 * always-dark code style (with copy). Steps arrive via the handoff store
 * (`?k=`, kind `tools`); a missing key renders the "no longer available" state.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { CodeBlock } from '../../src/chat/markdown/blocks/code';
import { excerpt, type ToolStep } from '../../src/chat/model';
import { toolIcon, toolLabel } from '../../src/lib/format';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../../src/theme';
import { Icon, Spinner } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { IconTile } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

const MAX_DUMP = 6000;

/** Pretty JSON for a tool payload (strings that hold JSON are re-indented). */
function pretty(v: unknown): { lang: string; code: string } {
  let value = v;
  if (typeof v === 'string') {
    try {
      value = JSON.parse(v);
    } catch {
      return { lang: 'text', code: v.length > MAX_DUMP ? `${v.slice(0, MAX_DUMP)}…` : v };
    }
  }
  const code = JSON.stringify(value, null, 2) ?? String(value);
  return { lang: 'json', code: code.length > MAX_DUMP ? `${code.slice(0, MAX_DUMP)}…` : code };
}

function brief(v: unknown): string {
  if (v == null) return '';
  return excerpt(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 70);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function StepRow({ step, last }: { step: ToolStep; last: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [open, setOpen] = useState(false);
  const input = step.input != null ? pretty(step.input) : null;
  const output = step.output != null ? pretty(step.output) : null;
  const tint = step.status === 'error' ? c.red : step.status === 'running' ? c.gray : c.accent;

  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]}
      >
        <IconTile icon={toolIcon(step.tool)} tint={tint} />
        <View style={styles.texts}>
          <Text numberOfLines={1} style={styles.title}>
            {toolLabel(step.tool)}
          </Text>
          {step.input != null ? (
            <Text numberOfLines={1} style={styles.subtitle}>
              {brief(step.input)}
            </Text>
          ) : null}
        </View>
        {step.ms != null ? <Text style={styles.ms}>{formatMs(step.ms)}</Text> : null}
        {step.status === 'running' ? (
          <Spinner />
        ) : step.status === 'error' ? (
          <Icon name="alert" size={15} weight="semibold" color={c.red} />
        ) : null}
        <Icon name={open ? 'chevD' : 'chevR'} size={13} weight="semibold" color={c.tertiaryLabel} />
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={styles.detail}>
          <Text style={styles.label}>{t('chat.toolInput')}</Text>
          {input ? <CodeBlock lang={input.lang} code={input.code} /> : <Text style={styles.none}>—</Text>}
          <Text style={styles.label}>{t('chat.toolOutput')}</Text>
          {output ? (
            <CodeBlock lang={output.lang} code={output.code} />
          ) : (
            <Text style={styles.none}>
              {step.status === 'running'
                ? t('chat.toolRunning')
                : step.status === 'error'
                  ? t('chat.toolFailed')
                  : t('chat.noOutput')}
            </Text>
          )}
        </Animated.View>
      ) : null}
      {!last ? <View style={styles.sep} /> : null}
    </View>
  );
}

export default function ToolsPeek() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { k } = useLocalSearchParams<{ k?: string }>();
  const steps = getHandoff<ToolStep[]>(k);

  return (
    <>
      <Stack.Screen options={{ title: t('chat.toolCalls') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {steps?.length ? (
          <View style={styles.card}>
            {steps.map((s, i) => (
              <StepRow key={s.id} step={s} last={i === steps.length - 1} />
            ))}
          </View>
        ) : (
          <EmptyState icon="wrench" title={t('chat.expired')} message={t('chat.expiredHint')} />
        )}
      </ScrollView>
    </>
  );
}

const TILE = 30;

const useStyles = makeStyles((c) => ({
  content: { padding: space.margin, paddingBottom: space.xxxl },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    overflow: 'hidden',
    ...squircle,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: HIT + 12,
    paddingHorizontal: space.margin,
    paddingVertical: space.sm + 2,
  },
  texts: { flex: 1, minWidth: 0 },
  title: { ...typo.body, color: c.label },
  subtitle: { ...typo.footnote, color: c.secondaryLabel, marginTop: 1 },
  ms: { ...typo.footnote, color: c.secondaryLabel, fontVariant: ['tabular-nums'] },
  detail: { paddingHorizontal: space.margin, paddingBottom: space.md },
  label: { ...typo.footnote, color: c.secondaryLabel, textTransform: 'uppercase', marginTop: space.sm },
  none: { ...typo.subheadline, color: c.tertiaryLabel, marginTop: space.xs },
  sep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
    marginLeft: space.margin + TILE + space.md,
  },
}));
