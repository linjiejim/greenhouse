/**
 * The steps a reply took (`/sheet/steps`), opened from the status beside "Sprouty": each tool
 * call in people's words — what was asked (its arguments as label and value) and what came back
 * (one line), with the raw value behind a toggle. A step of the reply being written updates in
 * place (src/chat/steps-sheet.ts).
 */

import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { rawValue, toolArgs, toolName, toolResult } from '../../src/chat/tool-words';
import { useStepsSheet } from '../../src/chat/steps-sheet';
import type { ToolStep } from '../../src/chat/parts';
import { useT } from '../../src/lib/i18n';
import { makeStyles, mono, radius, space, squircle, typo, useTheme, weight } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { Icon, Spinner } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { SheetScreen } from '../../src/ui/screen';

export default function StepsSheet() {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const steps = useStepsSheet((s) => s.steps);
  return (
    <>
      <SheetScreen title={t('tools.title')} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {steps.length ? (
          steps.map((step, index) => <Step key={`${step.id}-${index}`} step={step} index={index} />)
        ) : (
          <EmptyState icon="wrench" title={t('tools.noSteps')} style={styles.state} />
        )}
      </ScrollView>
    </>
  );
}

function Step({ step, index }: { step: ToolStep; index: number }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [raw, setRaw] = useState(false);
  const args = toolArgs(step.input, t);
  const result = toolResult(step, t);
  const rawText = [rawValue(step.input), rawValue(step.output)].filter(Boolean);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        {step.status === 'running' ? (
          <Spinner size="small" />
        ) : (
          <Icon
            name={step.status === 'failed' ? 'alertCircle' : 'checkCircle'}
            size={17}
            color={step.status === 'failed' ? c.red : c.accent}
          />
        )}
        <Text style={styles.name} numberOfLines={1}>
          {index + 1}. {toolName(step.tool, t)}
        </Text>
      </View>
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
  content: { padding: space.margin, gap: space.md, paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    padding: space.margin,
    gap: space.xs,
    ...squircle,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs },
  name: { ...typo.headline, color: c.label, flexShrink: 1 },
  label: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, marginTop: space.sm },
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
