/**
 * The steps a reply took (`/sheet/steps`), opened from the status beside "Sprouty". Every tool
 * call starts collapsed to one line: its status (spinner, check, red alert), its name in people's
 * words and what it was about (the query, the title; for a failure the short error;
 * src/chat/tool-words.ts `toolSummary`), and a chevron. A tap opens the row to what was asked (its
 * arguments as label and value) and what came back, with the raw value behind a toggle. A step
 * of the reply being written updates in place (src/chat/steps-sheet.ts); rows are keyed by step
 * id, so an opened row stays open as steps change.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { rawValue, toolArgs, toolName, toolResult, toolSummary } from '../../src/chat/tool-words';
import { useStepsSheet } from '../../src/chat/steps-sheet';
import type { ToolStep } from '../../src/chat/parts';
import { useT } from '../../src/lib/i18n';
import { HIT, makeStyles, mono, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { Icon, Spinner } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { SheetScreen } from '../../src/ui/screen';

/** Step ids are stable within a reply; a repeated one gets a suffix so keys stay unique. */
function stepKeys(steps: readonly ToolStep[]): string[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const n = (seen.get(step.id) ?? 0) + 1;
    seen.set(step.id, n);
    return n === 1 ? step.id : `${step.id}#${n}`;
  });
}

export default function StepsSheet() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const steps = useStepsSheet((s) => s.steps);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const keys = stepKeys(steps);
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <SheetScreen title={t('tools.title')} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {steps.length ? (
          steps.map((step, index) => (
            <Step key={keys[index]} step={step} open={open.has(keys[index]!)} onToggle={() => toggle(keys[index]!)} />
          ))
        ) : (
          <EmptyState icon="wrench" title={t('tools.noSteps')} style={styles.state} />
        )}
      </ScrollView>
    </>
  );
}

function Step({ step, open, onToggle }: { step: ToolStep; open: boolean; onToggle: () => void }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const name = toolName(step.tool, t);
  const summary = toolSummary(step, t);
  const failed = step.status === 'failed';
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={[name, summary].filter(Boolean).join(t('common.listSep'))}
        accessibilityState={{ expanded: open, busy: step.status === 'running' }}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.fill }]}
      >
        {step.status === 'running' ? (
          <Spinner size="small" />
        ) : (
          <Icon name={failed ? 'alertCircle' : 'checkCircle'} size={17} color={failed ? c.red : c.accent} />
        )}
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.summary, failed && { color: c.red }]} numberOfLines={1}>
          {summary ?? ''}
        </Text>
        <Icon name={open ? 'chevD' : 'chevR'} size={13} weight="semibold" color={c.tertiaryLabel} />
      </Pressable>
      {open ? <StepDetails step={step} /> : null}
    </View>
  );
}

/** An opened step: what was asked, what came back, and the raw value on demand. */
function StepDetails({ step }: { step: ToolStep }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [raw, setRaw] = useState(false);
  const args = toolArgs(step.input, t);
  const result = toolResult(step, t);
  const rawText = [rawValue(step.input), rawValue(step.output)].filter(Boolean);
  return (
    <View style={styles.details}>
      <Text style={styles.label}>{t('tools.asked')}</Text>
      {args.length ? (
        args.map((arg) => (
          <Text key={arg.label} style={styles.value} selectable>
            <Text style={styles.argLabel}>{arg.label}: </Text>
            {arg.value}
          </Text>
        ))
      ) : (
        <Text style={styles.quiet}>{t('tools.noArgs')}</Text>
      )}
      <Text style={styles.label}>{t('tools.returned')}</Text>
      <Text
        style={[styles.value, step.status === 'failed' && { color: c.red }]}
        selectable
        numberOfLines={raw ? undefined : 4}
      >
        {result}
      </Text>
      {rawText.length ? (
        <View style={styles.rawToggle}>
          <NativeButton
            label={raw ? t('tools.hideRaw') : t('tools.showRaw')}
            size="small"
            onPress={() => setRaw((v) => !v)}
          />
        </View>
      ) : null}
      {raw
        ? rawText.map((text, i) => (
            <Text key={i} style={styles.code} selectable>
              {text}
            </Text>
          ))
        : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1 },
  content: { padding: space.margin, gap: space.sm, paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...squircle,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  name: { ...typo.body, fontWeight: weight.semibold, color: c.label, flexShrink: 0, maxWidth: '55%' },
  summary: { ...typo.subheadline, color: c.secondaryLabel, flex: 1, minWidth: 0 },
  details: { paddingHorizontal: space.margin, paddingBottom: space.margin, gap: space.xs },
  label: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, marginTop: space.xs },
  argLabel: { color: c.secondaryLabel },
  value: { ...typo.subheadline, color: c.label },
  quiet: { ...typo.subheadline, color: c.tertiaryLabel },
  rawToggle: { alignItems: 'flex-start', marginTop: space.sm },
  code: {
    ...typo.caption1,
    fontFamily: mono,
    color: c.codeText,
    backgroundColor: c.codeBg,
    padding: space.md,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginTop: space.xs,
    ...squircle,
  },
}));
