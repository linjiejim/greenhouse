/**
 * A record's fields, read-only, grouped (the record page and the record peek;
 * web parity: the record drawer's 字段 tab): the title (primary field) on top,
 * then the stored fields as name-over-value rows, the calculated ones
 * (formula / rollup / lookup) in their own card, and who created / last changed
 * it. Attachments are chips that download the file into the share sheet (the
 * content route checks it is readable for me). `useRecord` loads one record and
 * refetches it on focus and after any write on its table.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getRecord, tablesFilePath, type TableField, type TableRecord } from '../api/tables';
import { relativeTime } from '../lib/format';
import { downloadAndShare } from '../lib/share-file';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { alertError } from '../ui/dialogs';
import { FieldValueView } from './field-value';
import {
  attachmentIds,
  isComputed,
  primaryField,
  recordTitle,
  recordValue,
  type FieldLike,
  type ValueLabels,
} from './model/fields';
import { useTables } from './store';

/** One record: loads on mount, on focus, and after a write on its table. `gone` = 403 / 404. */
export function useRecord(tableId: number, recordId: number) {
  const [record, setRecord] = useState<TableRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'failed'>('loading');
  const version = useTables((s) => s.recordsVersion[tableId] ?? 0);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const result = await getRecord(tableId, recordId);
    if (mine !== seq.current) return;
    if (result.ok) {
      setRecord(result.value);
      setState('ok');
    } else if (result.definitive) {
      setRecord(null);
      setState('gone');
    } else {
      setState((prev) => (prev === 'ok' ? 'ok' : 'failed'));
    }
  }, [tableId, recordId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) void load();
      focused.current = true;
    }, [load]),
  );
  return { record, state, reload: load };
}

export function RecordHeader({
  record,
  fields,
  labels,
  subtitle,
}: {
  record: { id: number; values: Record<string, unknown>; computed_values?: Record<string, unknown> };
  fields: readonly FieldLike[];
  labels: ValueLabels;
  subtitle?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.head}>
      <Text selectable accessibilityRole="header" style={styles.title}>
        {recordTitle(record, fields, labels)}
      </Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

/** Name-over-value rows in an inset card. */
export function FieldsCard({
  title,
  fields,
  record,
  labels,
  filePath,
}: {
  title: string;
  fields: readonly FieldLike[];
  record: { values: Record<string, unknown>; computed_values?: Record<string, unknown> };
  labels: ValueLabels;
  /** Where an attachment downloads from (Tables: the Drive route; apps: the gateway). */
  filePath: (field: FieldLike, fileId: number) => string;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  if (!fields.length) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeader} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.card}>
        {fields.map((field, index) => {
          const value = recordValue(record, field.id);
          return (
            <View key={`${field.id}:${fontKey}`} style={[styles.row, index < fields.length - 1 && styles.rowSep]}>
              <Text style={styles.name}>{field.name}</Text>
              {field.type === 'attachment' && attachmentIds(value).length ? (
                <View style={styles.files}>
                  {attachmentIds(value).map((fileId) => {
                    const name = labels.file?.(String(fileId)) ?? `#${fileId}`;
                    return (
                      <Pressable
                        key={fileId}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('tables.openAttachment')} ${name}`}
                        onPress={async () => {
                          if (!(await downloadAndShare(filePath(field, fileId), name))) {
                            alertError(t('tables.attachmentFailed'));
                          }
                        }}
                        style={({ pressed }) => [styles.file, pressed && { opacity: 0.6 }]}
                      >
                        <Icon name="attach" size={13} color={c.accentText} />
                        <Text numberOfLines={1} style={styles.fileText}>
                          {name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <FieldValueView field={field} value={value} labels={labels} />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** A Tables record's grouped fields: stored, calculated, and who made / changed it. */
export function RecordDetails({
  record,
  fields,
  labels,
}: {
  record: TableRecord;
  fields: readonly TableField[];
  labels: ValueLabels;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const primary = primaryField(fields);
  const stored = fields.filter((field) => !isComputed(field) && field.id !== primary?.id);
  const computed = fields.filter((field) => isComputed(field));
  const creator = labels.user(record.created_by) ?? t('tables.someone');
  return (
    <>
      <FieldsCard
        title={t('tables.details')}
        fields={stored}
        record={record}
        labels={labels}
        filePath={(_field, fileId) => tablesFilePath(fileId)}
      />
      <FieldsCard
        title={t('tables.calculated')}
        fields={computed}
        record={record}
        labels={labels}
        filePath={(_field, fileId) => tablesFilePath(fileId)}
      />
      <Text style={styles.meta}>
        {t('tables.system.created_by')} {creator} · {relativeTime(record.created_at)}
        {record.updated_at !== record.created_at
          ? `\n${t('tables.system.updated_at')} ${relativeTime(record.updated_at)}`
          : ''}
      </Text>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  head: { paddingHorizontal: space.margin + space.xs, paddingTop: space.sm, paddingBottom: space.xl, gap: space.xs },
  title: { ...typo.title1, color: c.label },
  subtitle: { ...typo.subheadline, color: c.secondaryLabel },
  section: { marginHorizontal: space.margin, marginBottom: space.xxl },
  sectionHeader: {
    ...typo.footnote,
    color: c.secondaryLabel,
    textTransform: 'uppercase',
    paddingHorizontal: space.margin,
    paddingBottom: space.sm - 2,
  },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
    paddingHorizontal: space.margin,
    overflow: 'hidden',
  },
  row: { paddingVertical: space.md - 2, gap: 4 },
  rowSep: { borderBottomWidth: 0.5, borderBottomColor: c.separator },
  name: { ...typo.footnote, color: c.secondaryLabel, fontWeight: weight.medium },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 240,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: c.accentFill,
    ...squircle,
  },
  fileText: { ...typo.footnote, color: c.accentText, flexShrink: 1 },
  meta: { ...typo.footnote, color: c.tertiaryLabel, paddingHorizontal: space.margin * 2, marginBottom: space.xxl },
}));
