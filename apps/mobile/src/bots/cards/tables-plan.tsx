/**
 * A Bot's proposed Tables change, in the card's sheet (`tables_plan` request —
 * the web's components/bots/tables-plan-card.tsx): the Bot's summary, then who
 * gains or loses access and what gets published (on an orange wash, read first),
 * then every operation as the server worded it. After Apply each line carries
 * how it came out (✓ / ✕ / –) and why a line did not apply. The payload is
 * self-contained: the phone never parses the plan's operations.
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { BotRequestView, BotTablesPlanPayload, BotTablesPlanResult } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { CardNote } from './card-frame';
import { tablesPlanLines } from './decision';

export function TablesPlanBody({ request }: { request: BotRequestView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const payload = request.payload as Partial<BotTablesPlanPayload>;
  const result = request.status === 'resolved' ? (request.result as BotTablesPlanResult | null) : null;
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  const access = Array.isArray(payload.access) ? payload.access : [];
  const lines = tablesPlanLines(payload, result);
  return (
    <>
      {summary ? (
        <Text style={styles.summary} selectable>
          {summary}
        </Text>
      ) : null}
      {access.length > 0 ? (
        <View style={styles.access}>
          <View style={styles.accessHead}>
            <Icon name="shieldAlert" size={13} color={c.orange} />
            <Text style={styles.accessTitle}>{t('bots.card.tablesAccess')}</Text>
          </View>
          {access.map((change, index) => (
            <Text
              key={`${index}:${change.subject}`}
              style={styles.accessLine}
              selectable
              accessibilityLabel={`${change.subject}: ${change.before} → ${change.after}`}
            >
              <Text style={styles.strong}>{change.subject}</Text>
              {`: ${change.before} → `}
              <Text style={styles.strong}>{change.after}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.lines}>
        {lines.map((line, index) => (
          <View key={`${index}:${line.op}`} style={styles.line} accessible accessibilityLabel={`${line.label} ${line.target}`}>
            <Icon
              name={line.status === 'applied' ? 'check' : line.status === 'failed' ? 'x' : 'circle'}
              size={line.status === null || line.status === 'skipped' ? 7 : 12}
              color={line.status === 'applied' ? c.green : line.status === 'failed' ? c.red : c.tertiaryLabel}
              style={styles.mark}
            />
            <View style={styles.lineBody}>
              <Text style={styles.lineText} selectable>
                <Text style={styles.label}>{line.label}</Text> {line.target}
              </Text>
              {line.message ? (
                <Text style={[styles.message, line.status !== 'applied' && { color: c.red }]}>{line.message}</Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
      {result?.error ? <CardNote text={result.error} tone={c.red} /> : null}
      {request.status === 'pending' ? <CardNote text={t('bots.card.tablesHint')} /> : null}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  summary: { ...typo.title3, fontWeight: weight.semibold, color: c.label },
  access: {
    borderRadius: radius.md,
    backgroundColor: c.orangeFill,
    padding: space.sm,
    gap: space.xs,
    ...squircle,
  },
  accessHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  accessTitle: { ...typo.footnote, fontWeight: weight.semibold, color: c.orange },
  accessLine: { ...typo.footnote, color: c.secondaryLabel },
  strong: { fontWeight: weight.semibold, color: c.label },
  lines: { gap: space.xs },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  mark: { marginTop: 4, width: 12 },
  lineBody: { flex: 1, gap: 1 },
  lineText: { ...typo.subheadline, color: c.label },
  label: { color: c.secondaryLabel },
  message: { ...typo.footnote, color: c.secondaryLabel },
}));
