/**
 * The one read-only renderer for a Tables value on the phone (record pages,
 * cards, lists; web parity: `components/tables/field-value.tsx`): select
 * options as data-coloured badges, people / related rows / files as neutral
 * badges, everything else as text (`valueText`, ./model/fields.ts). Empty →
 * "—". `RecordLines` is a record's summary under its title (field · value).
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { TableRecordValues } from '../shared/tables';
import { makeStyles, space, typo, useTheme } from '../theme';
import { useFontScaleKey } from '../ui/font-scale';
import { Badge } from '../ui/list';
import { tagHex } from '../lib/tag-colors';
import { useT } from '../lib/i18n';
import {
  effectiveType,
  selectOptions,
  isEmptyValue,
  recordValue,
  valueChips,
  valueText,
  type FieldLike,
  type ValueLabels,
} from './model/fields';

const MAX_CHIPS = 6;

interface FieldValueViewProps {
  field: FieldLike;
  value: unknown;
  labels: ValueLabels;
  numberOfLines?: number;
}

export function FieldValueView(props: FieldValueViewProps) {
  const t = useT();
  if (props.field.type !== 'ai') return <ValueView {...props} />;
  return (
    <View style={{ gap: space.xs, alignItems: 'flex-start' }}>
      <Badge label={t('tables.aiGenerated')} />
      <ValueView {...props} />
    </View>
  );
}

function ValueView({ field, value, labels, numberOfLines }: FieldValueViewProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (isEmptyValue(value)) return <Text style={styles.empty}>—</Text>;
  const chips = valueChips(field, value, labels);
  if (chips) {
    const type = effectiveType(field);
    const options = selectOptions(field);
    const ids = Array.isArray(value) ? value : [value];
    const shown = chips.slice(0, MAX_CHIPS);
    return (
      <View style={styles.chips}>
        {shown.map((label, index) => {
          const color =
            type === 'single_select' || type === 'multi_select'
              ? options.find((option) => option.id === ids[index])?.color
              : undefined;
          // option colours are free data (often unset): only a real hex colours the badge
          const hex = color && /^#[0-9a-f]{3,8}$/i.test(color) ? tagHex(color) : undefined;
          return <Badge key={`${index}:${label}`} label={label} {...(hex ? { color: hex } : {})} />;
        })}
        {chips.length > shown.length ? <Badge label={`+${chips.length - shown.length}`} /> : null}
      </View>
    );
  }
  return (
    <Text selectable numberOfLines={numberOfLines} style={styles.text}>
      {valueText(field, value, labels)}
    </Text>
  );
}

/** A record's summary lines: up to `max` non-empty fields as "Name  value" (cards, list rows). */
export function RecordLines({
  record,
  fields,
  labels,
  max = 3,
}: {
  record: { values: TableRecordValues; computed_values?: TableRecordValues };
  fields: readonly FieldLike[];
  labels: ValueLabels;
  max?: number;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const lines = fields
    .map((field) => ({ field, text: valueText(field, recordValue(record, field.id), labels) }))
    .filter((line) => line.text)
    .slice(0, max);
  if (!lines.length) return null;
  return (
    <View key={fontKey} style={styles.lines}>
      {lines.map(({ field, text }) => (
        <Text key={field.id} numberOfLines={1} style={styles.line}>
          <Text style={styles.lineName}>{field.name} </Text>
          {text}
        </Text>
      ))}
    </View>
  );
}

/** A record's summary as one string (list subtitles, VoiceOver). */
export function recordSummary(
  record: { values: TableRecordValues; computed_values?: TableRecordValues },
  fields: readonly FieldLike[],
  labels: ValueLabels,
  max = 2,
): string {
  return fields
    .map((field) => valueText(field, recordValue(record, field.id), labels))
    .filter(Boolean)
    .slice(0, max)
    .join(' · ');
}

const useStyles = makeStyles((c) => ({
  empty: { ...typo.body, color: c.tertiaryLabel },
  text: { ...typo.body, color: c.label },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  lines: { gap: 2 },
  line: { ...typo.footnote, color: c.label },
  lineName: { color: c.secondaryLabel },
}));
