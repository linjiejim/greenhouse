/**
 * ```steps fenced block — a plan, a progress report or a dated history as a
 * vertical timeline (web parity: @greenhouse/ui StepsBlock). Five states:
 * done / active / pending / blocked / skipped; the ones worth a word (active,
 * blocked, skipped) also get a badge, and VoiceOver hears every state.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StepItem, StepStatus, StepsData } from '../../../shared/rich-output';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon, type IconName } from '../../../ui/core';
import { Badge, type BadgeTone } from '../../../ui/list';
import { richSegment } from '../rich';
import { BlockActions } from './block-actions';
import { CodeBlock } from './code';

const STATUS_KEY: Record<StepStatus, TranslationKey> = {
  done: 'chat.stepDone',
  active: 'chat.stepActive',
  pending: 'chat.stepPending',
  blocked: 'chat.stepBlocked',
  skipped: 'chat.stepSkipped',
};

const MARKER: Record<StepStatus, IconName> = {
  done: 'checkCircleFill',
  active: 'statusProgress',
  pending: 'circle',
  blocked: 'alert',
  skipped: 'statusCancelled',
};

const LABELLED: Partial<Record<StepStatus, BadgeTone>> = { active: 'accent', blocked: 'orange', skipped: 'neutral' };

export function StepsBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('steps', raw), [raw]);
  if (seg?.type !== 'steps') return <CodeBlock lang="steps" code={raw} />;
  return <Steps data={seg.data} />;
}

function Steps({ data }: { data: StepsData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.card}>
      {data.title ? <Text style={styles.title}>{data.title}</Text> : null}
      <View>
        {data.items.map((item, i) => (
          <Step key={i} item={item} last={i === data.items.length - 1} />
        ))}
      </View>
      {data.actions?.length ? <BlockActions actions={data.actions} /> : null}
    </View>
  );
}

function Step({ item, last }: { item: StepItem; last: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const status = t(STATUS_KEY[item.status]);
  const color =
    item.status === 'done' || item.status === 'active'
      ? c.accent
      : item.status === 'blocked'
        ? c.orange
        : c.tertiaryLabel;
  const badge = LABELLED[item.status];
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={[item.title, status, item.time, item.detail].filter(Boolean).join(', ')}
    >
      <View style={styles.rail}>
        <Icon name={MARKER[item.status]} size={17} color={color} />
        {!last ? <View style={styles.line} /> : null}
      </View>
      <View style={[styles.body, last ? null : styles.bodyGap]}>
        <View style={styles.head}>
          <Text
            style={[
              styles.stepTitle,
              item.status === 'active' && styles.stepActive,
              item.status === 'skipped' && styles.stepSkipped,
            ]}
          >
            {item.title}
          </Text>
          {badge ? <Badge label={status} tone={badge} /> : null}
          {item.time ? <Text style={styles.time}>{item.time}</Text> : null}
        </View>
        {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginVertical: space.sm + 2,
    padding: space.md,
    gap: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  row: { flexDirection: 'row', gap: space.sm + 2 },
  rail: { alignItems: 'center', width: 18 },
  line: { flex: 1, width: StyleSheet.hairlineWidth * 2, backgroundColor: c.separator, marginTop: space.xxs },
  body: { flex: 1, gap: space.xxs },
  bodyGap: { paddingBottom: space.md },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  stepTitle: { ...typo.callout, color: c.label, flexShrink: 1 },
  stepActive: { fontWeight: weight.semibold },
  stepSkipped: { color: c.tertiaryLabel, textDecorationLine: 'line-through' },
  time: { ...typo.caption1, color: c.tertiaryLabel, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  detail: { ...typo.footnote, color: c.secondaryLabel },
}));
